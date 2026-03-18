import * as path from 'node:path'
import { readdir, readFile } from 'node:fs/promises'
import Papa from 'papaparse'
import type { IdentityEvent } from '../../types/identity.types.js'
import { importGmailEventsFromJson, importGmailEventsFromMbox } from './gmail.js'
import { analyzePerContactVoice, type PerContactVoiceProfile } from '../../analysis/voiceAnalyzer.js'

type JsonObj = Record<string, unknown>

async function listFilesRecursive(dir: string): Promise<string[]> {
  const out: string[] = []
  const stack = [dir]
  while (stack.length > 0) {
    const current = stack.pop()!
    let entries
    try {
      entries = await readdir(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      const full = path.join(current, String(e.name))
      if (e.isDirectory()) stack.push(full)
      else out.push(full)
    }
  }
  return out
}

async function readJsonMaybe(filePath: string): Promise<unknown | null> {
  try {
    const raw = await readFile(filePath, 'utf8')
    return JSON.parse(raw)
  } catch {
    return null
  }
}

async function readCsvRows(filePath: string): Promise<Array<Record<string, string>>> {
  try {
    const raw = await readFile(filePath, 'utf8')
    const parsed = Papa.parse<Record<string, string>>(raw, { header: true, skipEmptyLines: true })
    return parsed.data ?? []
  } catch {
    return []
  }
}

function toIso(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    // Handle different timestamp formats:
    // - Seconds (< 1e10): multiply by 1000
    // - Milliseconds (1e10 to 1e13): use as-is
    // - Microseconds (> 1e13, typically ~1.7e15 for Chrome): divide by 1000
    let ms: number
    if (value > 1e15) {
      // Microseconds (Chrome time_usec) - divide to get ms
      ms = value / 1000
    } else if (value > 10_000_000_000) {
      // Already milliseconds
      ms = value
    } else {
      // Seconds - multiply to get ms
      ms = value * 1000
    }
    const d = new Date(ms)
    return Number.isFinite(d.getTime()) ? d.toISOString() : null
  }
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) return null
    if (/^\d+$/.test(trimmed)) {
      const n = Number(trimmed)
      return toIso(n)
    }
    const d = new Date(trimmed)
    return Number.isFinite(d.getTime()) ? d.toISOString() : null
  }
  return null
}

function textFromKeys(obj: JsonObj, keys: string[]) {
  for (const k of keys) {
    const val = obj[k]
    if (typeof val === 'string' && val.trim()) return val.trim()
  }
  return ''
}

function decodeHtmlEntities(input: string): string {
  return input
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
}

function stripHtml(input: string): string {
  return decodeHtmlEntities(
    input
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim(),
  )
}

function parseTakeoutActivityHtml(rawHtml: string, source: IdentityEvent['source'], channel: string): IdentityEvent[] {
  const events: IdentityEvent[] = []
  const blockRe = /<div[^>]*class="[^"]*content-cell[^"]*"[^>]*>([\s\S]*?)<\/div>/gi
  const blocks = Array.from(rawHtml.matchAll(blockRe))

  const fromBlock = (block: string) => {
    const text = stripHtml(block)
    if (!text) return null
    const dateMatch = text.match(
      /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2},\s+\d{4}(?:,\s+\d{1,2}:\d{2}:\d{2}\s*(?:AM|PM)?(?:\s*UTC)?)?/i,
    )
    const createdAt = dateMatch ? toIso(dateMatch[0]) : null
    const hrefMatch = block.match(/href="([^"]+)"/i)
    const url = hrefMatch ? decodeHtmlEntities(hrefMatch[1]) : null

    return {
      source,
      kind: 'message' as const,
      text: [text, url ?? ''].filter(Boolean).join('\n'),
      createdAt,
      channel,
      externalId: null,
      metadata: url ? { url } : {},
    }
  }

  if (blocks.length > 0) {
    for (const m of blocks) {
      const parsed = fromBlock(m[1])
      if (parsed) pushEvent(events, parsed)
    }
    return events
  }

  // Fallback for non-standard Takeout HTML shape.
  const lineish = stripHtml(rawHtml)
    .split(/\n{2,}|(?<=\.)\s{2,}/)
    .map((s) => s.trim())
    .filter((s) => s.length > 40)
    .slice(0, 2000)
  for (const chunk of lineish) {
    const dateMatch = chunk.match(
      /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2},\s+\d{4}(?:,\s+\d{1,2}:\d{2}:\d{2}\s*(?:AM|PM)?(?:\s*UTC)?)?/i,
    )
    pushEvent(events, {
      source,
      kind: 'message',
      text: chunk,
      createdAt: dateMatch ? toIso(dateMatch[0]) : null,
      channel,
      externalId: null,
      metadata: {},
    })
  }
  return events
}

