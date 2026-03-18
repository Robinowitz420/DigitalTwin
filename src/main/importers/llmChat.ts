import * as path from 'node:path'
import { readdir, readFile } from 'node:fs/promises'
import type { IdentityEvent } from '../../types/identity.types.js'

type JsonObj = Record<string, unknown>
type JsonArray = unknown[]

/**
 * Generic LLM conversation export importer.
 * Supports multiple formats:
 * - ChatGPT: conversations.json with mapping structure
 * - Claude: conversations.json with simple message array
 * - Generic: any JSON with messages/conversations array containing role/content
 */

async function listJsonFiles(dir: string): Promise<string[]> {
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
      else if (e.name.endsWith('.json')) out.push(full)
    }
  }
  return out
}

async function readJsonFile(filePath: string): Promise<unknown | null> {
  try {
    const raw = await readFile(filePath, 'utf8')
    return JSON.parse(raw)
  } catch {
    return null
  }
}

function toIsoDate(val: unknown): string | null {
  if (typeof val === 'string') {
    const d = new Date(val)
    return Number.isFinite(d.getTime()) ? d.toISOString() : null
  }
  if (typeof val === 'number') {
    // Could be seconds or milliseconds
    const ms = val > 1e12 ? val : val * 1000
    const d = new Date(ms)
    return Number.isFinite(d.getTime()) ? d.toISOString() : null
  }
  return null
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content
  if (typeof content === 'object' && content !== null) {
    // ChatGPT content.parts format
    if (Array.isArray((content as JsonObj)['parts'])) {
      const parts = (content as JsonObj)['parts'] as JsonArray
      return parts
        .map((p) => (typeof p === 'string' ? p : ''))
        .filter(Boolean)
        .join('\n')
    }
    // Some exports use 'text' field
    if (typeof (content as JsonObj)['text'] === 'string') {
      return (content as JsonObj)['text'] as string
    }
  }
  return ''
}

/**
 * Parse ChatGPT export format.
 * Structure: { mapping: { [id]: { message: { author: { role }, content, create_time } } } }
 */
function parseChatGPTFormat(json: JsonObj): IdentityEvent[] {
  const events: IdentityEvent[] = []
  const mapping = json['mapping'] as JsonObj | undefined
  if (!mapping || typeof mapping !== 'object') return events

  for (const node of Object.values(mapping)) {
    if (typeof node !== 'object' || node === null) continue
    const msg = (node as JsonObj)['message'] as JsonObj | undefined
    if (!msg || typeof msg !== 'object') continue

    const author = msg['author'] as JsonObj | undefined
    const role = typeof author?.['role'] === 'string' ? author['role'] : 'unknown'
    
    // Only import user messages (skip assistant messages)
    if (role !== 'user') continue

    const content = msg['content']
    const text = extractText(content)
    if (!text || text.length < 5) continue

    const createdAt = toIsoDate(msg['create_time'])
    const title = typeof msg['title'] === 'string' ? msg['title'] : undefined

    events.push({
      source: 'llm_chat',
      kind: 'message',
      text: text.slice(0, 8000),
      createdAt,
      participants: ['ChatGPT'],
      channel: 'chatgpt',
      externalId: typeof msg['id'] === 'string' ? msg['id'] : null,
      metadata: {
        role,
        title,
        isUserMessage: true,
      },
    })
  }

  return events
}

/**
 * Parse Claude export format.
 * Structure: { conversations: [ { messages: [ { role, content } ], created_at } ] }
 * Or simpler: [ { role, content, timestamp } ]
 */
