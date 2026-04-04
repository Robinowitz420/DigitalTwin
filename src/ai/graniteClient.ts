/**
 * IBM Granite client via watsonx API
 * Used for voice training and per-contact style analysis
 */

import type { VoiceProfile, PerContactVoiceProfile } from '../analysis/voiceAnalyzer.js'

// watsonx API configuration
type WatsonxConfig = {
  apiKey: string
  projectId: string
  modelId?: string
  endpoint?: string
}

// Granite model options
export const GRANITE_MODELS = {
  'granite-7b-instruct': 'ibm/granite-7b-instruct',
  'granite-13b-instruct': 'ibm/granite-13b-instruct',
  'granite-20b-instruct': 'ibm/granite-20b-instruct',
} as const

type GraniteModelId = keyof typeof GRANITE_MODELS

// Response from watsonx text generation
type WatsonxResponse = {
  model_id: string
  created_at: string
  results: Array<{
    generated_token_count: number
    input_token_count: number
    generated_text: string
  }>
}

// Style distillation from a chunk of writing samples
type ChunkStyleDistillation = {
  observations: {
    tone: string
    vocabulary: string
    punctuation: string
    structure: string
  }
  rules: string[]
  common_phrases: string[]
  do: string[]
  dont: string[]
}

// Per-contact conversation summary
type ContactConversationSummary = {
  contactName: string
  relationshipType: 'close_friend' | 'friend' | 'family' | 'acquaintance' | 'professional' | 'unknown'
  relationshipNarrative: string
  userStyleNarrative: string
  contactStyleNarrative: string
  sharedJokes: string[]
  recurringTopics: string[]
  tonePatterns: string[]
  notableExchanges: string[]
}

// Extracted fact from a conversation
export type ExtractedFact = {
  type: 'person' | 'place' | 'event' | 'work' | 'health' | 'relationship' | 'hobby' | 'opinion' | 'possession' | 'education' | 'travel' | 'pet' | 'project'
  canonicalName: string
  aliases: string[]
  attributes: Record<string, unknown>
  confidence: number
  relatedTo?: string[]
}

class GraniteClient {
  private apiKey: string
  private projectId: string
  private modelId: string
  private endpoint: string
  private accessToken: string | null = null
  private tokenExpiresAt: number = 0

  constructor(config: WatsonxConfig) {
    this.apiKey = config.apiKey
    this.projectId = config.projectId
    this.modelId = config.modelId ?? GRANITE_MODELS['granite-13b-instruct']
    this.endpoint = config.endpoint ?? 'https://us-south.ml.cloud.ibm.com'
  }

  /**
   * Get IAM token for watsonx API authentication
   */
  private async getAccessToken(): Promise<string> {
    // Reuse token if still valid (tokens last ~1 hour)
    if (this.accessToken && Date.now() < this.tokenExpiresAt - 60000) {
      return this.accessToken
    }

    const response = await fetch('https://iam.cloud.ibm.com/identity/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: `grant_type=urn:ibm:params:oauth:grant-type:apikey&apikey=${this.apiKey}`,
    })

    if (!response.ok) {
      throw new Error(`Failed to get IAM token: ${response.status} ${response.statusText}`)
    }