function pushEvent(events: IdentityEvent[], e: IdentityEvent) {
  if (!e.text || !e.text.trim()) return
  events.push({ ...e, text: e.text.slice(0, 6000) })
}

function flattenObjects(value: unknown): JsonObj[] {
  const out: JsonObj[] = []
  const stack: unknown[] = [value]
  while (stack.length > 0) {
    const cur = stack.pop()
    if (!cur) continue
    if (Array.isArray(cur)) {
      for (const item of cur) stack.push(item)
      continue
    }
    if (typeof cur === 'object') {
      const obj = cur as JsonObj
      out.push(obj)
      for (const v of Object.values(obj)) {
        if (Array.isArray(v) || (v && typeof v === 'object')) stack.push(v)
      }
    }
  }
  return out
}

function parseChromeBookmarks(parsed: unknown): IdentityEvent[] {
  const events: IdentityEvent[] = []
  const root = parsed as { roots?: Record<string, unknown> }
  const walk = (node: unknown) => {
    if (!node || typeof node !== 'object') return
    const obj = node as JsonObj
    const url = typeof obj.url === 'string' ? obj.url : null
    const name = typeof obj.name === 'string' ? obj.name : null
    if (url || name) {
      const createdAt = toIso(obj.date_added)
      pushEvent(events, {
        source: 'chrome',
        kind: 'post',
        text: [name ? `Bookmark: ${name}` : '', url ?? ''].filter(Boolean).join('\n'),
        createdAt,
        channel: 'chrome_bookmarks',
        externalId: typeof obj.id === 'string' ? obj.id : null,
        metadata: { url },
      })
    }
    const children = obj.children
    if (Array.isArray(children)) {
      for (const c of children) walk(c)
    }
  }
  for (const v of Object.values(root.roots ?? {})) walk(v)
  return events
}

function parseChromeHistoryJson(parsed: unknown): IdentityEvent[] {
  const events: IdentityEvent[] = []
  const objs = flattenObjects(parsed)
  for (const obj of objs) {
    const url = textFromKeys(obj, ['url', 'titleUrl'])
    const title = textFromKeys(obj, ['title', 'pageTitle', 'name'])
    const hasHistorySignal = Boolean(url) || /history|visit/i.test(Object.keys(obj).join(' '))
    if (!hasHistorySignal) continue
    const createdAt =
      toIso(obj.time_usec) ??
      toIso(obj.last_visit_time) ??
      toIso(obj.visit_time) ??
      toIso(obj.time) ??
      null
    const text = [title ? `Visited: ${title}` : 'Visited page', url].filter(Boolean).join('\n')
    pushEvent(events, {
      source: 'chrome',
      kind: 'message',
      text,
      createdAt,
      channel: 'chrome_history',
      externalId: textFromKeys(obj, ['id', 'visit_id']) || null,
      metadata: obj,
    })
  }
  return events
}

