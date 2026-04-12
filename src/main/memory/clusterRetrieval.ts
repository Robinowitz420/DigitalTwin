/**
 * Cluster-based Routed Retrieval - MemPalace-style memory routing
 * Route: contact (wing) → intent cluster (room) → messages (drawer)
 */

import type { IdentityEvent } from '../../types/identity.types.js'
import { classifyMessage, buildContactClusterMemory, type ContactClusterMemory, type MessageCluster } from './clusterMemory.js'

export type ClusterRetrievalResult = {
  messages: string[]
  cluster: MessageCluster
  clusterSummary: string
  confidence: number
  stats: {
    totalCandidates: number
    clusterMatches: number
    finalCount: number
  }
}

/**
 * Retrieve messages with cluster routing (MemPalace-style)
 * 1. Classify topic to determine target cluster
 * 2. Get cluster summary for context
 * 3. Score messages: cluster match + topic relevance + recency
 * 4. Return with cluster metadata for prompt injection
 */
export function retrieveWithClusterRouting(
  events: IdentityEvent[],
  contactName: string,
  topic: string,
  clusterMemory?: ContactClusterMemory,
  options?: {
    preferredCluster?: MessageCluster
    maxMessages?: number
    minScore?: number
  }
): ClusterRetrievalResult {
  const maxMessages = options?.maxMessages ?? 50
  const minScore = options?.minScore ?? 0.5

  // Step 1: Determine target cluster from topic
  const targetCluster = options?.preferredCluster || classifyMessage(topic)
  
  // Step 2: Get cluster summary
  const clusterSummary = clusterMemory?.clusters.get(targetCluster)?.summary || 
    `${targetCluster} messages with ${contactName}`

  // Step 3: Filter events by contact
  const normalize = (s: string) => s.toLowerCase().replace(/[^a-z]/g, '')
  const targetNorm = normalize(contactName)
  
  const contactEvents = events.filter(e => {
    if (e.source !== 'sms') return false
    return e.participants?.some(p => normalize(p).includes(targetNorm) || targetNorm.includes(normalize(p)))
  })

  const totalCandidates = contactEvents.length

  // Step 4: Score messages
  const topicTokens = topic.toLowerCase().split(/\s+/).filter(t => t.length >= 3)
  
  const scored = contactEvents
    .map(e => {
      const text = (e.text ?? '').trim()
      if (text.length < 5) return null

      // Cluster match score (0-4 points)
      const msgCluster = classifyMessage(text)
      const clusterScore = msgCluster === targetCluster ? 4 : 
                          msgCluster === 'other' ? 1 : 0

      // Topic relevance (0-3 points)
      const lower = text.toLowerCase()
      const topicOverlap = topicTokens.reduce((acc, t) => acc + (lower.includes(t) ? 1 : 0), 0)
      const topicScore = Math.min(3, topicOverlap)

      // Length quality (0-2 points)
      const len = text.length
      const lengthScore = len < 20 ? 0.5 : len < 150 ? 2 : len < 400 ? 1.5 : 0.8

      // Recency (0-1 point)
      const ts = e.createdAt ? Date.parse(e.createdAt) : NaN
      const recencyScore = Number.isFinite(ts) ? Math.min(1, (ts / Date.now()) * 1) : 0

      const score = clusterScore + topicScore + lengthScore + recencyScore

      return { text: text.slice(0, 600), score, cluster: msgCluster, hasTopicMatch: topicOverlap > 0 }
    })
    .filter((x): x is { text: string; score: number; cluster: MessageCluster; hasTopicMatch: boolean } => x != null)
    .sort((a, b) => b.score - a.score)

  const clusterMatches = scored.filter(x => x.cluster === targetCluster).length

  // Step 5: Filter by score threshold and dedupe
  const seen = new Set<string>()
  const results: string[] = []
  
  for (const item of scored) {
    if (item.score < minScore) continue
    const key = item.text.toLowerCase().replace(/\s+/g, ' ').slice(0, 100)
    if (seen.has(key)) continue
    seen.add(key)
    results.push(item.text)
    if (results.length >= maxMessages) break
  }

  // Calculate confidence based on cluster purity
  const confidence = clusterMatches / Math.max(1, results.length)

  return {
    messages: results,
    cluster: targetCluster,
    clusterSummary,
    confidence,
    stats: { totalCandidates, clusterMatches, finalCount: results.length }
  }
}

/**
 * Build cluster memory for all contacts in timeline
 */
export function buildAllContactClusters(
  events: IdentityEvent[]
): Map<string, ContactClusterMemory> {
  const contactEvents = new Map<string, IdentityEvent[]>()

  // Group events by contact
  for (const event of events) {
    if (event.source !== 'sms') continue
    for (const participant of (event.participants || [])) {
      if (!contactEvents.has(participant)) {
        contactEvents.set(participant, [])
      }
      contactEvents.get(participant)!.push(event)
    }
  }

  // Build cluster memory for each contact
  const result = new Map<string, ContactClusterMemory>()
  for (const [contact, evs] of contactEvents) {
    result.set(contact, buildContactClusterMemory(contact, evs))
  }

  return result
}

/**
 * Format cluster summary for prompt injection
 */
export function formatClusterForPrompt(clusterResult: ClusterRetrievalResult): string {
  return `CONVERSATION CONTEXT WITH THIS CONTACT:
Primary interaction style: ${clusterResult.cluster}
Summary: ${clusterResult.clusterSummary}
Retrieval confidence: ${Math.round(clusterResult.confidence * 100)}%
(Messages retrieved: ${clusterResult.stats.finalCount} from ${clusterResult.stats.clusterMatches} ${clusterResult.cluster} matches)`
}
