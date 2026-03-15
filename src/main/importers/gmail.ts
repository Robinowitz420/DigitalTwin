import { readFile } from 'node:fs/promises'
import type { IdentityEvent } from '../../types/identity.types.js'

type GmailHeader = { name?: string; value?: string }
type GmailPayload = { headers?: GmailHeader[]; body?: { data?: string }; parts?: GmailPayload[] }
type GmailMessage = {
  id?: string
  threadId?: string
  snippet?: string
  internalDate?: string
  labelIds?: string[]
  payload?: GmailPayload
}

type HeaderMap = Record<string, string>

function findHeader(headers: GmailHeader[] | undefined, headerName: string) {
  const h = (headers ?? []).find((x) => (x.name ?? '').toLowerCase() === headerName.toLowerCase())
  return h?.value ?? null
}

function extractBodyText(payload: GmailPayload | undefined): string {
  if (!payload) return ''
  const fromBody = payload.body?.data ? payload.body.data : ''
  if (fromBody) {
    try {
      return Buffer.from(fromBody.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
    } catch {
      return ''
    }
  }
  for (const p of payload.parts ?? []) {
    const t = extractBodyText(p)
    if (t.trim()) return t
  }
  return ''
}

function parseHeaders(rawHeaders: string): HeaderMap {
  const out: HeaderMap = {}
  const lines = rawHeaders.split('\n')
  let currentKey: string | null = null
  let currentValue = ''

  const flush = () => {
    if (!currentKey) return
    const existing = out[currentKey]
    out[currentKey] = existing ? `${existing}, ${currentValue.trim()}` : currentValue.trim()
    currentKey = null
    currentValue = ''
  }

  for (const line of lines) {
    if (!line.trim()) continue
    if (/^[ \t]/.test(line) && currentKey) {
      currentValue += ` ${line.trim()}`
      continue
    }
    flush()
    const idx = line.indexOf(':')
    if (idx <= 0) continue
    currentKey = line.slice(0, idx).trim().toLowerCase()
    currentValue = line.slice(idx + 1).trim()
  }
  flush()
  return out
}

function decodeMimeWords(input: string): string {
  return input.replace(/=\?([^?]+)\?([BbQq])\?([^?]+)\?=/g, (_m, charsetRaw: string, encRaw: string, data: string) => {
    const charset = String(charsetRaw).toLowerCase()
    const enc = String(encRaw).toLowerCase()
    try {
      if (enc === 'b') {
        const buf = Buffer.from(data, 'base64')
        return charset.includes('utf-8') ? buf.toString('utf8') : buf.toString()
      }
      // quoted-printable word variant
      const qp = data
        .replace(/_/g, ' ')
        .replace(/=([A-Fa-f0-9]{2})/g, (_x, hex: string) => String.fromCharCode(parseInt(hex, 16)))
      return qp
    } catch {
      return data
    }
  })
}

function decodeQuotedPrintable(input: string): string {
  return input
    .replace(/=\r?\n/g, '')
    .replace(/=([A-Fa-f0-9]{2})/g, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)))
}

function decodeBodyByHeaders(body: string, headers: HeaderMap): string {
  const cte = (headers['content-transfer-encoding'] ?? '').toLowerCase()
  if (cte.includes('base64')) {
    const compact = body.replace(/\s+/g, '')
    try {
      return Buffer.from(compact, 'base64').toString('utf8')
    } catch {
      return body
    }
  }
  if (cte.includes('quoted-printable')) {
    return decodeQuotedPrintable(body)
  }
  return body
}

function extractMultipartText(body: string, contentType: string): string {
  const boundaryMatch = contentType.match(/boundary="?([^";]+)"?/i)
  if (!boundaryMatch) return body
  const boundary = boundaryMatch[1]
  const parts = body.split(new RegExp(`--${boundary}(?:--)?\\s*`))
  const texts: string[] = []
  for (const part of parts) {
    const normalized = part.replace(/\r\n/g, '\n')
    const splitIdx = normalized.indexOf('\n\n')
    if (splitIdx <= 0) continue
    const headers = parseHeaders(normalized.slice(0, splitIdx))
    const partBody = normalized.slice(splitIdx + 2)
    const partType = (headers['content-type'] ?? '').toLowerCase()
    if (!partType.includes('text/plain')) continue
    const decoded = decodeBodyByHeaders(partBody, headers).trim()
    if (decoded) texts.push(decoded)
  }
  return texts.length > 0 ? texts.join('\n\n') : body
}