function parseDiscoverJson(parsed: unknown): IdentityEvent[] {
  const events: IdentityEvent[] = []
  const objs = flattenObjects(parsed)
  for (const obj of objs) {
    const title = textFromKeys(obj, ['title', 'name'])
    const titleUrl = textFromKeys(obj, ['titleUrl', 'url'])
    const product = textFromKeys(obj, ['product'])
    const isDiscover = /discover/i.test(`${title} ${titleUrl} ${product} ${JSON.stringify(obj).slice(0, 300)}`)
    if (!isDiscover) continue
    const createdAt = toIso(obj.time) ?? toIso(obj.date) ?? null
    const text = [title, titleUrl].filter(Boolean).join('\n')
    pushEvent(events, {
      source: 'discover',
      kind: 'message',
      text,
      createdAt,
      channel: 'google_discover',
      externalId: textFromKeys(obj, ['id']) || null,
      metadata: obj,
    })
  }
  return events
}

// Spam/automated message detection patterns
const SPAM_PATTERNS = [
  /\bcode:\s*\d+/i, // "code: 123456"
  /\bOTP\b/i,
  /\bverification\s*code\b/i,
  /\byour\s*code\s*is\b/i,
  /\bsecurity\s*code\b/i,
  /\bverify\s*your\b/i,
  /\border\s*#\b/i,
  /\byour\s*order\b/i,
  /\bshipped\b/i,
  /\bdelivered\b/i,
  /\btracking\s*#\b/i,
  /\bpackage\s*arriving\b/i,
  /\bappointment\s*reminder\b/i,
  /\bbalance\s*is\b/i,
  /\btransaction\s*alert\b/i,
  /\bfraud\s*alert\b/i,
]

const SHORT_CODE_REGEX = /^\+?1?(\d{5,6})$/ // 5-6 digit short codes

function isLikelySpamMessage(text: string, senderName: string, phoneFromHref: string | null, messageCount: number): boolean {
  // Empty sender name = likely spam
  if (!senderName || senderName.trim() === '') return true

  // Short code phone numbers
  if (phoneFromHref) {
    const digits = phoneFromHref.replace(/\D/g, '')
    if (SHORT_CODE_REGEX.test(digits)) return true
  }

  // Single message thread with no sender name context
  if (messageCount === 1 && senderName === 'Unknown') return true

  // Content patterns
  const lowerText = text.toLowerCase()
  for (const pattern of SPAM_PATTERNS) {
    if (pattern.test(lowerText)) return true
  }

  // Very short numeric-only messages (verification codes)
  if (text.length < 20 && /^\d+$/.test(text.trim())) return true

  return false
}

// Business/organization name patterns for bulk filtering
const BUSINESS_PATTERNS = [
  /\b(pharmacy|medical|clinic|hospital|health|wellness)\b/i,
  /\b(bank|pnc|chase|wells|credit|union|loan)\b/i,
  /\b(amazon|walmart|target|costco|best buy)\b/i,
  /\b(uber|lyft|taxi|transit|delivery)\b/i,
  /\b(postal|usps|fedex|ups|dhl)\b/i,
  /\b(google|apple|microsoft|facebook|instagram)\b/i,
  /\b(netflix|spotify|hulu|amazon prime)\b/i,
  /\b(restaurant|food|delivery|doordash|grubhub)\b/i,
  /\b(case manager|social security|unemployment|benefits)\b/i,
  /\b(utility|con edison|national grid|verizon|att)\b/i,
]

// Known business contact names to exclude
const BUSINESS_CONTACTS = new Set([
  'Pharmacy Specs',
  'Pnc',
  'Snap Balance',
  'Wellness Transit LLC',
  'Sunset Medical Real',
  'Queens Ledger',
  'Sabiyha Case Manager',
  'Unemployment filing#',
  'Party Full',
  'Plow Guy Mark Ct',
  'Sunset Terrace Family Health Center at NYU Langone',
])

