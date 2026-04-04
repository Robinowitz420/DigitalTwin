/**
 * Conversation memory for Write Like Me sessions
 * Stores past conversations so the AI can remember context and users can correct mistakes
 */

import { app } from 'electron'
import * as path from 'node:path'
import { readFile, writeFile, mkdir } from 'node:fs/promises'

export type WriteAgentConversation = {
  id: string
  timestamp: string
  topic: string
  contactName?: string
  request: string
  response: string
  voiceMode: string
  corrections?: Array<{
    timestamp: string
    feedback: string
    updatedResponse?: string
  }>
  metadata?: {
    hadInsufficientData?: boolean
    dataNote?: string
  }
}

type ConversationStore = {
  conversations: WriteAgentConversation[]
  lastUpdated: string
}

const MAX_CONVERSATIONS = 100

async function getMemoryPath(): Promise<string> {
  const userData = app.getPath('userData')
  const dir = path.join(userData, 'write-agent-memory')
  await mkdir(dir, { recursive: true })
  return path.join(dir, 'conversations.json')
}

export async function loadConversations(): Promise<WriteAgentConversation[]> {
  try {
    const filePath = await getMemoryPath()
    const raw = await readFile(filePath, 'utf8')
    const store = JSON.parse(raw) as ConversationStore
    return store.conversations ?? []
  } catch {
    return []
  }
}

export async function saveConversation(conv: WriteAgentConversation): Promise<void> {
  const conversations = await loadConversations()
  
  // Add new conversation at the beginning
  conversations.unshift(conv)
  
  // Keep only last MAX_CONVERSATIONS
  const trimmed = conversations.slice(0, MAX_CONVERSATIONS)
  
  const filePath = await getMemoryPath()
  const store: ConversationStore = {
    conversations: trimmed,
    lastUpdated: new Date().toISOString(),
  }
  await writeFile(filePath, JSON.stringify(store, null, 2))
}

export async function updateConversation(
  id: string,
  update: Partial<Pick<WriteAgentConversation, 'corrections' | 'metadata'>>,
): Promise<WriteAgentConversation | null> {
  const conversations = await loadConversations()
  const idx = conversations.findIndex(c => c.id === id)
  if (idx === -1) return null
  
  conversations[idx] = {
    ...conversations[idx],
    ...update,
    corrections: update.corrections ?? conversations[idx].corrections,
    metadata: update.metadata ?? conversations[idx].metadata,
  }
  
  const filePath = await getMemoryPath()
  const store: ConversationStore = {
    conversations,
    lastUpdated: new Date().toISOString(),
  }
  await writeFile(filePath, JSON.stringify(store, null, 2))
  
  return conversations[idx]
}

export async function getRecentConversationsForContact(
  contactName: string,
  limit: number = 5,
): Promise<WriteAgentConversation[]> {
  const conversations = await loadConversations()
  return conversations
    .filter(c => c.contactName === contactName)
    .slice(0, limit)
}

export async function getRecentConversations(limit: number = 10): Promise<WriteAgentConversation[]> {
  const conversations = await loadConversations()
  return conversations.slice(0, limit)
}

/**
 * Format recent conversations for inclusion in the prompt
 */
export function formatConversationMemory(conversations: WriteAgentConversation[]): string {
  if (conversations.length === 0) return ''
  
  const lines: string[] = ['RECENT WRITE LIKE ME SESSIONS (for context):']
  
  for (const conv of conversations.slice(0, 5)) {
    const contact = conv.contactName ? ` (to ${conv.contactName})` : ''
    lines.push(`\n[${conv.timestamp}]${contact}`)
    lines.push(`User asked: "${conv.topic.slice(0, 100)}${conv.topic.length > 100 ? '...' : ''}"`)
    
    if (conv.corrections?.length) {
      lines.push(`User corrections: ${conv.corrections.map(c => c.feedback).join('; ')}`)
    }
    
    if (conv.metadata?.hadInsufficientData) {
      lines.push(`Note: ${conv.metadata.dataNote}`)
    }
  }
  
  return lines.join('\n')
}

/**
 * Add a correction to an existing conversation
 */
export async function addCorrection(
  conversationId: string,
  feedback: string,
  updatedResponse?: string,
): Promise<WriteAgentConversation | null> {
  const conversations = await loadConversations()
  const idx = conversations.findIndex(c => c.id === conversationId)
  if (idx === -1) return null
  
  const existing = conversations[idx]
  const corrections = existing.corrections ?? []
  
  corrections.push({
    timestamp: new Date().toISOString(),
    feedback,
    updatedResponse,
  })
  
  return updateConversation(conversationId, { corrections })
}

/**
 * Generate a unique conversation ID
 */
export function generateConversationId(): string {
  return `conv_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}
