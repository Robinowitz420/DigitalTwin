import * as path from 'node:path'
import { readdir, readFile } from 'node:fs/promises'
import Papa from 'papaparse'
import type { IdentityEvent } from '../../types/identity.types.js'
import { importGmailEventsFromJson, importGmailEventsFromMbox } from './gmail.js'

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
    const ms = value > 10_000_000_000 ? value : value * 1000
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

function parseGoogleVoiceJson(parsed: unknown): IdentityEvent[] {
  const events: IdentityEvent[] = []
  const objs = flattenObjects(parsed)
  for (const obj of objs) {
    const text = textFromKeys(obj, ['messageText', 'transcript', 'voicemailText', 'text', 'content', 'body'])
    const from = textFromKeys(obj, ['from', 'fromNumber', 'sender'])
    const to = textFromKeys(obj, ['to', 'toNumber', 'recipient'])
    const hasVoiceSignal = /voice|voicemail|call|sms|mms/i.test(Object.keys(obj).join(' '))
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

export async function importGoogleVoiceTakeoutFromFolder(folderPath: string): Promise<IdentityEvent[]> {
  const files = await listFilesRecursive(folderPath)
  const events: IdentityEvent[] = []
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
    if (lower.endsWith('.html') && (lower.includes('voice') || lower.includes('sms') || lower.includes('calls'))) {
      try {
        const raw = await readFile(file, 'utf8')
        events.push(...parseTakeoutActivityHtml(raw, 'google_voice', 'google_voice'))
      } catch {
        // ignore
      }
    }
  }
  return events
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
}> {
  const [gmail, chrome, discover, googleVoice, youtube] = await Promise.all([
    importGmailTakeoutFromFolder(folderPath),
    importChromeTakeoutFromFolder(folderPath),
    importDiscoverTakeoutFromFolder(folderPath),
    importGoogleVoiceTakeoutFromFolder(folderPath),
    importYouTubeTakeoutFromFolder(folderPath),
  ])

  const bySource: Record<string, number> = {
    gmail: gmail.length,
    chrome: chrome.length,
    discover: discover.length,
    google_voice: googleVoice.length,
    youtube: youtube.length,
  }

  return {
    events: [...gmail, ...chrome, ...discover, ...googleVoice, ...youtube],
    bySource,
  }
}
