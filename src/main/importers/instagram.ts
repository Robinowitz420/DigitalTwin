import * as path from 'node:path'
import { readdir, readFile } from 'node:fs/promises'
import type { IdentityEvent } from '../../types/identity.types.js'

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

function toIsoFromMs(ms: number): string | null {
  if (!Number.isFinite(ms)) return null
  const d = new Date(ms)
  return Number.isFinite(d.getTime()) ? d.toISOString() : null
}

/**
 * Parse Instagram message JSON format.
 * Example structure from message_1.json:
 * {
 *   "participants": [{ "name": "Meta AI" }, { "name": "Robin French" }],
 *   "messages": [
 *     {
 *       "sender_name": "Robin French",
 *       "timestamp_ms": 1719548909265,
 *       "content": "I have so much emotional upset..."
 *     }
 *   ]
 * }
 */
function parseInstagramMessages(
  json: JsonObj,
  conversationName: string,
): IdentityEvent[] {
  const events: IdentityEvent[] = []
  const messages = Array.isArray(json['messages']) ? json['messages'] : []
  const participants = Array.isArray(json['participants'])
    ? (json['participants'] as Array<{ name?: string }>).map((p) => p.name).filter((n): n is string => typeof n === 'string')
    : []

  for (const msg of messages) {
    if (typeof msg !== 'object' || msg === null) continue

    const senderName = typeof msg['sender_name'] === 'string' ? msg['sender_name'] : null
    const timestampMs = typeof msg['timestamp_ms'] === 'number' ? msg['timestamp_ms'] : null
    const content = typeof msg['content'] === 'string' ? msg['content'] : ''

    // Skip empty content (e.g., shared posts, images without captions)
    if (!content.trim()) continue

    const createdAt = timestampMs ? toIsoFromMs(timestampMs) : null
    const isUserMessage = senderName && participants.length > 0
      ? !senderName.toLowerCase().includes('meta ai') && 
        !senderName.toLowerCase().includes('instagram')
      : false

    events.push({
      source: 'instagram',
      kind: 'message',
      text: content.slice(0, 6000),
      createdAt,
      participants: participants.length > 0 ? participants.filter((p): p is string => Boolean(p)) : undefined,
      channel: 'dm',
      externalId: null,
      metadata: {
        senderName,
        conversationName,
        isUserMessage,
      },
    })
  }

  return events
}

/**
 * Parse Instagram comments JSON format.
 * Instagram comments are typically in:
 * - your_instagram_activity/comments.json
 * - your_instagram_activity/comments_1.json
 * 
 * Structure:
 * {
 *   "comments_media_comments": [
 *     {
 *       "string_map_data": {
 *         "Comment": { "href": "...", "value": "Great photo!", "timestamp": 1234567890 },
 *         "Title": { "href": "...", "value": "Post by username" }
 *       }
 *     }
 *   ]
 * }
 */
function parseInstagramComments(json: JsonObj): IdentityEvent[] {
  const events: IdentityEvent[] = []

  // Try different possible keys for comments
  const commentKeys = [
    'comments_media_comments',
    'comments',
    'media_comments',
  ]

  for (const key of commentKeys) {
    const comments = Array.isArray(json[key]) ? json[key] : []
    for (const item of comments) {
      if (typeof item !== 'object' || item === null) continue

      const stringData = item['string_map_data'] as Record<string, { value?: string; timestamp?: number; href?: string }> | undefined
      if (!stringData) continue

      const commentData = stringData['Comment'] || stringData['comment']
      const titleData = stringData['Title'] || stringData['title']

      const text = typeof commentData?.value === 'string' ? commentData.value : ''
      if (!text.trim()) continue

      const timestamp = typeof commentData?.timestamp === 'number' ? commentData.timestamp : null
      const createdAt = timestamp ? toIsoFromMs(timestamp * 1000) : null
      const href = typeof commentData?.href === 'string' ? commentData.href : null
      const postTitle = typeof titleData?.value === 'string' ? titleData.value : null

      events.push({
        source: 'instagram',
        kind: 'comment',
        text: text.slice(0, 2000),
        createdAt,
        channel: 'comment',
        externalId: null,
        metadata: {
          postTitle,
          url: href,
          isUserMessage: true, // These are user's own comments
        },
      })
    }
  }

  return events
}

/**
 * Import Instagram messages from a folder.
 * Expected folder structure: your_instagram_activity/messages/inbox/
 * Each subfolder contains message_1.json, message_2.json, etc.
 */
export async function importInstagramMessagesFromFolder(folderPath: string): Promise<IdentityEvent[]> {
  const allEvents: IdentityEvent[] = []
  const files = await listFilesRecursive(folderPath)

  // Find all message JSON files
  const messageFiles = files.filter((f) => {
    const basename = path.basename(f).toLowerCase()
    return basename.startsWith('message_') && basename.endsWith('.json')
  })

  for (const filePath of messageFiles) {
    const json = await readJsonMaybe(filePath)
    if (!json || typeof json !== 'object') continue

    // Extract conversation name from parent folder
    const parentDir = path.basename(path.dirname(filePath))
    const conversationName = parentDir.replace(/_/g, ' ')

    const events = parseInstagramMessages(json as JsonObj, conversationName)
    allEvents.push(...events)
  }

  // Sort by createdAt descending
  allEvents.sort((a, b) => {
    if (!a.createdAt) return 1
    if (!b.createdAt) return -1
    return a.createdAt < b.createdAt ? 1 : -1
  })

  return allEvents
}

/**
 * Import Instagram comments from a folder.
 * Expected: your_instagram_activity/comments folder or comments.json file
 */
export async function importInstagramCommentsFromFolder(folderPath: string): Promise<IdentityEvent[]> {
  const allEvents: IdentityEvent[] = []
  const files = await listFilesRecursive(folderPath)

  // Find comment JSON files
  const commentFiles = files.filter((f) => {
    const basename = path.basename(f).toLowerCase()
    return basename.includes('comment') && basename.endsWith('.json')
  })

  for (const filePath of commentFiles) {
    const json = await readJsonMaybe(filePath)
    if (!json || typeof json !== 'object') continue

    const events = parseInstagramComments(json as JsonObj)
    allEvents.push(...events)
  }

  // Sort by createdAt descending
  allEvents.sort((a, b) => {
    if (!a.createdAt) return 1
    if (!b.createdAt) return -1
    return a.createdAt < b.createdAt ? 1 : -1
  })

  return allEvents
}

/**
 * Import both Instagram messages and comments from a root folder.
 * Expected structure:
 * - your_instagram_activity/messages/inbox/... (messages)
 * - your_instagram_activity/comments/... (comments)
 */
export async function importInstagramAllFromFolder(rootPath: string): Promise<{
  messages: IdentityEvent[]
  comments: IdentityEvent[]
  total: number
}> {
  const messages = await importInstagramMessagesFromFolder(rootPath)
  const comments = await importInstagramCommentsFromFolder(rootPath)

  return {
    messages,
    comments,
    total: messages.length + comments.length,
  }
}
