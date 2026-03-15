import { readFile } from 'node:fs/promises'
import Papa from 'papaparse'
import type { IdentityEvent, SocialCsvMapping, SocialCsvPreview } from '../../types/identity.types.js'

type Row = Record<string, unknown>

function pickFirstString(row: Row, keys: string[]): string | null {
  for (const key of keys) {
    const val = row[key]
    if (typeof val === 'string' && val.trim()) return val.trim()
  }
  return null
}

function normalizeRow(row: Row): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(row)) {
    if (value == null) {
      out[key] = ''
    } else if (typeof value === 'string') {
      out[key] = value
    } else {
      out[key] = String(value)
    }
  }
  return out
}

function parseDateMaybe(value: string | null): string | null {
  if (!value) return null
  const d = new Date(value)
  return Number.isFinite(d.getTime()) ? d.toISOString() : null
}

async function parseCsvRows(filePath: string): Promise<Row[]> {
  const raw = await readFile(filePath, 'utf8')
  const parsed = Papa.parse<Row>(raw, { header: true, skipEmptyLines: true })
  return parsed.data ?? []
}

export async function previewSocialCsv(filePath: string): Promise<SocialCsvPreview> {
  const rows = await parseCsvRows(filePath)
  const headers = rows.length > 0 ? Object.keys(rows[0]) : []
  const sampleRows = rows.slice(0, 5).map((r) => normalizeRow(r))
  return { headers, sampleRows }
}

export async function importSocialCsvEvents(filePath: string, mapping: SocialCsvMapping): Promise<IdentityEvent[]> {
  const rows = await parseCsvRows(filePath)
  const events: IdentityEvent[] = []
  for (const row of rows) {
    const text = pickFirstString(row, [mapping.textColumn])
    if (!text) continue

    const createdAt = parseDateMaybe(mapping.dateColumn ? pickFirstString(row, [mapping.dateColumn]) : null)

    const author = mapping.authorColumn ? pickFirstString(row, [mapping.authorColumn]) : null
    const recipient = mapping.recipientColumn ? pickFirstString(row, [mapping.recipientColumn]) : null
    const channel = mapping.channelColumn ? pickFirstString(row, [mapping.channelColumn]) : null
    const externalId = mapping.idColumn ? pickFirstString(row, [mapping.idColumn]) : null

    const participants = [author, recipient].filter((x): x is string => Boolean(x))

    events.push({
      source: 'social_csv',
      kind: 'message',
      text: text.slice(0, 6000),
      createdAt,
      participants: participants.length > 0 ? participants : undefined,
      channel,
      externalId,
      metadata: row,
    })
  }

  return events
}