function isLikelyBusinessContact(contactName: string): boolean {
  if (!contactName) return false
  
  // Check against known business contacts
  if (BUSINESS_CONTACTS.has(contactName)) return true
  
  // Check for business patterns
  const lowerName = contactName.toLowerCase()
  for (const pattern of BUSINESS_PATTERNS) {
    if (pattern.test(lowerName)) return true
  }
  
  // All-caps names are often businesses
  if (contactName === contactName.toUpperCase() && contactName.length > 3) return true
  
  // Contains business keywords
  if (/\b(llc|inc|corp|company|service|center|office)\b/i.test(contactName)) return true
  
  return false
}

function isConversationThread(messages: ParsedSmsMessage[]): boolean {
  if (messages.length < 3) return false // Need at least 3 messages
  
  const userMessages = messages.filter(m => m.isUserMessage)
  const contactMessages = messages.filter(m => !m.isUserMessage)
  
  // Need back-and-forth (at least 2 from each)
  return userMessages.length >= 2 && contactMessages.length >= 2
}

interface ParsedSmsMessage {
  timestamp: string | null
  senderName: string
  senderPhone: string | null
  text: string
  isUserMessage: boolean
}

function parseGoogleVoiceSmsHtml(rawHtml: string): { messages: ParsedSmsMessage[]; contactName: string | null } {
  const messages: ParsedSmsMessage[] = []
  let contactName: string | null = null

  // Extract contact name from <title>
  const titleMatch = rawHtml.match(/<title>([^<]*)<\/title>/i)
  if (titleMatch && titleMatch[1].trim()) {
    contactName = decodeHtmlEntities(titleMatch[1].trim())
  }

  // Parse each message div
  const messageRe = /<div[^>]*class="message"[^>]*>([\s\S]*?)<\/div>\s*(?=<div|<\/div>|$)/gi
  const messageBlocks = Array.from(rawHtml.matchAll(messageRe))

  for (const block of messageBlocks) {
    const blockHtml = block[1]

    // Extract timestamp from <abbr class="dt" title="...">
    const timestampMatch = blockHtml.match(/<abbr[^>]*class="dt"[^>]*title="([^"]+)"/i)
    const timestamp = timestampMatch ? timestampMatch[1] : null

    // Extract sender name and phone
    const senderMatch = blockHtml.match(/<cite[^>]*class="sender[^"]*"[^>]*>([\s\S]*?)<\/cite>/i)
    let senderName = 'Unknown'
    let senderPhone: string | null = null
    let isUserMessage = false

    if (senderMatch) {
      const senderHtml = senderMatch[1]

      // Check for "Me" sender (user's own message)
      if (/<abbr[^>]*class="fn"[^>]*>\s*Me\s*<\/abbr>/i.test(senderHtml)) {
        senderName = 'Me'
        isUserMessage = true
      } else {
        // Extract name from <span class="fn">
        const fnMatch = senderHtml.match(/<span[^>]*class="fn"[^>]*>([^<]*)<\/span>/i)
        if (fnMatch && fnMatch[1].trim()) {
          senderName = decodeHtmlEntities(fnMatch[1].trim())
        }
      }

      // Extract phone from href="tel:..."
      const phoneMatch = senderHtml.match(/href="tel:([^"]+)"/i)
      if (phoneMatch) {
        senderPhone = phoneMatch[1]
      }
    }

    // Extract message text from <q>...</q>
    const textMatch = blockHtml.match(/<q>([\s\S]*?)<\/q>/i)
    const text = textMatch ? decodeHtmlEntities(textMatch[1].replace(/<br\s*\/?>/gi, '\n')).trim() : ''

    if (text) {
      messages.push({
        timestamp,
        senderName,
        senderPhone,
        text,
        isUserMessage,
      })
    }
  }

  return { messages, contactName }
}

