/**
 * Memory Retrieval - Get relevant memory chunks by contact and topic
 *
 * CORE PRINCIPLE: This module retrieves STORED summaries only.
 * It does NOT perform counting, ranking, or exact message lookup.
 * All deterministic logic remains in main.ts.
 *
 * EVIDENCE OF DISCLOSURE: Reconstructs knowledge from evidence, not storage.
 * "Does X know about Y?" → "What evidence exists that I told X about Y?"
 */

import type { MemoryChunk, MemoryStore } from './store.js'
import { getChunksByContact } from './store.js'
import type { IdentityEvent } from '../../types/identity.types.js'

export type RetrievedMemory = {
  chunks: MemoryChunk[]
  metaSummary?: string
  knowledgeState?: Array<{ topic: string; lastMentioned: string; quote: string }>
}

/**
 * Disclosure Evidence - atomic unit for "does X know about Y"
 */
export type DisclosureEvidence = {
  claim: string // "User told Mom about quitting job"
  contact: string
  topic: string
  direction: 'outgoing' | 'incoming' | 'bidirectional'
  evidence: Array<{
    timestamp: string
    text: string
    isUserMessage: boolean
  }>
  confidence: number
  lastMentioned: string
  mentionCount: number
  spreadAcrossTime: boolean
  contradictions: Array<{
    timestamp: string
    text: string
  }>
  acknowledged: boolean // did contact reference it later?
  ackEvidence?: Array<{
    timestamp: string
    text: string
  }>
}

/**
 * Disclosure Result - structured output for "does X know about Y"
 */
export type DisclosureResult = {
  status: 'confirmed' | 'weak' | 'none' | 'conflicting'
  answer: string
  evidence: DisclosureEvidence
  notes: string[]
}

/**
 * Controlled vocabulary for topic expansion
 * Maps topic keywords to synonyms for broader matching
 */
export const TOPIC_SYNONYMS: Record<string, string[]> = {
  startup: ['startup', 'company', 'project', 'app', 'business', 'venture'],
  job: ['job', 'work', 'position', 'role', 'employment', 'career'],
  breakup: ['breakup', 'split', 'separated', 'divorce', 'ended'],
  move: ['move', 'moving', 'apartment', 'house', 'relocate', 'relocation'],
  promotion: ['promotion', 'promoted', 'raise', 'advance', 'advancement'],
  dating: ['dating', 'relationship', 'boyfriend', 'girlfriend', 'partner'],
  health: ['health', 'sick', 'hospital', 'doctor', 'medical'],
  family: ['family', 'mom', 'dad', 'sister', 'brother', 'parents'],
  travel: ['travel', 'trip', 'vacation', 'visit', 'visiting'],
  money: ['money', 'finance', 'budget', 'savings', 'debt', 'loan'],
}

/**
 * Expand a topic to include synonyms
 */
export function expandTopic(topic: string): string[] {
  const topicLower = topic.toLowerCase()
  
  // Check if topic matches any known category
  for (const [category, synonyms] of Object.entries(TOPIC_SYNONYMS)) {
    if (category === topicLower || synonyms.includes(topicLower)) {
      return [...synonyms, category]
    }
  }
  
  // No match - return just the topic
  return [topicLower]
}

/**
 * Normalize a contact name for matching
 * Handles variations like "John Doe", "john doe", "John", etc.
 */
export function normalizeContactName(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
}

/**
 * Check if a query mentions a contact name
 * Returns the matched contact key or undefined
 */
export function extractContactFromQuery(
  query: string,
  knownContacts: string[]
): string | undefined {
  const q = query.toLowerCase()

  // Try exact matches first
  for (const contact of knownContacts) {
    const normalized = normalizeContactName(contact)
    if (q.includes(normalized) || q.includes(contact.toLowerCase())) {
      return contact
    }
  }

  // Try partial matches (first name, last name)
  for (const contact of knownContacts) {
    const parts = contact.split(/[_\s]+/)
    for (const part of parts) {
      if (part.length >= 3 && q.includes(part.toLowerCase())) {
        return contact
      }
    }
  }

  return undefined
}

/**
 * Detect if query is asking for a conversation summary
 */
