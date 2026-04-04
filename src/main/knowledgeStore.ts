/**
 * Knowledge Store - Persists extracted facts about the user's life
 *
 * Stores entities (people, places, events, etc.) with entity resolution
 * to link mentions across conversations (e.g., "Sarah" = "my sister Sarah")
 */

import * as path from 'node:path'
import { readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { app } from 'electron'
import type { IdentitySource } from '../types/identity.types.js'

export type EntityType = 
  | 'person' 
  | 'place' 
  | 'event' 
  | 'work' 
  | 'health' 
  | 'relationship' 
  | 'hobby' 
  | 'opinion' 
  | 'possession' 
  | 'education' 
  | 'travel'
  | 'pet'
  | 'project'

export type KnowledgeEntity = {
  id: string
  type: EntityType
  canonicalName: string           // Resolved name: "Sarah"
  aliases: string[]               // ["my sister", "Sarah", "sis", "my sister Sarah"]
  attributes: Record<string, unknown>  // Type-specific data
  firstMentioned: string          // ISO date
  lastUpdated: string             // ISO date
  lastMentioned: string           // When last referenced
  sources: Array<{
    source: IdentitySource
    date: string
    context: string               // Snippet of conversation
    contactName?: string          // Who the user was talking to
  }>
  confidence: number              // 0-1, based on mention count and consistency
  mentionCount: number
  relatedEntities: string[]       // IDs of related entities
  status: 'active' | 'historical' | 'uncertain'
}

export type KnowledgeStore = {
  version: number
  lastProcessed: string
  entities: KnowledgeEntity[]
  entityIndex: Record<string, string>  // lowercase alias -> entityId
  stats: {
    totalEntities: number
    byType: Record<EntityType, number>
    lastUpdated: string
  }
}

const CURRENT_VERSION = 1
const STORE_FILENAME = 'knowledge.store.json'

function getStorePath(): string {
  const userData = app.getPath('userData')
  return path.join(userData, STORE_FILENAME)
}

function generateEntityId(): string {
  return `ent_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
}

export async function loadKnowledgeStore(): Promise<KnowledgeStore> {
  const storePath = getStorePath()

  if (!existsSync(storePath)) {
    return {
      version: CURRENT_VERSION,
      lastProcessed: new Date(0).toISOString(),
      entities: [],
      entityIndex: {},
      stats: {
        totalEntities: 0,
        byType: {} as Record<EntityType, number>,
        lastUpdated: new Date().toISOString(),
      },
    }
  }

  try {
    const raw = await readFile(storePath, 'utf-8')
    const store = JSON.parse(raw) as KnowledgeStore
    
    // Ensure entityIndex exists (migration from v1)
    if (!store.entityIndex) {
      store.entityIndex = buildEntityIndex(store.entities)
    }
    if (!store.stats) {
      store.stats = computeStats(store.entities)
    }
    
    return store
  } catch (e) {
    console.error('[KnowledgeStore] Failed to load, creating fresh store:', e)
    return {
      version: CURRENT_VERSION,
      lastProcessed: new Date(0).toISOString(),
      entities: [],
      entityIndex: {},
      stats: {
        totalEntities: 0,
        byType: {} as Record<EntityType, number>,
        lastUpdated: new Date().toISOString(),
      },
    }
  }
}

export async function saveKnowledgeStore(store: KnowledgeStore): Promise<void> {
  const storePath = getStorePath()
  store.stats = computeStats(store.entities)
  store.entityIndex = buildEntityIndex(store.entities)
  await writeFile(storePath, JSON.stringify(store, null, 2))
}

function buildEntityIndex(entities: KnowledgeEntity[]): Record<string, string> {
  const index: Record<string, string> = {}
  for (const entity of entities) {
    // Index canonical name
    index[entity.canonicalName.toLowerCase()] = entity.id
    // Index all aliases
    for (const alias of entity.aliases) {
      const normalized = alias.toLowerCase().trim()
      if (normalized.length >= 2) {
        index[normalized] = entity.id
      }
    }
  }
  return index
}

function computeStats(entities: KnowledgeEntity[]): KnowledgeStore['stats'] {
  const byType: Record<EntityType, number> = {} as Record<EntityType, number>
  for (const entity of entities) {
    byType[entity.type] = (byType[entity.type] || 0) + 1
  }
  return {
    totalEntities: entities.length,
    byType,
    lastUpdated: new Date().toISOString(),
  }
}

/**
 * Look up an entity by name or alias
 */
export function findEntity(
  store: KnowledgeStore, 
  name: string
): KnowledgeEntity | undefined {
  const normalized = name.toLowerCase().trim()
  const id = store.entityIndex[normalized]
  if (id) {
    return store.entities.find(e => e.id === id)
  }
  return undefined
}

/**
 * Find entities by type
 */
export function findEntitiesByType(
  store: KnowledgeStore,
  type: EntityType
): KnowledgeEntity[] {
  return store.entities.filter(e => e.type === type)
}

/**
 * Find entities mentioned with a specific contact
 */
export function findEntitiesByContact(
  store: KnowledgeStore,
  contactName: string
): KnowledgeEntity[] {
  return store.entities.filter(e => 
    e.sources.some(s => s.contactName === contactName)
  )
}

/**
 * Add a new entity or update existing one
 */
export async function upsertEntity(
  store: KnowledgeStore,
  entity: Partial<KnowledgeEntity> & { 
    canonicalName: string
    type: EntityType 
  },
  source: {
    source: IdentitySource
    date: string
    context: string
    contactName?: string
  }
): Promise<KnowledgeEntity> {
  const now = new Date().toISOString()
  
  // Try to find existing entity
  let existing = findEntity(store, entity.canonicalName)
  
  // Also check aliases if provided
  if (!existing && entity.aliases) {
    for (const alias of entity.aliases) {
      existing = findEntity(store, alias)
      if (existing) break
    }
  }
  
  if (existing) {
    // Merge with existing
    const merged = mergeEntity(existing, entity, source, now)
    const idx = store.entities.findIndex(e => e.id === existing!.id)
    store.entities[idx] = merged
    store.lastProcessed = now
    return merged
  } else {
    // Create new entity
    const newEntity: KnowledgeEntity = {
      id: generateEntityId(),
      type: entity.type,
      canonicalName: entity.canonicalName,
      aliases: entity.aliases || [],
      attributes: entity.attributes || {},
      firstMentioned: now,
      lastUpdated: now,
      lastMentioned: now,
      sources: [source],
      confidence: 0.5, // Start with medium confidence
      mentionCount: 1,
      relatedEntities: entity.relatedEntities || [],
      status: 'active',
    }
    store.entities.push(newEntity)
    store.lastProcessed = now
    return newEntity
  }
}

/**
 * Merge new data into existing entity
 */
function mergeEntity(
  existing: KnowledgeEntity,
  newData: Partial<KnowledgeEntity>,
  source: KnowledgeEntity['sources'][0],
  now: string
): KnowledgeEntity {
  // Merge aliases (dedupe)
  const mergedAliases = [...new Set([
    ...existing.aliases, 
    ...(newData.aliases || [])
  ])]
  
  // Merge attributes (new data overrides)
  const mergedAttributes = {
    ...existing.attributes,
    ...newData.attributes,
  }
  
  // Add source if not duplicate
  const sources = [...existing.sources]
  const isDuplicateSource = sources.some(s => 
    s.source === source.source && 
    s.date === source.date &&
    s.context === source.context
  )
  if (!isDuplicateSource) {
    sources.push(source)
  }
  
  // Increase confidence with more mentions (cap at 0.95)
  const newMentionCount = existing.mentionCount + 1
  const newConfidence = Math.min(0.95, 0.5 + (newMentionCount * 0.1))
  
  return {
    ...existing,
    aliases: mergedAliases,
    attributes: mergedAttributes,
    lastUpdated: now,
    lastMentioned: now,
    sources,
    confidence: newConfidence,
    mentionCount: newMentionCount,
    relatedEntities: [...new Set([...existing.relatedEntities, ...(newData.relatedEntities || [])])],
    status: newData.status || existing.status,
  }
}

/**
 * Link two entities (e.g., person A is sister of person B)
 */
export function linkEntities(
  store: KnowledgeStore,
  entityId1: string,
  entityId2: string
): void {
  const e1 = store.entities.find(e => e.id === entityId1)
  const e2 = store.entities.find(e => e.id === entityId2)
  
  if (e1 && e2) {
    if (!e1.relatedEntities.includes(entityId2)) {
      e1.relatedEntities.push(entityId2)
    }
    if (!e2.relatedEntities.includes(entityId1)) {
      e2.relatedEntities.push(entityId1)
    }
  }
}

/**
 * Get entities relevant to a topic (for prompt inclusion)
 */
export function getRelevantEntities(
  store: KnowledgeStore,
  topic: string,
  contactName?: string
): KnowledgeEntity[] {
  const topicLower = topic.toLowerCase()
  
  // Score entities by relevance
  const scored = store.entities
    .filter(e => e.status === 'active' && e.confidence >= 0.5)
    .map(e => {
      let score = 0
      
      // Direct name mention in topic
      if (topicLower.includes(e.canonicalName.toLowerCase())) {
        score += 10
      }
      
      // Alias mention in topic
      for (const alias of e.aliases) {
        if (topicLower.includes(alias.toLowerCase())) {
          score += 5
          break
        }
      }
      
      // Related to contact
      if (contactName && e.sources.some(s => s.contactName === contactName)) {
        score += 3
      }
      
      // Recent mention
      const daysSinceMention = (Date.now() - new Date(e.lastMentioned).getTime()) / (1000 * 60 * 60 * 24)
      if (daysSinceMention < 30) {
        score += 2
      }
      
      // High confidence
      score += e.confidence * 2
      
      // High mention count
      score += Math.min(e.mentionCount, 5)
      
      return { entity: e, score }
    })
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score)
  
  return scored.slice(0, 15).map(s => s.entity)
}

/**
 * Format entities for prompt inclusion
 */
export function formatEntitiesForPrompt(entities: KnowledgeEntity[]): string {
  if (entities.length === 0) return ''
  
  const lines: string[] = ['KNOWN FACTS ABOUT YOUR LIFE (use naturally if relevant):']
  
  // Group by type
  const grouped: Partial<Record<EntityType, KnowledgeEntity[]>> = {}
  for (const e of entities) {
    if (!grouped[e.type]) grouped[e.type] = []
    grouped[e.type]!.push(e)
  }
  
  // Format each type
  if (grouped.person?.length) {
    const people = grouped.person.map(e => {
      const rel = e.attributes.relationship ? ` (${e.attributes.relationship})` : ''
      return `${e.canonicalName}${rel}`
    }).join(', ')
    lines.push(`- People: ${people}`)
  }
  
  if (grouped.place?.length) {
    const places = grouped.place.map(e => {
      const ctx = e.attributes.context ? ` - ${e.attributes.context}` : ''
      return `${e.canonicalName}${ctx}`
    }).join(', ')
    lines.push(`- Places: ${places}`)
  }
  
  if (grouped.event?.length) {
    const events = grouped.event.map(e => {
      const when = e.attributes.date ? ` (${e.attributes.date})` : ''
      return `${e.canonicalName}${when}`
    }).join(', ')
    lines.push(`- Events: ${events}`)
  }
  
  if (grouped.work?.length) {
    const work = grouped.work.map(e => {
      const role = e.attributes.role ? ` as ${e.attributes.role}` : ''
      return `${e.canonicalName}${role}`
    }).join(', ')
    lines.push(`- Work: ${work}`)
  }
  
  if (grouped.health?.length) {
    const health = grouped.health.map(e => e.canonicalName).join(', ')
    lines.push(`- Health: ${health}`)
  }
  
  if (grouped.hobby?.length) {
    const hobbies = grouped.hobby.map(e => e.canonicalName).join(', ')
    lines.push(`- Interests: ${hobbies}`)
  }
  
  if (grouped.relationship?.length) {
    const rels = grouped.relationship.map(e => {
      const partner = e.attributes.partner ? ` with ${e.attributes.partner}` : ''
      return `${e.attributes.status}${partner}`
    }).join(', ')
    lines.push(`- Relationships: ${rels}`)
  }
  
  if (grouped.pet?.length) {
    const pets = grouped.pet.map(e => {
      const type = e.attributes.animalType ? ` (${e.attributes.animalType})` : ''
      return `${e.canonicalName}${type}`
    }).join(', ')
    lines.push(`- Pets: ${pets}`)
  }
  
  return lines.join('\n')
}

/**
 * Batch upsert entities from extraction
 */
export async function upsertEntities(
  store: KnowledgeStore,
  extractedEntities: Array<Partial<KnowledgeEntity> & { 
    canonicalName: string
    type: EntityType 
  }>,
  source: {
    source: IdentitySource
    date: string
    context: string
    contactName?: string
  }
): Promise<KnowledgeEntity[]> {
  const results: KnowledgeEntity[] = []
  for (const entity of extractedEntities) {
    const result = await upsertEntity(store, entity, source)
    results.push(result)
  }
  return results
}

/**
 * Get all entities (for UI display)
 */
export async function getAllEntities(): Promise<KnowledgeEntity[]> {
  const store = await loadKnowledgeStore()
  return store.entities
}

/**
 * Delete an entity
 */
export async function deleteEntity(store: KnowledgeStore, entityId: string): Promise<void> {
  const idx = store.entities.findIndex(e => e.id === entityId)
  if (idx !== -1) {
    store.entities.splice(idx, 1)
    store.lastProcessed = new Date().toISOString()
  }
}

/**
 * Clear all entities (for testing/reset)
 */
export async function clearKnowledgeStore(): Promise<void> {
  const storePath = getStorePath()
  if (existsSync(storePath)) {
    const empty: KnowledgeStore = {
      version: CURRENT_VERSION,
      lastProcessed: new Date(0).toISOString(),
      entities: [],
      entityIndex: {},
      stats: {
        totalEntities: 0,
        byType: {} as Record<EntityType, number>,
        lastUpdated: new Date().toISOString(),
      },
    }
    await writeFile(storePath, JSON.stringify(empty, null, 2))
  }
}