function parseMboxMessages(rawMbox: string): Array<{ headers: HeaderMap; body: string }> {
  const normalized = rawMbox.replace(/\r\n/g, '\n')
  const blocks = normalized
    .split(/\n(?=From )/g)
    .map((b) => b.trimStart())
    .filter(Boolean)

  const messages: Array<{ headers: HeaderMap; body: string }> = []
  for (const block of blocks) {
    const withoutEnvelope = block.startsWith('From ') ? block.slice(block.indexOf('\n') + 1) : block
    const splitIdx = withoutEnvelope.indexOf('\n\n')
    if (splitIdx <= 0) continue
    const headersRaw = withoutEnvelope.slice(0, splitIdx)
    const bodyRaw = withoutEnvelope.slice(splitIdx + 2)
    const headers = parseHeaders(headersRaw)
    messages.push({ headers, body: bodyRaw })
  }
  return messages
}

export async function importGmailEventsFromJson(filePath: string): Promise<IdentityEvent[]> {
  const raw = await readFile(filePath, 'utf8')
  const parsed = JSON.parse(raw) as unknown
  const messages: GmailMessage[] = Array.isArray(parsed)
    ? (parsed as GmailMessage[])
    : Array.isArray((parsed as { messages?: unknown[] })?.messages)
      ? ((parsed as { messages: GmailMessage[] }).messages ?? [])
      : []

  const events: IdentityEvent[] = []
  for (const msg of messages) {
    const headers = msg.payload?.headers ?? []
    const from = findHeader(headers, 'From')
    const to = findHeader(headers, 'To')
    const subject = findHeader(headers, 'Subject')
    const dateHeader = findHeader(headers, 'Date')
    const createdAt = msg.internalDate
      ? (() => {
          const d = new Date(Number(msg.internalDate))
          return Number.isFinite(d.getTime()) ? d.toISOString() : null
        })()
      : dateHeader
        ? (() => {
            const d = new Date(dateHeader)
            return Number.isFinite(d.getTime()) ? d.toISOString() : null
          })()
        : null

    const body = extractBodyText(msg.payload)
    const snippet = (msg.snippet ?? '').trim()
    const textParts = [subject ? `Subject: ${subject}` : '', body.trim(), snippet]
      .filter(Boolean)
      .join('\n\n')
      .trim()

    if (!textParts) continue

    const participants = [from, to].filter((x): x is string => Boolean(x)).flatMap((line) =>
      line
        .split(',')
        .map((p) => p.trim())
        .filter(Boolean),
    )

    events.push({
      source: 'gmail',
      kind: 'email',
      text: textParts.slice(0, 6000),
      createdAt,
      participants: participants.length > 0 ? participants : undefined,
      channel: 'gmail',
      externalId: msg.id ?? msg.threadId ?? null,
      metadata: {
        threadId: msg.threadId ?? null,
        labels: msg.labelIds ?? [],
      },
    })
  }

  return events
}

export async function importGmailEventsFromMbox(filePath: string): Promise<IdentityEvent[]> {
  const raw = await readFile(filePath, 'utf8')
  const messages = parseMboxMessages(raw)
  const events: IdentityEvent[] = []

  for (const msg of messages) {
    const from = decodeMimeWords(msg.headers['from'] ?? '')
    const to = decodeMimeWords(msg.headers['to'] ?? '')
    const subjectRaw = msg.headers['subject'] ?? ''
    const subject = decodeMimeWords(subjectRaw)
    const dateHeader = msg.headers['date'] ?? ''
    const createdAt = dateHeader
      ? (() => {
          const d = new Date(dateHeader)
          return Number.isFinite(d.getTime()) ? d.toISOString() : null
        })()
      : null

    const contentType = (msg.headers['content-type'] ?? '').toLowerCase()
    const multipartText = contentType.includes('multipart/')
      ? extractMultipartText(msg.body, contentType)
      : msg.body
    const decodedBody = decodeBodyByHeaders(multipartText, msg.headers).trim()
    const body = decodeMimeWords(decodedBody)

    const textParts = [subject ? `Subject: ${subject}` : '', body].filter(Boolean).join('\n\n').trim()
    if (!textParts) continue

    const participants = [from, to]
      .filter(Boolean)
      .flatMap((line) =>
        line
          .split(',')
          .map((p) => p.trim())
          .filter(Boolean),
      )

    events.push({
      source: 'gmail',
      kind: 'email',
      text: textParts.slice(0, 6000),
      createdAt,
      participants: participants.length > 0 ? participants : undefined,
      channel: 'gmail',
      externalId: msg.headers['message-id'] ?? null,
      metadata: {
        labels: [],
      },
    })
  }

  return events
}
