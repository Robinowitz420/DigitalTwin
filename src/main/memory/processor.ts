/**
 * Memory Processor - Chunks SMS events into conversation-based groups for summarization
 *
 * CORE PRINCIPLE: This module ONLY groups and prepares data. It does NOT count,
 * rank, or return exact messages as truth. All deterministic logic remains in main.ts.
 *
 * CHUNKING STRATEGY: Conversation-gap based (not calendar months)
 * A "conversation" is a sequence of messages where gaps are < threshold.
 * Default threshold: 6 hours of silence = new conversation.
 * This preserves narrative arcs that span month boundaries.
 */

import type { IdentityEvent } from '../../types/identity.types.js'

export type SmsChunk = {
  id: string // `${contactKey}_${startTime}`
  contactKey: string // normalized participant name
  conversationKey: string // YYYY-MM-DD_HH of first message in conversation
  startTime: number // epoch ms
  endTime: number // epoch ms
  messages: IdentityEvent[]
  messageCount: number
  gapCount: number // number of significant gaps within this chunk
}

/**
 * Normalize a contact name for stable grouping
 */
export function stableContactKey(participants: string[] | undefined): string {
  if (!participants || participants.length === 0) return 'unknown'
  // Sort and lowercase for stability
  const sorted = [...participants].map((p) => (p || '').toLowerCase().trim()).filter(Boolean).sort()
  return sorted.join('_') || 'unknown'
}

/**
 * Extract month key from ISO date string (for backward compatibility)
 */
export function monthKeyFromIso(iso: string | null): string {
  if (!iso) return 'unknown'
  const d = new Date(iso)
  if (!Number.isFinite(d.getTime())) return 'unknown'
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}

/**
 * Get timestamp from event (epoch ms)
 */
function getTimestamp(e: IdentityEvent): number {
  if (!e.createdAt) return NaN
  const ms = Date.parse(e.createdAt)
  return Number.isFinite(ms) ? ms : NaN
}

/**
 * Format a conversation key from timestamp
 */
function conversationKeyFromTimestamp(ms: number): string {
  const d = new Date(ms)
  const date = d.toISOString().slice(0, 10)
  const hour = String(d.getUTCHours()).padStart(2, '0')
  return `${date}_${hour}`
}

/**
 * Group SMS events into chunks by contact + conversation gaps
 * A conversation ends when there's a gap > gapThresholdMs
 * Then merges small conversations and splits large ones
 */
