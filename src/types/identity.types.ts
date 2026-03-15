export type IdentitySource =
  | 'reddit'
  | 'gmail'
  | 'sms'
  | 'social_csv'
  | 'chrome'
  | 'discover'
  | 'google_voice'
  | 'youtube'

export type IdentityEvent = {
  source: IdentitySource
  kind: 'message' | 'post' | 'comment' | 'email'
  text: string
  createdAt: string | null
  participants?: string[]
  channel?: string | null
  externalId?: string | null
  metadata?: Record<string, unknown>
}

export type IdentityTimeline = {
  source: 'identity_timeline'
  importedAt: string
  events: IdentityEvent[]
}

export type IdentityImportResult = {
  source: IdentitySource
  imported: number
  totalAfterImport: number
}

export type IdentitySourceCount = {
  source: IdentitySource
  count: number
}

export type SocialCsvMapping = {
  textColumn: string
  dateColumn?: string
  authorColumn?: string
  recipientColumn?: string
  channelColumn?: string
  idColumn?: string
}

export type SocialCsvPreview = {
  headers: string[]
  sampleRows: Array<Record<string, string>>
}

export type GoogleTakeoutImportResult = {
  imported: number
  totalAfterImport: number
  bySource: Record<string, number>
}