export function isSummaryQuery(query: string): boolean {
  const q = query.toLowerCase()
  return (
    /\b(summarize|summary|tell me about|what about|how's|how is|describe)\b/.test(q) &&
    /\b(conversation|chat|text|messages|relationship|talk|talking)\b/.test(q)
  ) || /\b(what have I talked about|what did we talk|what do we talk)\b/.test(q)
}

/**
 * Detect if query is asking about a specific topic with a contact
 */
export function isTopicQuery(query: string): { isTopic: boolean; topic?: string } {
  const q = query.toLowerCase()

  // Pattern: "what did I tell X about Y" or "what did we talk about Y"
  const tellMatch = q.match(/what did i (?:tell|say to|talk to) .+? about (.+?)(?:\?|$)/)
  if (tellMatch) {
    return { isTopic: true, topic: tellMatch[1].trim() }
  }

  const talkMatch = q.match(/what did we talk about (.+?)(?:\?|$)/)
  if (talkMatch) {
    return { isTopic: true, topic: talkMatch[1].trim() }
  }

  const aboutMatch = q.match(/about (.+?) with /)
  if (aboutMatch) {
    return { isTopic: true, topic: aboutMatch[1].trim() }
  }

  return { isTopic: false }
}

/**
 * Get relevant memory for a contact
 * Returns chunks sorted by time, plus meta-summary if available
 */
export function getRelevantMemory(
  store: MemoryStore,
  contactKey: string,
  options?: { limit?: number }
): RetrievedMemory {
  const limit = options?.limit ?? 10

  const chunks = getChunksByContact(store, contactKey).slice(0, limit)
  const metaSummary = store.metaSummaries[contactKey]
  const knowledgeState = store.knowledgeStates[contactKey]

  return {
    chunks,
    metaSummary,
    knowledgeState,
  }
}

/**
 * Get memory chunks matching a specific topic
 * Uses simple string matching on topics array
 */
export function getMemoryByTopic(
  store: MemoryStore,
  contactKey: string,
  topic: string
): MemoryChunk[] {
  const contactChunks = getChunksByContact(store, contactKey)
  const topicLower = topic.toLowerCase()

  // Filter chunks that have matching topics
  const matching = contactChunks.filter((chunk) => {
    const chunkTopics = chunk.topics.map((t) => t.toLowerCase())
    return chunkTopics.some((t) => t.includes(topicLower) || topicLower.includes(t))
  })

  // Also search in summary text
  const summaryMatches = contactChunks.filter((chunk) => {
    if (matching.includes(chunk)) return false
    return chunk.summary.toLowerCase().includes(topicLower)
  })

  return [...matching, ...summaryMatches]
}

/**
 * Format retrieved memory for LLM prompt
 */
export function formatRetrievedMemoryForLLM(memory: RetrievedMemory): string {
  const lines: string[] = []

  if (memory.metaSummary) {
    lines.push(`OVERALL SUMMARY: ${memory.metaSummary}`)
    lines.push('')
  }

  if (memory.knowledgeState && memory.knowledgeState.length > 0) {
    lines.push('KNOWN TOPICS:')
    for (const t of memory.knowledgeState) {
      lines.push(`- ${t.topic} (last mentioned: ${t.lastMentioned})`)
    }
    lines.push('')
  }

  if (memory.chunks.length > 0) {
    lines.push('CONVERSATION CHUNKS:')
    for (const chunk of memory.chunks) {
      const dateRange = `${new Date(chunk.startTime).toISOString().slice(0, 10)} to ${new Date(chunk.endTime).toISOString().slice(0, 10)}`
      lines.push(`\n[${dateRange}] (${chunk.messageCount} messages)`)
      lines.push(`Summary: ${chunk.summary}`)
      if (chunk.topics.length > 0) {
        lines.push(`Topics: ${chunk.topics.join(', ')}`)
      }
      if (chunk.notableEvents.length > 0) {
        lines.push(`Notable: ${chunk.notableEvents.join(', ')}`)
      }
    }
  }

  return lines.join('\n')
}

/**
 * Build a prompt for summarizing conversation with a contact
 */
export function buildSummaryPrompt(contactKey: string, memory: RetrievedMemory): string {
  const evidenceText = formatRetrievedMemoryForLLM(memory)

  return `You are answering a question about the user's conversation history with a contact.

IMPORTANT RULES:
- You ONLY have access to the chunk summaries shown in EVIDENCE below.
- Do NOT guess or infer details not present in the evidence.
- If information is missing, say "I don't have that information" rather than guessing.
- Be specific about time periods when mentioned in the evidence.

CONTACT: ${contactKey}

EVIDENCE:
${evidenceText || '(No conversation history found for this contact)'}

Provide a response that includes:
1) A relationship summary (how they know each other, nature of contact)
2) Recurring themes and topics
3) Notable events or milestones (if any mentioned)
4) How the relationship evolved over time (early vs recent)

If no evidence is available, say: "I don't have any stored conversation summaries for that contact yet."`
}

/**
 * Build a prompt for topic-specific query
 */
export function buildTopicPrompt(
  contactKey: string,
  topic: string,
  matchingChunks: MemoryChunk[]
): string {
  const chunksText = matchingChunks
    .map((c) => {
      const dateRange = `${new Date(c.startTime).toISOString().slice(0, 10)} to ${new Date(c.endTime).toISOString().slice(0, 10)}`
      return `[${dateRange}]\nSummary: ${c.summary}\nTopics: ${c.topics.join(', ')}`
    })
    .join('\n\n')

  return `You are answering a question about what the user discussed with a contact.

IMPORTANT RULES:
- You ONLY have access to the chunk summaries shown below.
- Do NOT invent details not present in the summaries.
- If the topic is not mentioned, say so clearly.

CONTACT: ${contactKey}
TOPIC: ${topic}

RELEVANT CHUNKS:
${chunksText || '(No chunks found matching this topic)'}

Answer the question: What did the user tell ${contactKey} about ${topic}?

If the topic is not found in the evidence, say: "I don't have any stored summaries mentioning '${topic}' in conversations with ${contactKey}."`
}

/**
 * Detect if query is asking "does X know about Y"
 * Returns contact and topic if matched
 */
export function detectDisclosureQuery(
  query: string,
  knownContacts: string[]
): { isDisclosure: boolean; contact?: string; topic?: string } {
  const q = query.toLowerCase()

  // Pattern: "does X know about Y" or "does X know Y"
  const doesKnowMatch = q.match(/does (\w+) know (?:about )?(.+?)(?:\?|$)/)
  if (doesKnowMatch) {
    const contactName = doesKnowMatch[1]
    const topic = doesKnowMatch[2]
    
    // Verify contact exists
    const matchedContact = knownContacts.find(
      (c) => c.toLowerCase().includes(contactName) || contactName.includes(c.toLowerCase())
    )
    
    if (matchedContact) {
      return { isDisclosure: true, contact: matchedContact, topic: topic.trim() }
    }
  }

  // Pattern: "did I tell X about Y"
  const didTellMatch = q.match(/did i tell (\w+) about (.+?)(?:\?|$)/)
  if (didTellMatch) {
    const contactName = didTellMatch[1]
    const topic = didTellMatch[2]
    
    const matchedContact = knownContacts.find(
      (c) => c.toLowerCase().includes(contactName) || contactName.includes(c.toLowerCase())
    )
    
    if (matchedContact) {
      return { isDisclosure: true, contact: matchedContact, topic: topic.trim() }
    }
  }

  // Pattern: "have I mentioned Y to X"
  const mentionedMatch = q.match(/have i mentioned (.+?) to (\w+)(?:\?|$)/)
  if (mentionedMatch) {
    const topic = mentionedMatch[1]
    const contactName = mentionedMatch[2]
    
    const matchedContact = knownContacts.find(
      (c) => c.toLowerCase().includes(contactName) || contactName.includes(c.toLowerCase())
    )
    
    if (matchedContact) {
      return { isDisclosure: true, contact: matchedContact, topic: topic.trim() }
    }
  }

  return { isDisclosure: false }
}

/**
 * Detect acknowledgment signals - did contact reference topic later?
 * This is STRONGER confirmation than just user's disclosure
 */
export function detectAcknowledgment(
  contactMessages: IdentityEvent[], // messages FROM contact (not user)
  topicKeywords: string[]
): {
  acknowledged: boolean
  evidence: Array<{ timestamp: string; text: string }>
} {
  const ackMatches: Array<{ timestamp: string; text: string }> = []

  for (const msg of contactMessages) {
    // Skip user's own messages - we want contact's messages
    if (msg.metadata?.isUserMessage) continue

    const text = (msg.text ?? '').toLowerCase()
    
    // Check if contact referenced the topic
    const hasMatch = topicKeywords.some((kw) => text.includes(kw.toLowerCase()))
    if (hasMatch) {
      ackMatches.push({
        timestamp: msg.createdAt ?? 'unknown',
        text: msg.text ?? '',
      })
    }
  }

  return {
    acknowledged: ackMatches.length > 0,
    evidence: ackMatches,
  }
}

/**
 * Evidence of Disclosure - reconstruct knowledge from evidence
 * 
 * CORE PRINCIPLE: "Knowledge is not stored. It is reconstructed from evidence."
 * 
 * Returns structured result with status, evidence, and notes
 */
export function evidenceOfDisclosure(
  smsEvents: IdentityEvent[],
  contactKey: string,
  topic: string,
  memoryStore?: MemoryStore
): DisclosureResult {
  const expandedTopics = expandTopic(topic)
  const notes: string[] = []

  // Step 1: Filter by contact + user as sender (outgoing)
  const contactMessages = smsEvents.filter((e) => {
    const participants = e.participants ?? []
    const hasContact = participants.some(
      (p) => p.toLowerCase().includes(contactKey.toLowerCase()) ||
             contactKey.toLowerCase().includes(p.toLowerCase())
    )
    return hasContact
  })

  const userMessages = contactMessages.filter((e) => e.metadata?.isUserMessage === true)
  const theirMessages = contactMessages.filter((e) => e.metadata?.isUserMessage === false)

  // Step 2: Keyword matching on user's messages
  const evidence: Array<{ timestamp: string; text: string; isUserMessage: boolean }> = []
  const contradictions: Array<{ timestamp: string; text: string }> = []

  for (const msg of userMessages) {
    const text = (msg.text ?? '').toLowerCase()
    const hasMatch = expandedTopics.some((kw) => text.includes(kw.toLowerCase()))

    if (hasMatch) {
      evidence.push({
        timestamp: msg.createdAt ?? 'unknown',
        text: msg.text ?? '',
        isUserMessage: true,
      })

      // Check for contradiction markers
      if (
        text.includes("haven't told") ||
        text.includes("didn't tell") ||
        text.includes("not sure if i mentioned") ||
        text.includes("keep this between us")
      ) {
        contradictions.push({
          timestamp: msg.createdAt ?? 'unknown',
          text: msg.text ?? '',
        })
      }
    }
  }

  // Step 3: Check knowledge deltas from memory store (if available)
  if (memoryStore) {
    const chunks = getChunksByContact(memoryStore, contactKey)
    for (const chunk of chunks) {
      for (const delta of chunk.knowledgeDeltas ?? []) {
        const deltaTopicMatch = expandedTopics.some(
          (kw) => delta.topic.toLowerCase().includes(kw.toLowerCase())
        )

        if (deltaTopicMatch && delta.status === 'disclosed') {
          // Found explicit disclosure in knowledge deltas
          if (delta.evidence && !evidence.some((e) => e.text === delta.evidence)) {
            evidence.push({
              timestamp: delta.date,
              text: delta.evidence,
              isUserMessage: true,
            })
          }
        }

        if (deltaTopicMatch && delta.status === 'hinted') {
          notes.push(`Indirect mention on ${delta.date}: "${delta.evidence}"`)
        }

        if (deltaTopicMatch && delta.status === 'contradicted') {
          contradictions.push({
            timestamp: delta.date,
            text: delta.evidence ?? 'contradicting statement',
          })
        }
      }
    }
  }

  // Step 4: Check for acknowledgment signals
  const ack = detectAcknowledgment(theirMessages, expandedTopics)

  // Step 5: Determine status
  let status: DisclosureResult['status']
  let answer: string

  if (evidence.length === 0) {
    status = 'none'
    answer = `No evidence found that you told ${contactKey} about ${topic}.`
    notes.push('No matching messages found')
  } else if (contradictions.length > 0) {
    status = 'conflicting'
    answer = `You mentioned ${topic} to ${contactKey}, but there are conflicting statements.`
    notes.push(`${contradictions.length} contradiction(s) found`)
  } else if (evidence.length === 1 && evidence[0].text.length < 50) {
    status = 'weak'
    answer = `There is weak evidence you mentioned ${topic} to ${contactKey}.`
    notes.push('Only one brief mention found')
  } else {
    status = 'confirmed'
    answer = `There is clear evidence you told ${contactKey} about ${topic}.`
    if (evidence.length > 1) {
      notes.push(`${evidence.length} mention(s) found`)
    }
  }

  // Step 6: Add acknowledgment to answer if detected
  if (ack.acknowledged) {
    answer += ` ${contactKey} later referenced it, suggesting they were aware.`
    notes.push('Contact acknowledged the topic')
  }

  // Step 7: Calculate confidence and spread
  const timestamps = evidence.map((e) => Date.parse(e.timestamp)).filter(Number.isFinite)
  const spreadAcrossTime = timestamps.length > 1
    ? (Math.max(...timestamps) - Math.min(...timestamps)) > 7 * 24 * 60 * 60 * 1000 // > 1 week
    : false

  if (spreadAcrossTime) {
    notes.push('Mentions spread across multiple weeks')
  }

  const confidence = calculateDisclosureConfidence(
    evidence.length,
    contradictions.length,
    ack.acknowledged,
    spreadAcrossTime
  )

  // Build evidence object
  const disclosureEvidence: DisclosureEvidence = {
    claim: `User told ${contactKey} about ${topic}`,
    contact: contactKey,
    topic,
    direction: evidence.length > 0 ? 'outgoing' : 'incoming',
    evidence,
    confidence,
    lastMentioned: evidence.length > 0
      ? evidence.sort((a, b) => b.timestamp.localeCompare(a.timestamp))[0].timestamp
      : '',
    mentionCount: evidence.length,
    spreadAcrossTime,
    contradictions,
    acknowledged: ack.acknowledged,
    ackEvidence: ack.evidence,
  }

  return {
    status,
    answer,
    evidence: disclosureEvidence,
    notes,
  }
}

/**
 * Calculate confidence for disclosure result
 * Deterministic calculation based on structural properties
 */
function calculateDisclosureConfidence(
  mentionCount: number,
  contradictionCount: number,
  acknowledged: boolean,
  spreadAcrossTime: boolean
): number {
  let score = 0.3 // base

  // More mentions = more confident
  if (mentionCount >= 3) score += 0.25
  else if (mentionCount >= 2) score += 0.15
  else if (mentionCount === 1) score += 0.05

  // Acknowledgment by contact = strong signal
  if (acknowledged) score += 0.2

  // Spread across time = more established
  if (spreadAcrossTime) score += 0.1

  // Contradictions reduce confidence
  score -= contradictionCount * 0.15

  return Math.max(0, Math.min(1, score))
}

/**
 * Build prompt for disclosure query
 * Forces structured output with evidence binding
 */
export function buildDisclosurePrompt(result: DisclosureResult): string {
  const evidenceText = result.evidence.evidence
    .map((e) => `[${e.timestamp}] ${e.text}`)
    .join('\n')

  const contradictionText = result.evidence.contradictions
    .map((c) => `[${c.timestamp}] ${c.text}`)
    .join('\n')

  const ackText = result.evidence.ackEvidence
    ?.map((a) => `[${a.timestamp}] ${a.text}`)
    .join('\n')

  return `You are answering: "Does ${result.evidence.contact} know about ${result.evidence.topic}?"

EVIDENCE STATUS: ${result.status.toUpperCase()}

EVIDENCE FOUND:
${evidenceText || '(none)'}

${contradictionText ? `CONTRADICTIONS:\n${contradictionText}\n` : ''}
${ackText ? `ACKNOWLEDGMENT BY CONTACT:\n${ackText}\n` : ''}
NOTES:
${result.notes.map((n) => `- ${n}`).join('\n')}

RULES:
1. Never answer binary yes/no
2. Distinguish: disclosed vs hinted vs absent
3. If conflicting evidence, report the conflict
4. If silence (no evidence), say "No evidence found" - NOT "They don't know"
5. If acknowledged by contact, note it as stronger confirmation

Provide a natural language answer (2-3 sentences) that:
- States the evidence clearly
- Notes any contradictions or ambiguities
- Avoids binary yes/no`
}
