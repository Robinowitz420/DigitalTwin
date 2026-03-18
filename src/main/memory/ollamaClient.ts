/**
 * Ollama Client - Local LLM for summarization, topic extraction, classification
 *
 * CORE PRINCIPLE: Ollama is ONLY used for:
 *   - summarization
 *   - topic extraction
 *   - light classification
 *
 * Ollama must NEVER be used for:
 *   - counting
 *   - ranking
 *   - exact lookup
 *   - returning raw messages as truth
 */

import type { SmsChunk } from './processor.js'
import { formatChunkForLLM } from './processor.js'

const OLLAMA_HOST = 'http://localhost:11434'
const DEFAULT_MODEL = 'llama3.2' // or 'mistral', 'llama3', etc.

/**
 * Knowledge Delta - tracks what user disclosed to a contact
 * Status meanings:
 * - disclosed: explicit statement ("I got a job at Stripe")
 * - hinted: indirect reference ("I've been working on something new")
 * - updated: new info about known topic ("I got the promotion!")
 * - contradicted: conflicts with earlier statement
 */
export type KnowledgeDelta = {
  topic: string
  status: 'disclosed' | 'hinted' | 'updated' | 'contradicted'
  date: string // ISO date when mentioned
  evidence?: string // brief quote supporting this
}

export type ChunkSummary = {
  summary: string
  topics: string[]
  notableEvents: string[]
  tone: string
  // Confidence + trace metadata for grounding
  confidence: number // 0-1, estimated quality of summary
  sourceRange: {
    contact: string
    start: string // ISO date
    end: string // ISO date
  }
  messageCount: number
  // Knowledge deltas - what user disclosed to this contact
  knowledgeDeltas: KnowledgeDelta[]
}

export type OllamaResponse = {
  model: string
  created_at: string
  response: string
  done: boolean
}

/**
 * Check if Ollama is running locally
 */
export async function isOllamaRunning(): Promise<boolean> {
  try {
    const res = await fetch(`${OLLAMA_HOST}/api/tags`, { method: 'GET' })
    return res.ok
  } catch {
    return false
  }
}

/**
 * Get available models from Ollama
 */
export async function getOllamaModels(): Promise<string[]> {
  try {
    const res = await fetch(`${OLLAMA_HOST}/api/tags`)
    if (!res.ok) return []
    const data = await res.json()
    return (data.models ?? []).map((m: { name: string }) => m.name)
  } catch {
    return []
  }
}

/**
 * Call Ollama generate API
 */
