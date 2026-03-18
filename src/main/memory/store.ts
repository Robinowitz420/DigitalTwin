/**
 * Memory Store - Persists memory chunks to disk
 *
 * Stores chunk summaries for fast retrieval without re-computation.
 * Cache is invalidated when underlying SMS data changes.
 */

import * as path from 'node:path'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { app } from 'electron'
import type { SmsChunk } from './processor.js'
import type { ChunkSummary } from './ollamaClient.js'

export type MemoryChunk = {
  id: string
  contactKey: string
  conversationKey: string // YYYY-MM-DD_HH of first message
  startTime: number
  endTime: number
  summary: string
  topics: string[]
  notableEvents: string[]
  tone: string
  messageCount: number
  processedAt: string // ISO timestamp when summarized
  modelUsed: string // which LLM model generated this
  gapCount: number // number of significant gaps within conversation
  // Confidence + trace metadata
  confidence: number // 0-1, quality estimate
  sourceRange: {
    contact: string
    start: string // ISO date
    end: string // ISO date
  }
  // Knowledge deltas - what user disclosed to this contact
  knowledgeDeltas: Array<{
    topic: string
    status: 'disclosed' | 'hinted' | 'updated' | 'contradicted'
    date: string
    evidence?: string
  }>
}

export type MemoryStore = {
  version: number // schema version for migrations
  lastProcessed: string // ISO timestamp
  totalChunks: number
  chunks: MemoryChunk[]
  metaSummaries: Record<string, string> // contactKey -> meta-summary
  knowledgeStates: Record<string, Array<{ topic: string; lastMentioned: string; quote: string }>>
}

const CURRENT_VERSION = 1
const STORE_FILENAME = 'memory.store.json'

function getStorePath(): string {
  const userData = app.getPath('userData')
  return path.join(userData, STORE_FILENAME)
}

/**
 * Load memory store from disk
 */
export async function loadMemoryStore(): Promise<MemoryStore> {
  const storePath = getStorePath()

  if (!existsSync(storePath)) {
    return {
      version: CURRENT_VERSION,
      lastProcessed: new Date(0).toISOString(),
      totalChunks: 0,
      chunks: [],
      metaSummaries: {},
      knowledgeStates: {},
    }
  }

  try {
    const raw = await readFile(storePath, 'utf-8')
    const data = JSON.parse(raw) as MemoryStore

    // Version migration if needed
    if (data.version !== CURRENT_VERSION) {
      console.log('[MemoryStore] Migrating from version', data.version, 'to', CURRENT_VERSION)
      // For now, just reset - in future could do proper migration
      return {
        version: CURRENT_VERSION,
        lastProcessed: new Date(0).toISOString(),
        totalChunks: 0,
        chunks: [],
        metaSummaries: {},
        knowledgeStates: {},
      }
    }

    return data
  } catch (error) {
    console.error('[MemoryStore] Error loading store:', error)
    return {
      version: CURRENT_VERSION,
      lastProcessed: new Date(0).toISOString(),
      totalChunks: 0,
      chunks: [],
      metaSummaries: {},
      knowledgeStates: {},
    }
  }
}

/**
 * Save memory store to disk
 */
export async function saveMemoryStore(store: MemoryStore): Promise<void> {
  const storePath = getStorePath()
  const userData = app.getPath('userData')

  // Ensure directory exists
  await mkdir(userData, { recursive: true })

  store.lastProcessed = new Date().toISOString()
  store.totalChunks = store.chunks.length

  await writeFile(storePath, JSON.stringify(store, null, 2), 'utf-8')
}

/**
 * Convert a raw chunk + summary into a stored MemoryChunk
 */
export function createMemoryChunk(
  chunk: SmsChunk,
  summary: ChunkSummary,
  modelUsed: string
): MemoryChunk {
  return {
    id: chunk.id,
    contactKey: chunk.contactKey,
    conversationKey: chunk.conversationKey,
    startTime: chunk.startTime,
    endTime: chunk.endTime,
    summary: summary.summary,
    topics: summary.topics,
    notableEvents: summary.notableEvents,
    tone: summary.tone,
    messageCount: chunk.messageCount,
    processedAt: new Date().toISOString(),
    modelUsed,
    gapCount: chunk.gapCount,
    // Confidence + trace metadata
    confidence: summary.confidence,
    sourceRange: summary.sourceRange,
    // Knowledge deltas
    knowledgeDeltas: summary.knowledgeDeltas,
  }
}

/**
 * Check if a chunk needs processing (not in store or stale)
 */
export function chunkNeedsProcessing(chunk: SmsChunk, store: MemoryStore): boolean {
  const existing = store.chunks.find((c) => c.id === chunk.id)
  if (!existing) return true

  // Check if the chunk has more messages now
  if (existing.messageCount !== chunk.messageCount) return true

  // Check if processed too long ago (7 days)
  const processedDate = new Date(existing.processedAt)
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
  if (processedDate < weekAgo) return true

  return false
}

/**
 * Get all chunks for a specific contact
 */
export function getChunksByContact(store: MemoryStore, contactKey: string): MemoryChunk[] {
  return store.chunks
    .filter((c) => c.contactKey === contactKey)
    .sort((a, b) => a.startTime - b.startTime)
}

/**
 * Get all unique contacts in the store
 */
export function getAllContacts(store: MemoryStore): string[] {
  const contacts = new Set(store.chunks.map((c) => c.contactKey))
  return Array.from(contacts).sort()
}

/**
 * Get meta-summary for a contact (or return undefined)
 */
export function getMetaSummary(store: MemoryStore, contactKey: string): string | undefined {
  return store.metaSummaries[contactKey]
}

/**
 * Set meta-summary for a contact
 */
export function setMetaSummary(store: MemoryStore, contactKey: string, summary: string): void {
  store.metaSummaries[contactKey] = summary
}

/**
 * Get knowledge state for a contact
 */
export function getKnowledgeState(
  store: MemoryStore,
  contactKey: string
): Array<{ topic: string; lastMentioned: string; quote: string }> {
  return store.knowledgeStates[contactKey] ?? []
}

/**
 * Set knowledge state for a contact
 */
export function setKnowledgeState(
  store: MemoryStore,
  contactKey: string,
  topics: Array<{ topic: string; lastMentioned: string; quote: string }>
): void {
  store.knowledgeStates[contactKey] = topics
}

/**
 * Add or update a memory chunk in the store
 */
export function upsertMemoryChunk(store: MemoryStore, memoryChunk: MemoryChunk): void {
  const idx = store.chunks.findIndex((c) => c.id === memoryChunk.id)
  if (idx >= 0) {
    store.chunks[idx] = memoryChunk
  } else {
    store.chunks.push(memoryChunk)
  }
}

/**
 * Clear all memory (for testing or reset)
 */
export function clearMemoryStore(store: MemoryStore): void {
  store.chunks = []
  store.metaSummaries = {}
  store.knowledgeStates = {}
  store.lastProcessed = new Date(0).toISOString()
  store.totalChunks = 0
}