function parseClaudeFormat(json: JsonObj | JsonArray): IdentityEvent[] {
  const events: IdentityEvent[] = []
  
  // Handle array at root
  const conversations = Array.isArray(json) 
    ? [json] 
    : (json['conversations'] as JsonArray | undefined) ?? [json]

  for (const conv of conversations) {
    if (typeof conv !== 'object' || conv === null) continue
    
    // Check if this is a flat message array
    const messages = Array.isArray(conv) 
      ? conv 
      : (conv as JsonObj)['messages'] as JsonArray | undefined
    
    if (!messages) continue

    const convName = typeof (conv as JsonObj)['name'] === 'string' 
      ? (conv as JsonObj)['name'] as string 
      : 'Claude Chat'
    const convCreatedAt = toIsoDate((conv as JsonObj)['created_at'])

    for (const msg of messages) {
      if (typeof msg !== 'object' || msg === null) continue
      const msgObj = msg as JsonObj
      
      const role = typeof msgObj['role'] === 'string' ? msgObj['role'] : 'unknown'
      
      // Only import user messages
      if (role !== 'user') continue

      const content = msgObj['content']
      const text = extractText(content)
      if (!text || text.length < 5) continue

      const createdAt = toIsoDate(msgObj['timestamp']) ?? toIsoDate(msgObj['created_at']) ?? convCreatedAt

      events.push({
        source: 'llm_chat',
        kind: 'message',
        text: text.slice(0, 8000),
        createdAt,
        participants: ['Claude'],
        channel: 'claude',
        externalId: null,
        metadata: {
          role,
          conversationName: convName,
          isUserMessage: true,
        },
      })
    }
  }

  return events
}

/**
 * Generic parser that tries to detect format and extract user messages.
 * Looks for common patterns: messages array, mapping object, conversations array.
 */
function parseGenericFormat(json: JsonObj | JsonArray): IdentityEvent[] {
  const events: IdentityEvent[] = []
  
  // Try ChatGPT format first
  if (typeof json === 'object' && !Array.isArray(json) && json['mapping']) {
    const chatGptEvents = parseChatGPTFormat(json as JsonObj)
    if (chatGptEvents.length > 0) return chatGptEvents
  }

  // Try Claude/conversations format
  if (Array.isArray(json) || (typeof json === 'object' && (json as JsonObj)['conversations'])) {
    const claudeEvents = parseClaudeFormat(json)
    if (claudeEvents.length > 0) return claudeEvents
  }

  // Generic: look for 'messages' array at root
  const messages = Array.isArray(json) 
    ? json 
    : (json as JsonObj)['messages'] as JsonArray | undefined
  
  if (!messages) return events

  for (const msg of messages) {
    if (typeof msg !== 'object' || msg === null) continue
    const msgObj = msg as JsonObj

    const role = typeof msgObj['role'] === 'string' ? msgObj['role'] : 'unknown'
    
    // Only import user messages
    if (role !== 'user') continue

    const content = msgObj['content']
    const text = extractText(content)
    if (!text || text.length < 5) continue

    const createdAt = toIsoDate(msgObj['timestamp']) ?? toIsoDate(msgObj['created_at']) ?? toIsoDate(msgObj['date'])

    events.push({
      source: 'llm_chat',
      kind: 'message',
      text: text.slice(0, 8000),
      createdAt,
      participants: ['LLM'],
      channel: typeof msgObj['model'] === 'string' ? msgObj['model'] as string : 'unknown',
      externalId: null,
      metadata: {
        role,
        isUserMessage: true,
      },
    })
  }

  return events
}

/**
 * Import LLM chat exports from a folder.
 * Searches for conversations.json or any JSON files.
 * Returns IdentityEvents for user messages only.
 */
export async function importLLMChatsFromFolder(folderPath: string): Promise<IdentityEvent[]> {
  const files = await listJsonFiles(folderPath)
  const allEvents: IdentityEvent[] = []

  // Prioritize conversations.json
  const prioritized = files.sort((a, b) => {
    const aName = path.basename(a).toLowerCase()
    const bName = path.basename(b).toLowerCase()
    if (aName === 'conversations.json') return -1
    if (bName === 'conversations.json') return 1
    return 0
  })

  for (const file of prioritized) {
    const json = await readJsonFile(file)
    if (!json) continue

    const events = parseGenericFormat(json as JsonObj | JsonArray)
    allEvents.push(...events)
  }

  // Sort by date descending
  allEvents.sort((a, b) => {
    if (!a.createdAt) return 1
    if (!b.createdAt) return -1
    return b.createdAt.localeCompare(a.createdAt)
  })

  return allEvents
}