function parseGoogleVoiceJson(parsed: unknown): IdentityEvent[] {
  const events: IdentityEvent[] = []
  const objs = flattenObjects(parsed)
  for (const obj of objs) {
    const text = textFromKeys(obj, ['messageText', 'transcript', 'voicemailText', 'text', 'content', 'body'])
    const from = textFromKeys(obj, ['from', 'fromNumber', 'sender'])
    const to = textFromKeys(obj, ['to', 'toNumber', 'recipient'])
    const hasVoiceSignal = /voice|voicemail|call|sms|mms/i.test(Object.keys(obj).join(' '))
    // Skip CSS/style garbage - detect by CSS-like content
    if (text && (/\{\s*[^}]*:\s*[^;]*;/.test(text) || /Copyright.*Google.*Reserved/i.test(text))) continue
    if (!text && !hasVoiceSignal) continue
    const createdAt = toIso(obj.time) ?? toIso(obj.timestamp) ?? toIso(obj.date) ?? null
    pushEvent(events, {
      source: 'google_voice',
      kind: 'message',
      text: text || [from, to].filter(Boolean).join(' -> ') || 'Google Voice activity',
      createdAt,
      participants: [from, to].filter(Boolean),
      channel: 'google_voice',
      externalId: textFromKeys(obj, ['id', 'conversationId']) || null,
      metadata: obj,
    })
  }
  return events
}

function parseYouTubeJson(parsed: unknown): IdentityEvent[] {
  const events: IdentityEvent[] = []
  const objs = flattenObjects(parsed)
  for (const obj of objs) {
    const title = textFromKeys(obj, ['title', 'name'])
    const titleUrl = textFromKeys(obj, ['titleUrl', 'url'])
    const details = Array.isArray(obj.details)
      ? (obj.details as Array<Record<string, unknown>>)
          .map((d) => (typeof d.name === 'string' ? d.name : typeof d.title === 'string' ? d.title : ''))
          .filter(Boolean)
          .join(', ')
      : ''
    const product = textFromKeys(obj, ['products', 'product'])
    const blob = `${title} ${titleUrl} ${details} ${product}`
    const isYouTube = /youtube|yt music|youtube music/i.test(blob)
    if (!isYouTube) continue
    const createdAt = toIso(obj.time) ?? toIso(obj.timestamp) ?? toIso(obj.date) ?? null
    const text = [title, details ? `Details: ${details}` : '', titleUrl].filter(Boolean).join('\n')
    pushEvent(events, {
      source: 'youtube',
      kind: 'message',
      text,
      createdAt,
      channel: /music/i.test(blob) ? 'youtube_music' : 'youtube',
      externalId: textFromKeys(obj, ['id']) || null,
      metadata: obj,
    })
  }
  return events
}

function parseRowsToEvents(rows: Array<Record<string, string>>, source: IdentityEvent['source'], channelDefault: string): IdentityEvent[] {
  const events: IdentityEvent[] = []
  for (const row of rows) {
    const text = row.text || row.message || row.body || row.content || row.caption || row.title || ''
    if (!text.trim()) continue
    const createdAt = toIso(row.created_at || row.createdAt || row.timestamp || row.date || row.time)
    const from = row.author || row.user || row.from || row.sender || ''
    const to = row.to || row.recipient || row.target || ''
    pushEvent(events, {
      source,
      kind: 'message',
      text,
      createdAt,
      participants: [from, to].filter(Boolean),
      channel: row.platform || row.channel || channelDefault,
      externalId: row.id || row.message_id || row.post_id || null,
      metadata: row,
    })
  }
  return events
}

export async function importChromeTakeoutFromFolder(folderPath: string): Promise<IdentityEvent[]> {
  const files = await listFilesRecursive(folderPath)
  const events: IdentityEvent[] = []
  for (const file of files) {
    const lower = file.toLowerCase()
    if (lower.endsWith('.json') && lower.includes('bookmark')) {
      const parsed = await readJsonMaybe(file)
      if (parsed) events.push(...parseChromeBookmarks(parsed))
      continue
    }
    if (lower.endsWith('.json') && lower.includes('history')) {
      const parsed = await readJsonMaybe(file)
      if (parsed) events.push(...parseChromeHistoryJson(parsed))
      continue
    }
    if (lower.endsWith('.csv') && lower.includes('history')) {
      const rows = await readCsvRows(file)
      events.push(...parseRowsToEvents(rows, 'chrome', 'chrome_history'))
    }
  }
  return events
}