async function ollamaGenerate(prompt: string, model: string = DEFAULT_MODEL): Promise<string> {
  const res = await fetch(`${OLLAMA_HOST}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      prompt,
      stream: false,
      options: {
        temperature: 0.3, // Lower temperature for more deterministic summaries
        num_predict: 1024, // Limit output length
      },
    }),
  })

  if (!res.ok) {
    throw new Error(`Ollama request failed: ${res.status} ${res.statusText}`)
  }

  const data = (await res.json()) as OllamaResponse
  return data.response?.trim() ?? ''
}

/**
 * Summarize a single chunk of SMS messages
 * STRICT PROMPT RULES to prevent hallucination
 */
export async function summarizeChunk(chunk: SmsChunk, model?: string): Promise<ChunkSummary> {
  const chunkText = formatChunkForLLM(chunk)

  const prompt = `You are analyzing a chunk of SMS messages between the user and a contact.

IMPORTANT RULES - STRICT COMPLIANCE REQUIRED:
1. You ONLY have access to the messages shown below.
2. Do NOT invent details, names, or events not present in the messages.
3. If you are unsure about something, say "uncertain" rather than guessing.
4. Extract topics from the actual message content - do not fabricate topics.
5. Keep summaries factual and grounded in the evidence.
6. For KNOWLEDGE_DELTAS, only include topics where the USER is the speaker (Me:).

${chunkText}

Provide your analysis in this EXACT format:

SUMMARY: [2-3 sentences summarizing the conversation flow and key subjects]

TOPICS: [comma-separated list of 3-7 topics actually discussed]

NOTABLE_EVENTS: [comma-separated list of any significant events mentioned, or "none" if none]

TONE: [one of: casual, formal, emotional, practical, mixed]

KNOWLEDGE_DELTAS:
For each topic the user disclosed to this contact, output:
- TOPIC: [topic name]
- STATUS: [disclosed|hinted|updated|contradicted]
- DATE: [YYYY-MM-DD from message timestamp]
- EVIDENCE: [brief quote from user's message]
Only include topics where the user is the speaker. If none, output "none".

Do not add any other text.`

  try {
    const response = await ollamaGenerate(prompt, model)

    // Parse the structured response
    const summaryMatch = response.match(/SUMMARY:\s*(.+?)(?=TOPICS:|$)/s)
    const topicsMatch = response.match(/TOPICS:\s*(.+?)(?=NOTABLE_EVENTS:|$)/s)
    const eventsMatch = response.match(/NOTABLE_EVENTS:\s*(.+?)(?=TONE:|$)/s)
    const toneMatch = response.match(/TONE:\s*(.+?)(?=KNOWLEDGE_DELTAS:|$)/s)
    const deltasMatch = response.match(/KNOWLEDGE_DELTAS:\s*(.+?)$/s)

    const summary = summaryMatch?.[1]?.trim() ?? 'Unable to summarize'
    const topicsStr = topicsMatch?.[1]?.trim() ?? ''
    const eventsStr = eventsMatch?.[1]?.trim() ?? 'none'
    const tone = toneMatch?.[1]?.trim() ?? 'unknown'
    const deltasStr = deltasMatch?.[1]?.trim() ?? 'none'

    const topics = topicsStr
      .split(',')
      .map((t) => t.trim())
      .filter((t) => t.length > 0 && t !== 'none')

    const notableEvents = eventsStr
      .split(',')
      .map((e) => e.trim())
      .filter((e) => e.length > 0 && e !== 'none')

    // Parse knowledge deltas
    const knowledgeDeltas: KnowledgeDelta[] = []
    if (deltasStr.toLowerCase() !== 'none') {
      // Parse blocks like: - TOPIC: job\n- STATUS: disclosed\n- DATE: 2025-01-15\n- EVIDENCE: "I got the job"
      const deltaBlocks = deltasStr.split(/(?=- TOPIC:)/g).filter((b) => b.trim().length > 0)
      for (const block of deltaBlocks) {
        const topicMatch = block.match(/TOPIC:\s*(.+?)(?=- STATUS:|$)/s)
        const statusMatch = block.match(/STATUS:\s*(disclosed|hinted|updated|contradicted)/i)
        const dateMatch = block.match(/DATE:\s*(\d{4}-\d{2}-\d{2})/)
        const evidenceMatch = block.match(/EVIDENCE:\s*(.+?)(?=- TOPIC:|$)/s)

        if (topicMatch && statusMatch && dateMatch) {
          knowledgeDeltas.push({
            topic: topicMatch[1].trim(),
            status: statusMatch[1].toLowerCase() as KnowledgeDelta['status'],
            date: dateMatch[1],
            evidence: evidenceMatch?.[1]?.trim(),
          })
        }
      }
    }

    return {
      summary,
      topics,
      notableEvents,
      tone: tone.toLowerCase(),
      // Confidence + trace metadata
      confidence: calculateConfidence(chunk, summary, topics),
      sourceRange: {
        contact: chunk.contactKey,
        start: new Date(chunk.startTime).toISOString().slice(0, 10),
        end: new Date(chunk.endTime).toISOString().slice(0, 10),
      },
      messageCount: chunk.messageCount,
      knowledgeDeltas,
    }
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error)
    return {
      summary: `Error summarizing chunk: ${details}`,
      topics: [],
      notableEvents: [],
      tone: 'unknown',
      confidence: 0,
      sourceRange: {
        contact: chunk.contactKey,
        start: new Date(chunk.startTime).toISOString().slice(0, 10),
        end: new Date(chunk.endTime).toISOString().slice(0, 10),
      },
      messageCount: chunk.messageCount,
      knowledgeDeltas: [],
    }
  }
}

/**
 * Calculate confidence score for a summary
 * Based on: message count, summary length, topic count, presence of "uncertain"
 */
function calculateConfidence(chunk: SmsChunk, summary: string, topics: string[]): number {
  let score = 0.5 // base

  // More messages = more confident
  if (chunk.messageCount >= 50) score += 0.15
  else if (chunk.messageCount >= 20) score += 0.1
  else if (chunk.messageCount < 10) score -= 0.1

  // Reasonable summary length
  if (summary.length >= 50 && summary.length <= 500) score += 0.1

  // Topics extracted
  if (topics.length >= 2 && topics.length <= 7) score += 0.1

  // Uncertainty markers reduce confidence
  if (summary.toLowerCase().includes('uncertain') || summary.toLowerCase().includes('unclear')) {
    score -= 0.15
  }

  // Error indicators
  if (summary.includes('Error') || summary.includes('Unable to')) {
    score = 0.1
  }

  return Math.max(0, Math.min(1, score))
}

/**
 * Generate a meta-summary from multiple chunk summaries
 */
export async function summarizeMeta(
  contactKey: string,
  summaries: ChunkSummary[],
  model?: string
): Promise<string> {
  if (summaries.length === 0) {
    return `No conversation history with ${contactKey}.`
  }

  if (summaries.length === 1) {
    return summaries[0].summary
  }

  const summariesText = summaries
    .map((s, i) => `[${i + 1}] ${s.summary} (Topics: ${s.topics.join(', ')})`)
    .join('\n')

  const prompt = `You are creating a meta-summary of multiple conversation chunks with the same contact.

IMPORTANT RULES:
1. Only use information from the chunk summaries below.
2. Do not invent details not present in the summaries.
3. If information is missing or uncertain, say so.
4. Identify patterns and how the relationship evolved over time.

CONTACT: ${contactKey}

CHUNK SUMMARIES:
${summariesText}

Provide a concise meta-summary (3-5 sentences) that:
1. Describes the overall relationship/nature of contact
2. Identifies recurring themes
3. Notes any evolution or changes over time
4. Highlights the most significant topics

Do not add any other text.`

  try {
    return await ollamaGenerate(prompt, model)
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error)
    return `Error generating meta-summary: ${details}`
  }
}

/**
 * Extract knowledge state for a contact (topics mentioned, last mentioned, quotes)
 * This is a lighter-weight operation than full summarization
 */
export async function extractKnowledgeState(
  contactKey: string,
  chunks: SmsChunk[],
  model?: string
): Promise<{
  topics: Array<{ topic: string; lastMentioned: string; quote: string }>
}> {
  // Gather all messages for this contact
  const allMessages = chunks.flatMap((c) => c.messages)

  if (allMessages.length === 0) {
    return { topics: [] }
  }

  // Sample recent messages for topic extraction
  const recentMessages = allMessages.slice(-50)
  const messagesText = recentMessages
    .map((e) => {
      const ts = e.createdAt?.slice(0, 10) ?? 'no date'
      const txt = (e.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 300)
      return `[${ts}] ${txt}`
    })
    .join('\n')

  const prompt = `You are extracting topics from recent messages with a contact.

IMPORTANT RULES:
1. Only extract topics that are clearly present in the messages.
2. For each topic, provide a short supporting quote.
3. Do not invent topics or quotes.

CONTACT: ${contactKey}

RECENT MESSAGES:
${messagesText}

List up to 5 topics discussed. Format each as:
TOPIC: [topic name]
LAST_MENTIONED: [approximate date from messages]
QUOTE: [short quote supporting this topic]

If no clear topics, respond with: NO_TOPICS`

  try {
    const response = await ollamaGenerate(prompt, model)

    if (response.includes('NO_TOPICS')) {
      return { topics: [] }
    }

    const topics: Array<{ topic: string; lastMentioned: string; quote: string }> = []
    const topicRegex = /TOPIC:\s*(.+?)\nLAST_MENTIONED:\s*(.+?)\nQUOTE:\s*(.+?)(?=TOPIC:|$)/gs

    let match
    while ((match = topicRegex.exec(response)) !== null) {
      topics.push({
        topic: match[1].trim(),
        lastMentioned: match[2].trim(),
        quote: match[3].trim(),
      })
    }

    return { topics: topics.slice(0, 5) }
  } catch (error) {
    return { topics: [] }
  }
}