    const data = await response.json() as { access_token: string; expires_in: number }
    this.accessToken = data.access_token
    this.tokenExpiresAt = Date.now() + (data.expires_in * 1000)
    return this.accessToken
  }

  /**
   * Generate text using Granite model
   */
  async generate(prompt: string, options?: {
    maxTokens?: number
    temperature?: number
    topP?: number
    stopSequences?: string[]
  }): Promise<string> {
    const token = await this.getAccessToken()

    const body = {
      model_id: this.modelId,
      project_id: this.projectId,
      input: prompt,
      parameters: {
        max_new_tokens: options?.maxTokens ?? 2048,
        temperature: options?.temperature ?? 0.3,
        top_p: options?.topP ?? 0.9,
        stop_sequences: options?.stopSequences ?? [],
        return_options: {
          input_tokens: false,
          generated_tokens: false,
        },
      },
    }

    const response = await fetch(`${this.endpoint}/ml/v1/text/generation?version=2024-01-10`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify(body),
    })

    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(`Granite generation failed: ${response.status} ${errorText}`)
    }

    const data = await response.json() as WatsonxResponse
    return data.results?.[0]?.generated_text ?? ''
  }

  /**
   * Generate JSON response using Granite
   */
  async generateJson<T>(prompt: string, options?: {
    maxTokens?: number
    temperature?: number
  }): Promise<T | null> {
    const raw = await this.generate(prompt, {
      maxTokens: options?.maxTokens ?? 4096,
      temperature: options?.temperature ?? 0.2,
    })

    // Extract JSON from response
    const jsonMatch = raw.match(/\{[\s\S]*\}/)
    if (!jsonMatch) {
      console.warn('[Granite] No JSON found in response:', raw.slice(0, 200))
      return null
    }

    try {
      return JSON.parse(jsonMatch[0]) as T
    } catch (e) {
      console.warn('[Granite] Failed to parse JSON:', e)
      return null
    }
  }

  /**
   * Analyze a chunk of writing samples and distill style
   */
  async analyzeWritingChunk(samples: string[]): Promise<ChunkStyleDistillation | null> {
    const samplesText = samples
      .map((s, i) => `#${i + 1}\n${s}`)
      .join('\n\n---\n\n')

    const prompt = `You are a writing-style analyst. Analyze the user's writing samples below and extract a compact style distillation. Return ONLY valid JSON.

Schema:
{
  "observations": {
    "tone": "string describing overall tone",
    "vocabulary": "string describing vocabulary level and patterns",
    "punctuation": "string describing punctuation habits",
    "structure": "string describing sentence/paragraph structure"
  },
  "rules": ["array of style rules extracted from samples"],
  "common_phrases": ["array of phrases the user frequently uses"],
  "do": ["array of things to do when imitating this voice"],
  "dont": ["array of things to avoid when imitating this voice"]
}

Writing samples:
${samplesText}`

    return this.generateJson<ChunkStyleDistillation>(prompt)
  }

  /**
   * Analyze a conversation with a specific contact and create a summary
   */
  async analyzeContactConversation(params: {
    contactName: string
    userMessages: string[]
    contactMessages: string[]
    allMessages: Array<{ from: 'user' | 'contact'; text: string; timestamp?: string }>
  }): Promise<ContactConversationSummary | null> {
    const { contactName, userMessages, contactMessages, allMessages } = params

    // Format conversation for analysis
    const conversationText = allMessages
      .slice(-100) // Last 100 messages
      .map(m => `[${m.timestamp ?? 'unknown'}] ${m.from === 'user' ? 'Me' : contactName}: ${m.text}`)
      .join('\n')

    const prompt = `You are analyzing a text message conversation between the user and their contact "${contactName}". Create a comprehensive summary of their communication style and relationship.

Return ONLY valid JSON following this schema:
{
  "contactName": "${contactName}",
  "relationshipType": "close_friend|friend|family|acquaintance|professional|unknown",
  "relationshipNarrative": "2-3 sentences describing the nature of this relationship",
  "userStyleNarrative": "2-3 sentences describing how the user communicates with this specific person",
  "contactStyleNarrative": "2-3 sentences describing the contact's communication style",
  "sharedJokes": ["array of inside jokes or recurring phrases between them"],
  "recurringTopics": ["array of topics they frequently discuss"],
  "tonePatterns": ["array of tone patterns observed (e.g., 'playful teasing', 'supportive', 'casual')"],
  "notableExchanges": ["array of notable conversation snippets that capture their dynamic"]
}

Conversation history:
${conversationText}

User's messages to ${contactName} (sample):
${userMessages.slice(-20).join('\n')}

${contactName}'s messages (sample):
${contactMessages.slice(-10).join('\n')}`

    return this.generateJson<ContactConversationSummary>(prompt)
  }

  /**
   * Consolidate multiple chunk analyses into a final voice profile
   */
  async consolidateVoiceProfile(params: {
    chunkSummaries: ChunkStyleDistillation[]
    localBaseline: Partial<VoiceProfile>
    totalSamples: number
  }): Promise<Partial<VoiceProfile> | null> {
    const { chunkSummaries, localBaseline, totalSamples } = params

    const prompt = `You are consolidating multiple writing-style analyses into ONE comprehensive voice profile. Return ONLY valid JSON.

Schema:
{
  "avgLength": number,
  "medianLength": number,
  "totalComments": number,
  "commonPhrases": [{"phrase": string, "frequency": number}],
  "signatureWords": [{"word": string, "frequency": number}],
  "toneScores": {"casual": number, "formal": number, "humorous": number, "serious": number, "passionate": number},
  "punctuationStyle": {"exclamationsPerComment": number, "questionsPerComment": number, "ellipsesPerComment": number, "emDashesPerComment": number},
  "vocabularyLevel": "simple|moderate|advanced|technical",
  "avgWordsPerSentence": number,
  "complexSentenceRatio": number,
  "starterPhrases": [{"phrase": string, "count": number}],
  "closingPhrases": [{"phrase": string, "count": number}],
  "styleNarrative": "A 300-500 word narrative description of this person's writing style, covering tone, vocabulary, punctuation, typical structures, and unique characteristics"
}

Partial analyses from ${chunkSummaries.length} chunks:
${JSON.stringify(chunkSummaries, null, 2).slice(0, 100000)}

Dataset stats:
- Total samples: ${totalSamples}
- Baseline avgLength: ${localBaseline.avgLength ?? 'unknown'}
- Baseline medianLength: ${localBaseline.medianLength ?? 'unknown'}

Create a comprehensive profile that captures the user's authentic voice. The styleNarrative field is especially important - write it as if describing a real person's communication style to another writer who needs to imitate them.`

    return this.generateJson<Partial<VoiceProfile>>(prompt, { maxTokens: 8192 })
  }

  /**
   * Extract structured facts from a conversation
   * Returns entities (people, places, events, etc.) mentioned
   */
  async extractFactsFromConversation(params: {
    conversationText: string
    sourceType: string
    contactName?: string
    existingEntities?: Array<{ canonicalName: string; type: string; aliases: string[] }>
  }): Promise<ExtractedFact[]> {
    const { conversationText, sourceType, contactName, existingEntities } = params

    const existingContext = existingEntities?.length 
      ? `\n\nKNOWN ENTITIES (link to these if mentioned):\n${existingEntities.map(e => `- ${e.canonicalName} (${e.type}): aliases [${e.aliases.join(', ')}]`).join('\n')}`
      : ''

    const prompt = `Extract structured facts from this ${sourceType} conversation${contactName ? ` with ${contactName}` : ''}. Return ONLY valid JSON.

Schema:
{
  "entities": [
    {
      "type": "person|place|event|work|health|relationship|hobby|opinion|possession|education|travel|pet|project",
      "canonicalName": "The resolved name (e.g., 'Sarah' not 'my sister')",
      "aliases": ["all ways this entity is referred to in the conversation"],
      "attributes": {
        // Type-specific attributes, e.g.:
        // person: { "relationship": "sister", "age": 25, "occupation": "teacher" }
        // place: { "location": "Austin, TX", "purpose": "lived there 2019-2024" }
        // event: { "date": "March 2024", "significance": "got promoted" }
        // work: { "role": "Senior Engineer", "company": "TechCorp" }
        // health: { "condition": "diabetes", "management": "diet/exercise" }
        // hobby: { "skillLevel": "intermediate", "frequency": "weekly" }
      },
      "confidence": 0.0-1.0,
      "relatedTo": ["names of other entities this relates to"]
    }
  ]
}

Extraction rules:
- Extract ONLY explicit facts, not assumptions
- Include context in attributes (when, where, why)
- Note dates/times when mentioned
- Track sentiment/opinions about entities
- Link relationships (person A is sister of person B)
- If an entity matches a KNOWN ENTITY, use the same canonicalName
- Be generous with aliases - include "my sister", "Sarah", "sis", etc.
- Confidence: 1.0 = explicitly named and described, 0.5 = mentioned but unclear, 0.3 = inferred
${existingContext}

Conversation:
${conversationText.slice(0, 15000)}`

    const result = await this.generateJson<{ entities: ExtractedFact[] }>(prompt, { maxTokens: 4096 })
    return result?.entities ?? []
  }

  /**
   * Confirm if two entity references refer to the same entity
   */
  async confirmEntityMatch(params: {
    entity1: { name: string; context: string }
    entity2: { name: string; context: string }
  }): Promise<boolean> {
    const { entity1, entity2 } = params

    const prompt = `Do these two entity references refer to the same real-world entity? Answer ONLY "true" or "false".

Entity 1: "${entity1.name}"
Context: ${entity1.context}

Entity 2: "${entity2.name}"
Context: ${entity2.context}

Consider:
- Same person/place/thing with different names? (e.g., "Sarah" and "my sister")
- Different entities with similar names? (e.g., "Tom (coworker)" vs "Tom (neighbor)")
- Use contextual clues to determine if they're the same.`

    const result = await this.generate(prompt, { maxTokens: 10 })
    return result?.toLowerCase().trim() === 'true'
  }

  /**
   * Batch extract facts from multiple conversation chunks
   */
  async extractFactsFromChunks(params: {
    chunks: Array<{
      text: string
      sourceType: string
      contactName?: string
      date?: string
    }>
    existingEntities?: Array<{ canonicalName: string; type: string; aliases: string[] }>
    onProgress?: (done: number, total: number) => void
  }): Promise<ExtractedFact[]> {
    const { chunks, existingEntities, onProgress } = params
    const allFacts: ExtractedFact[] = []

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]
      try {
        const facts = await this.extractFactsFromConversation({
          conversationText: chunk.text,
          sourceType: chunk.sourceType,
          contactName: chunk.contactName,
          existingEntities: [...(existingEntities ?? []), ...allFacts],
        })
        
        // Add source metadata
        for (const fact of facts) {
          if (chunk.date) {
            fact.attributes = fact.attributes || {}
            fact.attributes._sourceDate = chunk.date
          }
        }
        
        allFacts.push(...facts)
      } catch (e) {
        console.warn(`[Granite] Failed to extract facts from chunk ${i}:`, e)
      }
      
      onProgress?.(i + 1, chunks.length)
    }

    return allFacts
  }
}

// Singleton instance
let graniteClient: GraniteClient | null = null

/**
 * Get or create Granite client instance
 */
export function getGraniteClient(): GraniteClient | null {
  const apiKey = process.env.WATSONX_API_KEY
  const projectId = process.env.WATSONX_PROJECT_ID

  if (!apiKey || !projectId) {
    console.warn('[Granite] Missing WATSONX_API_KEY or WATSONX_PROJECT_ID - Granite unavailable')
    return null
  }

  if (!graniteClient) {
    const modelId = process.env.GRANITE_MODEL ?? GRANITE_MODELS['granite-13b-instruct']
    graniteClient = new GraniteClient({
      apiKey,
      projectId,
      modelId,
    })
  }

  return graniteClient
}

/**
 * Check if Granite is available
 */
export function isGraniteAvailable(): boolean {
  return Boolean(process.env.WATSONX_API_KEY && process.env.WATSONX_PROJECT_ID)
}

export type { ChunkStyleDistillation, ContactConversationSummary, GraniteModelId }