export async function importDiscoverTakeoutFromFolder(folderPath: string): Promise<IdentityEvent[]> {
  const files = await listFilesRecursive(folderPath)
  const events: IdentityEvent[] = []
  for (const file of files) {
    const lower = file.toLowerCase()
    if (lower.endsWith('.json') && lower.includes('discover')) {
      const parsed = await readJsonMaybe(file)
      if (parsed) events.push(...parseDiscoverJson(parsed))
      continue
    }
    if (lower.endsWith('.csv') && lower.includes('discover')) {
      const rows = await readCsvRows(file)
      events.push(...parseRowsToEvents(rows, 'discover', 'google_discover'))
      continue
    }
    if (lower.endsWith('.html') && lower.includes('discover')) {
      try {
        const raw = await readFile(file, 'utf8')
        events.push(...parseTakeoutActivityHtml(raw, 'discover', 'google_discover'))
      } catch {
        // ignore
      }
    }
  }
  return events
}

export async function importGoogleVoiceTakeoutFromFolder(folderPath: string): Promise<{
  events: IdentityEvent[]
  contactProfiles: PerContactVoiceProfile[]
}> {
  const files = await listFilesRecursive(folderPath)
  const events: IdentityEvent[] = []
  const contactMessagesMap = new Map<string, Array<{ text: string; isUserMessage: boolean; timestamp: string | null; senderName: string }>>()
  
  for (const file of files) {
    const lower = file.toLowerCase()
    if (lower.endsWith('.json') && (lower.includes('google voice') || lower.includes('voice'))) {
      const parsed = await readJsonMaybe(file)
      if (parsed) events.push(...parseGoogleVoiceJson(parsed))
      continue
    }
    if (lower.endsWith('.csv') && lower.includes('voice')) {
      const rows = await readCsvRows(file)
      events.push(...parseRowsToEvents(rows, 'google_voice', 'google_voice'))
      continue
    }
    if (lower.endsWith('.html') && (lower.includes('voice') || lower.includes('sms') || lower.includes('calls') || lower.includes('text'))) {
      try {
        const raw = await readFile(file, 'utf8')
        // Use specialized SMS parser for text messages
        const { messages, contactName } = parseGoogleVoiceSmsHtml(raw)
        
        // Bulk filtering: skip entire contact if business
        if (contactName && isLikelyBusinessContact(contactName)) {
          continue
        }
        
        // Quality filtering: only import conversation threads (back-and-forth)
        if (!isConversationThread(messages)) {
          continue
        }
        
        // Collect messages for per-contact profile building
        if (contactName) {
          const existing = contactMessagesMap.get(contactName) ?? []
          for (const msg of messages) {
            existing.push({
              text: msg.text,
              isUserMessage: msg.isUserMessage,
              timestamp: msg.timestamp,
              senderName: msg.senderName,
            })
          }
          contactMessagesMap.set(contactName, existing)
        }
        
        // Process messages from valid conversations
        for (const msg of messages) {
          // Skip if this message is likely spam
          if (isLikelySpamMessage(msg.text, msg.senderName, msg.senderPhone, messages.length)) {
            continue
          }
          
          const createdAt = msg.timestamp ? toIso(msg.timestamp) : null
          pushEvent(events, {
            source: 'sms',
            kind: 'message',
            text: msg.text,
            createdAt,
            participants: [msg.isUserMessage ? 'Me' : msg.senderName, contactName].filter((p): p is string => Boolean(p)),
            channel: 'google_voice_sms',
            externalId: null,
            metadata: {
              contactName,
              senderName: msg.senderName,
              senderPhone: msg.senderPhone,
              isUserMessage: msg.isUserMessage,
              isHuman: true,
            },
          })
        }
      } catch {
        // ignore
      }
    }
  }
  
  // Build per-contact profiles from collected messages
  const contactProfiles: PerContactVoiceProfile[] = []
  for (const [, msgs] of contactMessagesMap) {
    const profile = analyzePerContactVoice(msgs)
    if (profile) {
      contactProfiles.push(profile)
    }
  }
  
  return { events, contactProfiles }
}