export function chunkSmsEvents(
  events: IdentityEvent[],
  options?: {
    gapThresholdMs?: number // default 6 hours
    minPerChunk?: number
    maxPerChunk?: number
  }
): SmsChunk[] {
  const gapThresholdMs = options?.gapThresholdMs ?? 6 * 60 * 60 * 1000 // 6 hours
  const minPerChunk = options?.minPerChunk ?? 30
  const maxPerChunk = options?.maxPerChunk ?? 150

  // First pass: group by contact
  const byContact = new Map<string, IdentityEvent[]>()

  for (const e of events) {
    if (e.source !== 'sms') continue
    const contactKey = stableContactKey(e.participants)
    const existing = byContact.get(contactKey) ?? []
    existing.push(e)
    byContact.set(contactKey, existing)
  }

  const result: SmsChunk[] = []

  // Second pass: split each contact's messages into conversations by gap
  for (const [contactKey, contactEvents] of byContact) {
    // Sort by timestamp
    const sorted = [...contactEvents]
      .filter((e) => Number.isFinite(getTimestamp(e)))
      .sort((a, b) => getTimestamp(a) - getTimestamp(b))

    if (sorted.length === 0) continue

    // Split into conversations by gap threshold
    const conversations: Array<{ messages: IdentityEvent[]; gapCount: number }> = []
    let currentConv: IdentityEvent[] = [sorted[0]]
    let gapCount = 0

    for (let i = 1; i < sorted.length; i++) {
      const prevTs = getTimestamp(sorted[i - 1])
      const currTs = getTimestamp(sorted[i])
      const gap = currTs - prevTs

      if (gap > gapThresholdMs) {
        // End current conversation, start new one
        if (currentConv.length > 0) {
          conversations.push({ messages: currentConv, gapCount })
        }
        currentConv = [sorted[i]]
        gapCount = 0
      } else if (gap > gapThresholdMs / 3) {
        // Minor gap within conversation
        gapCount++
        currentConv.push(sorted[i])
      } else {
        currentConv.push(sorted[i])
      }
    }

    // Don't forget the last conversation
    if (currentConv.length > 0) {
      conversations.push({ messages: currentConv, gapCount })
    }

    // Third pass: merge small conversations, split large ones
    let accumulator: IdentityEvent[] = []
    let accumulatorStart: number | null = null
    let accumulatorEnd: number | null = null
    let accumulatorGaps = 0

    for (const conv of conversations) {
      const convStart = getTimestamp(conv.messages[0])
      const convEnd = getTimestamp(conv.messages[conv.messages.length - 1])

      if (accumulatorStart === null) {
        accumulatorStart = convStart
      }
      accumulatorEnd = convEnd
      accumulatorGaps += conv.gapCount + 1 // +1 for the gap between this conv and previous

      accumulator.push(...conv.messages)

      // If we have enough messages, emit a chunk
      if (accumulator.length >= minPerChunk) {
        // Split if too large
        while (accumulator.length > maxPerChunk) {
          const split = accumulator.slice(0, maxPerChunk)
          const splitEnd = getTimestamp(split[split.length - 1])

          result.push({
            id: `${contactKey}_${accumulatorStart}`,
            contactKey,
            conversationKey: conversationKeyFromTimestamp(accumulatorStart),
            startTime: accumulatorStart,
            endTime: Number.isFinite(splitEnd) ? splitEnd : accumulatorEnd,
            messages: split,
            messageCount: split.length,
            gapCount: accumulatorGaps,
          })

          accumulator = accumulator.slice(maxPerChunk)
          accumulatorStart = getTimestamp(accumulator[0]) ?? Date.now()
        }

        // Emit remaining
        if (accumulator.length > 0) {
          result.push({
            id: `${contactKey}_${accumulatorStart}`,
            contactKey,
            conversationKey: conversationKeyFromTimestamp(accumulatorStart),
            startTime: accumulatorStart,
            endTime: accumulatorEnd ?? Date.now(),
            messages: accumulator,
            messageCount: accumulator.length,
            gapCount: accumulatorGaps,
          })
        }

        accumulator = []
        accumulatorStart = null
        accumulatorEnd = null
        accumulatorGaps = 0
      }
    }

    // Handle remaining small conversations
    if (accumulator.length > 0) {
      result.push({
        id: `${contactKey}_${accumulatorStart}_merged`,
        contactKey,
        conversationKey: 'merged',
        startTime: accumulatorStart ?? Date.now(),
        endTime: accumulatorEnd ?? Date.now(),
        messages: accumulator,
        messageCount: accumulator.length,
        gapCount: accumulatorGaps,
      })
    }
  }

  return result
}

/**
 * Format a chunk for LLM summarization prompt
 */
export function formatChunkForLLM(chunk: SmsChunk): string {
  const lines = chunk.messages.map((e) => {
    const ts = e.createdAt?.slice(0, 19) ?? 'no date'
    const fromMe = e.metadata?.isUserMessage ? 'Me' : 'Them'
    const txt = (e.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 500)
    return `[${ts}] ${fromMe}: ${txt}`
  })

  const durationHours = Math.round((chunk.endTime - chunk.startTime) / (60 * 60 * 1000))

  return `CONTACT: ${chunk.contactKey}
TIME RANGE: ${new Date(chunk.startTime).toISOString().slice(0, 19)} to ${new Date(chunk.endTime).toISOString().slice(0, 19)}
DURATION: ~${durationHours} hours
MESSAGE COUNT: ${chunk.messageCount}
GAPS: ${chunk.gapCount} significant pauses within conversation

MESSAGES:
${lines.join('\n')}`
}
