/**
 * Cluster Memory System - MemPalace-inspired hierarchical memory
 * Wing: Contact | Room: Intent cluster | Closet: Summary | Drawer: Messages
 */

import type { IdentityEvent } from '../../types/identity.types.js'

export type MessageCluster = 'casual' | 'planning' | 'emotional' | 'professional' | 'other'

export type ClusterSummary = {
  cluster: MessageCluster
  messageCount: number
  summary: string
  topPhrases: string[]
  avgLength: number
  lastUpdated: string
}

export type ContactClusterMemory = {
  contactName: string
  clusters: Map<MessageCluster, ClusterSummary>
  lastUpdated: string
}

// Hall keywords for classification
const HALL_KEYWORDS: Record<MessageCluster, string[]> = {
  casual: ['lol', 'haha', 'omg', 'wtf', 'nice', 'cool', 'yeah', 'dude', 'hey', 'hi'],
  planning: ['meet', 'when', 'where', 'time', 'schedule', 'plan', 'tomorrow', 'tonight', 'lunch', 'dinner'],
  emotional: ['feel', 'stressed', 'happy', 'sad', 'sorry', 'worried', 'love', 'miss', 'upset', 'tired'],
  professional: ['work', 'job', 'meeting', 'client', 'project', 'deadline', 'email', 'business', 'career'],
  other: []
}

export function classifyMessage(text: string): MessageCluster {
  const lower = text.toLowerCase()
  const scores: Record<MessageCluster, number> = { casual: 0, planning: 0, emotional: 0, professional: 0, other: 0 }

  for (const [cluster, keywords] of Object.entries(HALL_KEYWORDS)) {
    for (const keyword of keywords) {
      if (lower.includes(keyword)) scores[cluster as MessageCluster]++
    }
  }

  if (/\d{1,2}:\d{2}/.test(lower)) scores.planning += 2
  if (/\b(mon|tue|wed|thu|fri|sat|sun)\b/.test(lower)) scores.planning += 2

  const entries = Object.entries(scores).filter(([k]) => k !== 'other')
  const maxScore = Math.max(...entries.map(([, s]) => s))
  if (maxScore === 0) return 'other'
  
  return entries.find(([_k, s]) => s === maxScore)?.[0] as MessageCluster || 'other'
}

export function buildContactClusterMemory(contactName: string, events: IdentityEvent[]): ContactClusterMemory {
  const clusters = new Map<MessageCluster, ClusterSummary>()
  const clusterTypes: MessageCluster[] = ['casual', 'planning', 'emotional', 'professional', 'other']
  
  const messagesByCluster: Record<MessageCluster, string[]> = { casual: [], planning: [], emotional: [], professional: [], other: [] }

  for (const event of events) {
    if (event.source !== 'sms') continue
    const text = (event.text ?? '').trim()
    if (text.length < 3) continue
    messagesByCluster[classifyMessage(text)].push(text)
  }

  for (const cluster of clusterTypes) {
    const messages = messagesByCluster[cluster]
    if (messages.length === 0) continue

    const avgLength = messages.reduce((a, m) => a + m.length, 0) / messages.length
    const topPhrases = extractTopPhrases(messages)
    
    clusters.set(cluster, {
      cluster,
      messageCount: messages.length,
      summary: generateClusterSummary(cluster, messages.length, avgLength, topPhrases),
      topPhrases,
      avgLength,
      lastUpdated: new Date().toISOString()
    })
  }

  return { contactName, clusters, lastUpdated: new Date().toISOString() }
}

function extractTopPhrases(messages: string[]): string[] {
  const phraseCounts = new Map<string, number>()
  for (const msg of messages) {
    const words = msg.toLowerCase().split(/\s+/).filter(w => w.length > 2)
    for (let i = 0; i < words.length - 1; i++) {
      const phrase = `${words[i]} ${words[i + 1]}`
      phraseCounts.set(phrase, (phraseCounts.get(phrase) || 0) + 1)
    }
  }
  return Array.from(phraseCounts.entries())
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([phrase]) => phrase)
}

function generateClusterSummary(cluster: MessageCluster, count: number, avgLength: number, topPhrases: string[]): string {
  const toneDescs: Record<MessageCluster, string> = {
    casual: 'relaxed, conversational banter',
    planning: 'making arrangements, scheduling',
    emotional: 'sharing feelings, providing support',
    professional: 'work-related matters, formal',
    other: 'mixed-purpose messages'
  }
  const lengthDesc = avgLength < 30 ? 'short' : avgLength < 80 ? 'medium' : 'detailed'
  let summary = `${count} ${lengthDesc} messages. ${toneDescs[cluster]}.`
  if (topPhrases.length > 0) summary += ` Common: "${topPhrases.slice(0, 3).join('", "')}".`
  return summary
}