export async function importYouTubeTakeoutFromFolder(folderPath: string): Promise<IdentityEvent[]> {
  const files = await listFilesRecursive(folderPath)
  const events: IdentityEvent[] = []
  for (const file of files) {
    const lower = file.toLowerCase()
    if (lower.endsWith('.json') && (lower.includes('youtube') || lower.includes('yt music'))) {
      const parsed = await readJsonMaybe(file)
      if (parsed) events.push(...parseYouTubeJson(parsed))
      continue
    }
    if (lower.endsWith('.csv') && lower.includes('youtube')) {
      const rows = await readCsvRows(file)
      events.push(...parseRowsToEvents(rows, 'youtube', 'youtube'))
      continue
    }
    if (lower.endsWith('.html') && (lower.includes('youtube') || lower.includes('yt music') || lower.includes('watch-history') || lower.includes('search-history'))) {
      try {
        const raw = await readFile(file, 'utf8')
        events.push(...parseTakeoutActivityHtml(raw, 'youtube', lower.includes('music') ? 'youtube_music' : 'youtube'))
      } catch {
        // ignore
      }
    }
  }
  return events
}

async function importGmailTakeoutFromFolder(folderPath: string): Promise<IdentityEvent[]> {
  const files = await listFilesRecursive(folderPath)
  const out: IdentityEvent[] = []
  for (const file of files) {
    const lower = file.toLowerCase()
    if (!lower.includes('mail')) continue
    if (lower.endsWith('.json')) {
      try {
        const events = await importGmailEventsFromJson(file)
        if (events.length > 0) out.push(...events)
      } catch {
        // ignore unrelated json files
      }
      continue
    }
    if (lower.endsWith('.mbox')) {
      try {
        const events = await importGmailEventsFromMbox(file)
        if (events.length > 0) out.push(...events)
      } catch {
        // ignore parse failures for malformed mbox files
      }
    }
  }
  return out
}

export async function importGoogleTakeoutAllFromFolder(folderPath: string): Promise<{
  events: IdentityEvent[]
  bySource: Record<string, number>
  contactProfiles: PerContactVoiceProfile[]
}> {
  const [gmail, chrome, discover, googleVoiceResult, youtube] = await Promise.all([
    importGmailTakeoutFromFolder(folderPath),
    importChromeTakeoutFromFolder(folderPath),
    importDiscoverTakeoutFromFolder(folderPath),
    importGoogleVoiceTakeoutFromFolder(folderPath),
    importYouTubeTakeoutFromFolder(folderPath),
  ])

  const googleVoice = googleVoiceResult.events
  const contactProfiles = googleVoiceResult.contactProfiles

  // Count SMS events separately from voice
  const smsEvents = googleVoice.filter(e => e.channel === 'google_voice_sms')
  const voiceEvents = googleVoice.filter(e => e.channel !== 'google_voice_sms')

  const bySource: Record<string, number> = {
    gmail: gmail.length,
    chrome: chrome.length,
    discover: discover.length,
    google_voice: voiceEvents.length,
    sms: smsEvents.length,
    youtube: youtube.length,
  }

  return {
    events: [...gmail, ...chrome, ...discover, ...googleVoice, ...youtube],
    bySource,
    contactProfiles,
  }
}
