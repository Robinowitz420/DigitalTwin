import type { RedditDataset, RedditImportProgress } from '../types/reddit.types.js'
import { analyzeVoice, type VoiceProfile } from '../analysis/voiceAnalyzer.js'
import { GoogleGenerativeAI } from '@google/generative-ai'
import { loadIdentityTimeline } from './identityStore.js'
import {
  loadVoiceCheckpoint,
  saveVoiceCheckpoint,
  clearVoiceCheckpoint,
  createInitialCheckpoint,
} from './voiceCheckpointStore.js'
import type { VoiceTrainingCheckpoint, VoiceTrainingControl } from '../types/voiceTraining.types.js'

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  if (!Number.isFinite(ms) || ms <= 0) return promise
  let timeoutId: ReturnType<typeof setTimeout> | null = null
  const timeoutPromise = new Promise<T>((_resolve, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`${label} timed out after ${ms}ms`))
    }, ms)
  })
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeoutId) clearTimeout(timeoutId)
  })
}

function chunkBySizeAndChars(
  items: Array<{ text: string; score: number }>,
  maxItems: number,
  maxChunkChars: number,
  maxItemChars: number,
): Array<Array<{ text: string; score: number }>> {
  const chunks: Array<Array<{ text: string; score: number }>> = []
  let current: Array<{ text: string; score: number }> = []
  let currentChars = 0

  const sepChars = '\n\n---\n\n'.length

  for (const item of items) {
    const trimmed = item.text.trim()
    if (!trimmed) continue
    const text = trimmed.length > maxItemChars ? trimmed.slice(0, maxItemChars) : trimmed
    const nextChars = currentChars + text.length + (current.length > 0 ? sepChars : 0)
    const wouldExceed = current.length >= maxItems || nextChars > maxChunkChars

    if (wouldExceed && current.length > 0) {
      chunks.push(current)
      current = []
      currentChars = 0
    }

    current.push({ text, score: item.score })
    currentChars += text.length + (current.length > 1 ? sepChars : 0)
  }

  if (current.length > 0) chunks.push(current)
  return chunks
}

function clamp01(n: number) {
  return Math.max(0, Math.min(1, n))
}

function safeJsonParse<T>(s: string): T | null {
  try {
    return JSON.parse(s) as T
  } catch {
    return null
  }
}

function extractFirstJsonObject(s: string): string | null {
  const start = s.indexOf('{')
  if (start === -1) return null
  let depth = 0
  for (let i = start; i < s.length; i++) {
    const ch = s[i]
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return s.slice(start, i + 1)
    }
  }
  return null
}

function isBlockedContentError(details: string) {
  const d = details.toLowerCase()
  return d.includes('prohibited_content') || (d.includes('blocked') && d.includes('text not available'))
}

function isTimeoutError(details: string) {
  return details.toLowerCase().includes('timed out')
}

type ChunkStyle = {
  observations: {
    tone?: string
    vocabulary?: string
    punctuation?: string
    structure?: string
  }
  rules: string[]
  common_phrases: string[]
  do: string[]
  dont: string[]
}

// Global training control state
let trainingPaused = false
let trainingAborted = false

export function createTrainingControl(): VoiceTrainingControl {
  trainingPaused = false
  trainingAborted = false
  return {
    pause: () => { trainingPaused = true },
    resume: () => { trainingPaused = false },
    isPaused: () => trainingPaused,
    abort: () => { trainingAborted = true },
    isAborted: () => trainingAborted,
  }
}

// Quality filter for training data - only include substantive content
function isHighQualityText(text: string, minLen: number): boolean {
  if (text.length < minLen) return false
  // Skip very short or low-effort content
  const words = text.split(/\s+/).length
  if (words < 5) return false
  // Skip content that's mostly URLs or mentions
  const urlCount = (text.match(/https?:\/\//g) ?? []).length
  if (urlCount > 3 && text.length < 200) return false
  // Skip content that's mostly emojis
  const emojiCount = (text.match(/[\u{1F300}-\u{1F9FF}]/gu) ?? []).length
  if (emojiCount > words / 3) return false
  return true
}

// Score-based filtering - prioritize high-engagement content
function scoreContent(item: { text: string; score: number }): number {
  let score = 0
  // Length bonus (optimal 50-500 chars)
  if (item.text.length >= 50 && item.text.length <= 500) score += 10
  else if (item.text.length >= 30) score += 5
  // Engagement score bonus
  score += Math.min(item.score / 10, 20) // Cap at 20 points
  // Substantive content bonus
  if (item.text.includes('.') || item.text.includes('?') || item.text.includes('!')) score += 5
  return score
}

export async function trainVoiceWithGemini(
  dataset: RedditDataset,
  opts: {
    model: string
    onProgress?: (p: RedditImportProgress) => void
    timeoutMs?: number
    tuning?: {
      chunkSize?: number
      maxChunkChars?: number
      maxItemChars?: number
      maxItems?: number
      minTextLen?: number
      reduceTimeoutMs?: number
    }
    resumeFromCheckpoint?: boolean
    control?: VoiceTrainingControl
  },
): Promise<VoiceProfile> {
  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) {
    throw new Error('Missing GEMINI_API_KEY. Set it in .env.local to enable Gemini.')
  }

  const chunkSizeEnv = Number(process.env.VOICE_TRAIN_CHUNK_SIZE)
  const maxChunkCharsEnv = Number(process.env.VOICE_TRAIN_MAX_CHUNK_CHARS)
  const maxItemCharsEnv = Number(process.env.VOICE_TRAIN_MAX_ITEM_CHARS)
  const maxItemsEnv = Number(process.env.VOICE_TRAIN_MAX_ITEMS)
  const minTextLenEnv = Number(process.env.VOICE_TRAIN_MIN_TEXT_LEN)
  const timeoutEnv = Number(process.env.VOICE_TRAIN_TIMEOUT_MS)
  const reduceTimeoutEnv = Number(process.env.VOICE_TRAIN_REDUCE_TIMEOUT_MS)
  const testTimeoutEnv = Number(process.env.VOICE_TRAIN_TEST_TIMEOUT_MS)
  const checkpointIntervalEnv = Number(process.env.VOICE_TRAIN_CHECKPOINT_INTERVAL)

  const chunkSizeDefault = 30
  const maxChunkCharsDefault = 16_000
  const maxItemCharsDefault = 900
  const maxItemsDefault = 5000 // Limit to prevent massive training sets
  const minTextLenDefault = 50 // Higher threshold for quality

  const chunkSize =
    opts.tuning?.chunkSize ??
    (Number.isFinite(chunkSizeEnv) && chunkSizeEnv > 0 ? chunkSizeEnv : chunkSizeDefault)
  const maxChunkChars =
    opts.tuning?.maxChunkChars ??
    (Number.isFinite(maxChunkCharsEnv) && maxChunkCharsEnv > 0 ? maxChunkCharsEnv : maxChunkCharsDefault)
  const maxItemChars =
    opts.tuning?.maxItemChars ??
    (Number.isFinite(maxItemCharsEnv) && maxItemCharsEnv > 0 ? maxItemCharsEnv : maxItemCharsDefault)
  const maxItems =
    opts.tuning?.maxItems ??
    (Number.isFinite(maxItemsEnv) && maxItemsEnv > 0 ? maxItemsEnv : maxItemsDefault)
  const minTextLen =
    opts.tuning?.minTextLen ??
    (Number.isFinite(minTextLenEnv) && minTextLenEnv > 0 ? minTextLenEnv : minTextLenDefault)
  const checkpointInterval = Number.isFinite(checkpointIntervalEnv) && checkpointIntervalEnv > 0 
    ? checkpointIntervalEnv 
    : 10 // Save checkpoint every 10 chunks

  const genAI = new GoogleGenerativeAI(apiKey)
  const model = genAI.getGenerativeModel({
    model: opts.model,
    generationConfig: {
      temperature: 0.2,
      responseMimeType: 'application/json',
    },
  })

  // Quick generate test so we fail fast if the model is unresponsive.
  const testTimeoutMs = Number.isFinite(testTimeoutEnv) && testTimeoutEnv > 0 ? testTimeoutEnv : 60_000
  try {
    await withTimeout(
      model.generateContent('Say hello in one sentence.').then((r) => r.response.text()),
      testTimeoutMs,
      'Gemini generate test',
    )
  } catch (e) {
    const details = e instanceof Error ? `${e.name}: ${e.message}` : String(e)
    const timeoutHint =
      e instanceof Error && details.toLowerCase().includes('timed out')
        ? ` (timed out after ${testTimeoutMs}ms)`
        : ''
    throw new Error(`Gemini generate test failed. ${details}${timeoutHint}`)
  }

  const comments = dataset.comments
    .map((c) => ({ text: (c.body ?? '').trim(), score: c.score ?? 0 }))
    .filter((c) => c.text.length > 0 && isHighQualityText(c.text, minTextLen))

  const posts = dataset.posts
    .map((p) => ({ text: `${p.title ?? ''}\n${p.body ?? ''}`.trim(), score: p.score ?? 0 }))
    .filter((p) => p.text.length > 0 && isHighQualityText(p.text, minTextLen))

  // Load SMS and Instagram from identity timeline for voice training
  const identityTimeline = await loadIdentityTimeline()
  const identityEvents = identityTimeline?.events ?? []
  
  // SMS messages (user's outbound texts)
  const smsMessages = identityEvents
    .filter((e): e is import('../types/identity.types.js').IdentityEvent => 
      e.source === 'sms' && e.metadata?.isUserMessage === true
    )
    .map(e => ({ text: (e.text ?? '').trim(), score: 0 }))
    .filter(m => m.text.length > 0 && isHighQualityText(m.text, minTextLen))
  
  // Instagram DMs (user's outbound messages)
  const instagramMessages = identityEvents
    .filter((e): e is import('../types/identity.types.js').IdentityEvent => 
      e.source === 'instagram' && e.kind === 'message' && e.metadata?.isUserMessage === true
    )
    .map(e => ({ text: (e.text ?? '').trim(), score: 0 }))
    .filter(m => m.text.length > 0 && isHighQualityText(m.text, minTextLen))
  
  // Instagram comments (always user's own)
  const instagramComments = identityEvents
    .filter((e): e is import('../types/identity.types.js').IdentityEvent => 
      e.source === 'instagram' && e.kind === 'comment'
    )
    .map(e => ({ text: (e.text ?? '').trim(), score: 0 }))
    .filter(m => m.text.length > 0 && isHighQualityText(m.text, minTextLen))
  
  // LLM chat prompts (user's messages to ChatGPT, Claude, etc.)
  const llmChatMessages = identityEvents
    .filter((e): e is import('../types/identity.types.js').IdentityEvent => 
      e.source === 'llm_chat' && e.metadata?.isUserMessage === true
    )
    .map(e => ({ text: (e.text ?? '').trim(), score: 0 }))
    .filter(m => m.text.length > 0 && isHighQualityText(m.text, minTextLen))

  const localBaseline = analyzeVoice({
    comments: [
      ...dataset.comments.map((c) => ({ body: c.body ?? '', score: c.score ?? undefined })),
      ...smsMessages.map(m => ({ body: m.text, score: undefined })),
      ...instagramMessages.map(m => ({ body: m.text, score: undefined })),
      ...instagramComments.map(m => ({ body: m.text, score: undefined })),
      ...llmChatMessages.map(m => ({ body: m.text, score: undefined })),
    ],
    posts: dataset.posts.map((p) => ({
      title: p.title ?? '',
      body: p.body ?? '',
      score: p.score ?? undefined,
    })),
  })

  const useLocalFallback = (reason: string) => {
    console.warn(`[VoiceTrainer] ${reason}, using local heuristic analyzer fallback`)
    return localBaseline
  }

  // Score and filter content, prioritize high-quality
  const allScored = [...comments, ...posts, ...smsMessages, ...instagramMessages, ...instagramComments, ...llmChatMessages]
    .map(item => ({ ...item, qualityScore: scoreContent(item) }))
    .sort((a, b) => b.qualityScore - a.qualityScore || b.score - a.score)
    .slice(0, maxItems)

  // Chunk by item count and prompt size to avoid slow / timed-out generations.
  const chunks = chunkBySizeAndChars(allScored, chunkSize, maxChunkChars, maxItemChars)
  console.log('[VoiceTrainer] Training set', {
    totalItems: allScored.length,
    chunkSize,
    maxChunkChars,
    maxItemChars,
    chunks: chunks.length,
    filtered: comments.length + posts.length + smsMessages.length + instagramMessages.length + instagramComments.length + llmChatMessages.length,
  })

  const total = Math.max(1, chunks.length)

  // Check for existing checkpoint to resume
  let checkpoint: VoiceTrainingCheckpoint | null = null
  if (opts.resumeFromCheckpoint) {
    checkpoint = await loadVoiceCheckpoint()
    if (checkpoint) {
      console.log('[VoiceTrainer] Resuming from checkpoint', {
        processedChunks: checkpoint.processedChunks,
        totalChunks: checkpoint.totalChunks,
      })
    }
  }

  if (!checkpoint) {
    checkpoint = createInitialCheckpoint(total, {
      totalItems: allScored.length,
      comments: comments.length,
      posts: posts.length,
      smsMessages: smsMessages.length,
      instagramMessages: instagramMessages.length,
      instagramComments: instagramComments.length,
      llmChatMessages: llmChatMessages.length,
    })
  }

  if (chunks.length === 0) {
    throw new Error('Not enough quality content to train a voice profile. Try importing more data or lowering filters.')
  }

  const chunkSummaries: ChunkStyle[] = checkpoint.chunkSummaries ?? []
  let blockedChunks = checkpoint.skippedChunks
  let invalidJsonChunks = 0
  let timeoutChunks = 0
  const startIdx = checkpoint.processedChunks

  for (let i = startIdx; i < chunks.length; i++) {
    // Check for pause/abort
    while (trainingPaused && !trainingAborted) {
      await new Promise(r => setTimeout(r, 500))
      opts.onProgress?.({
        stage: 'training',
        percent: 90 * (checkpoint!.processedChunks / total),
        message: `Training paused at chunk ${checkpoint!.processedChunks}/${total}. Click Resume to continue.`,
      })
    }

    if (trainingAborted) {
      checkpoint.status = 'paused'
      checkpoint.error = 'Training aborted by user'
      await saveVoiceCheckpoint(checkpoint)
      throw new Error('Training aborted by user')
    }

    const percent = 90 * ((i + 1) / total)
    opts.onProgress?.({
      stage: 'training',
      percent: Math.max(1, Math.min(90, percent)),
      message: `Training your voice… (chunk ${i + 1}/${total})`,
    })

    const startedAt = Date.now()
    console.log('[VoiceTrainer] Chunk start', { idx: i + 1, total, items: chunks[i].length })

    const sampleText = chunks[i]
      .map((x, idx) => `#${idx + 1}\n${x.text}`)
      .join('\n\n---\n\n')

    const makePrompt = (samples: string) => `You are a writing-style analyst.
Analyze the user's writing samples below and extract a compact style distillation.
Return ONLY valid JSON.

Schema:
{
  "observations": {"tone": string, "vocabulary": string, "punctuation": string, "structure": string},
  "rules": string[],
  "common_phrases": string[],
  "do": string[],
  "dont": string[]
}

Writing samples:
${samples}`
    const prompt = makePrompt(sampleText)
    console.log('[VoiceTrainer] Prompt size', { idx: i + 1, chars: prompt.length })

    const timeoutMs =
      opts.timeoutMs ?? (Number.isFinite(timeoutEnv) && timeoutEnv > 0 ? timeoutEnv : 240_000)

    let raw = ''
    try {
      raw = await withTimeout(
        model.generateContent(prompt).then((r) => r.response.text()),
        timeoutMs,
        `Gemini training chunk ${i + 1}/${total}`,
      )
    } catch (e) {
      const details = e instanceof Error ? `${e.name}: ${e.message}` : String(e)
      if (isBlockedContentError(details)) {
        blockedChunks++
        console.warn('[VoiceTrainer] Chunk blocked by safety filter; skipping', {
          idx: i + 1,
          total,
          blockedChunks,
        })
        opts.onProgress?.({
          stage: 'training',
          percent: Math.max(1, Math.min(90, percent)),
          message: `Skipping blocked sample (chunk ${i + 1}/${total})`,
        })
        // Save checkpoint even on skip
        checkpoint.processedChunks = i + 1
        checkpoint.skippedChunks = blockedChunks
        checkpoint.lastCheckpointAt = new Date().toISOString()
        if ((i + 1) % checkpointInterval === 0) {
          await saveVoiceCheckpoint(checkpoint)
        }
        continue
      }
      if (isTimeoutError(details)) {
        const retryItems = chunks[i].slice(0, Math.max(5, Math.ceil(chunks[i].length / 2)))
        const retrySampleText = retryItems
          .map((x, idx) => `#${idx + 1}\n${x.text}`)
          .join('\n\n---\n\n')
        const retryPrompt = makePrompt(retrySampleText)
        try {
          opts.onProgress?.({
            stage: 'training',
            percent: Math.max(1, Math.min(90, percent)),
            message: `Retrying slow chunk ${i + 1}/${total} with smaller sample…`,
          })
          raw = await withTimeout(
            model.generateContent(retryPrompt).then((r) => r.response.text()),
            timeoutMs,
            `Gemini training chunk retry ${i + 1}/${total}`,
          )
        } catch (retryErr) {
          const retryDetails = retryErr instanceof Error ? `${retryErr.name}: ${retryErr.message}` : String(retryErr)
          if (isBlockedContentError(retryDetails)) {
            blockedChunks++
            opts.onProgress?.({
              stage: 'training',
              percent: Math.max(1, Math.min(90, percent)),
              message: `Skipping blocked retry (chunk ${i + 1}/${total})`,
            })
            checkpoint.processedChunks = i + 1
            checkpoint.skippedChunks = blockedChunks
            checkpoint.lastCheckpointAt = new Date().toISOString()
            if ((i + 1) % checkpointInterval === 0) {
              await saveVoiceCheckpoint(checkpoint)
            }
            continue
          }
          if (isTimeoutError(retryDetails)) {
            timeoutChunks++
            console.warn('[VoiceTrainer] Chunk timed out twice; skipping', {
              idx: i + 1,
              total,
              timeoutChunks,
            })
            opts.onProgress?.({
              stage: 'training',
              percent: Math.max(1, Math.min(90, percent)),
              message: `Skipping slow chunk ${i + 1}/${total} after retry timeout`,
            })
            checkpoint.processedChunks = i + 1
            checkpoint.skippedChunks = blockedChunks
            checkpoint.lastCheckpointAt = new Date().toISOString()
            if ((i + 1) % checkpointInterval === 0) {
              await saveVoiceCheckpoint(checkpoint)
            }
            continue
          }
          // Save checkpoint on error
          checkpoint.status = 'paused'
          checkpoint.error = `Gemini generate failed (chunk ${i + 1}/${total} retry): ${retryDetails}`
          await saveVoiceCheckpoint(checkpoint)
          throw new Error(checkpoint.error)
        }
      } else {
        // Save checkpoint on error
        checkpoint.status = 'paused'
        checkpoint.error = `Gemini generate failed (chunk ${i + 1}/${total}): ${details}`
        await saveVoiceCheckpoint(checkpoint)
        throw new Error(checkpoint.error)
      }
    }

    console.log('[VoiceTrainer] Chunk done', { idx: i + 1, ms: Date.now() - startedAt })

    raw = raw.trim()
    const jsonStr = extractFirstJsonObject(raw) ?? raw
    const parsed = safeJsonParse<ChunkStyle>(jsonStr)

    if (!parsed || !Array.isArray(parsed.rules)) {
      invalidJsonChunks++
      console.warn('[VoiceTrainer] Invalid chunk JSON from Gemini; skipping', {
        idx: i + 1,
        total,
        invalidJsonChunks,
      })
      opts.onProgress?.({
        stage: 'training',
        percent: Math.max(1, Math.min(90, percent)),
        message: `Skipping malformed model output (chunk ${i + 1}/${total})`,
      })
      continue
    }

    chunkSummaries.push(parsed)
    
    // Update checkpoint
    checkpoint.processedChunks = i + 1
    checkpoint.chunkSummaries = chunkSummaries
    checkpoint.lastCheckpointAt = new Date().toISOString()
    
    // Save checkpoint periodically
    if ((i + 1) % checkpointInterval === 0) {
      console.log('[VoiceTrainer] Saving checkpoint', { processedChunks: i + 1, total })
      await saveVoiceCheckpoint(checkpoint)
      opts.onProgress?.({
        stage: 'training',
        percent: Math.max(1, Math.min(90, percent)),
        message: `Checkpoint saved (chunk ${i + 1}/${total})`,
      })
    }
  }

  if (chunkSummaries.length === 0) {
    opts.onProgress?.({
      stage: 'training',
      percent: 95,
      message: 'Using local fallback analyzer due to Gemini safety blocks…',
    })
    await clearVoiceCheckpoint()
    return useLocalFallback('All chunks blocked/unavailable')
  }

  opts.onProgress?.({ stage: 'training', percent: 95, message: 'Finalizing your voice profile…' })

  // Reduce: merge chunk distillations into a final VoiceProfile (LLM-assisted)
  const reducePrompt = `You are consolidating multiple partial writing-style distillations into ONE final voice profile.
Return ONLY valid JSON following this schema:

{
  "avgLength": number,
  "medianLength": number,
  "totalComments": number,
  "commonPhrases": {"phrase": string, "frequency": number}[],
  "signatureWords": {"word": string, "frequency": number}[],
  "toneScores": {"casual": number, "formal": number, "humorous": number, "serious": number, "passionate": number},
  "punctuationStyle": {"exclamationsPerComment": number, "questionsPerComment": number, "ellipsesPerComment": number, "emDashesPerComment": number, "parentheticalsPer100Words": number, "quotesUsagePer100Words": number},
  "vocabularyLevel": "simple"|"moderate"|"advanced"|"technical",
  "avgWordsPerSentence": number,
  "complexSentenceRatio": number,
  "starterPhrases": {"phrase": string, "count": number}[],
  "closingPhrases": {"phrase": string, "count": number}[],
  "paragraphUsage": number,
  "shortFormRatio": number,
  "longFormRatio": number,
  "representativeExamples": string[],
  "highEngagementExamples": string[]
}

Partial distillations:
${JSON.stringify(chunkSummaries).slice(0, 120_000)}

Also, compute approximate numeric fields based on the dataset stats provided below.
Dataset stats:
${JSON.stringify({
    totalTexts: allScored.length,
    totalComments: comments.length,
  })}
`

  const reduceTimeoutMs =
    opts.tuning?.reduceTimeoutMs ??
    opts.timeoutMs ??
    (Number.isFinite(reduceTimeoutEnv) && reduceTimeoutEnv > 0 ? reduceTimeoutEnv : 300_000)

  let reduceRaw = ''
  try {
    reduceRaw = await withTimeout(
      model.generateContent(reducePrompt).then((r) => r.response.text()),
      reduceTimeoutMs,
      'Gemini reduce',
    )
  } catch (e) {
    const details = e instanceof Error ? `${e.name}: ${e.message}` : String(e)
    if (isBlockedContentError(details)) {
      console.warn('[VoiceTrainer] Reduce blocked by safety filter', {
        blockedChunks,
        usableChunks: chunkSummaries.length,
      })
      await clearVoiceCheckpoint()
      return useLocalFallback('Reduce blocked by safety filter')
    }
    // Save checkpoint on reduce error
    checkpoint.status = 'paused'
    checkpoint.error = `Gemini generate failed (reduce): ${details}`
    await saveVoiceCheckpoint(checkpoint)
    throw new Error(checkpoint.error)
  }

  reduceRaw = reduceRaw.trim()
  const reduceJson = extractFirstJsonObject(reduceRaw) ?? reduceRaw
  const profile = safeJsonParse<VoiceProfile>(reduceJson)
  if (!profile) {
    await clearVoiceCheckpoint()
    return useLocalFallback('Failed to parse Gemini reduce JSON')
  }

  // Clamp tone scores just in case
  profile.toneScores = {
    casual: clamp01(profile.toneScores?.casual ?? 0),
    formal: clamp01(profile.toneScores?.formal ?? 0),
    humorous: clamp01(profile.toneScores?.humorous ?? 0),
    serious: clamp01(profile.toneScores?.serious ?? 0),
    passionate: clamp01(profile.toneScores?.passionate ?? 0),
  }

  // Keep lexical/profile anchors grounded in full-corpus deterministic stats.
  profile.avgLength = localBaseline.avgLength
  profile.medianLength = localBaseline.medianLength
  profile.totalComments = localBaseline.totalComments
  profile.commonPhrases = localBaseline.commonPhrases
  profile.signatureWords = localBaseline.signatureWords
  profile.starterPhrases = localBaseline.starterPhrases
  profile.closingPhrases = localBaseline.closingPhrases
  profile.representativeExamples = localBaseline.representativeExamples
  profile.highEngagementExamples = localBaseline.highEngagementExamples

  // Record training metadata
  profile.trainedAt = new Date().toISOString()
  profile.trainingSources = {
    redditComments: dataset.comments.length,
    redditPosts: dataset.posts.length,
    smsMessages: smsMessages.length,
    instagramMessages: instagramMessages.length,
    instagramComments: instagramComments.length,
    llmChatMessages: llmChatMessages.length,
  }

  // Clear checkpoint on success
  await clearVoiceCheckpoint()
  
  return profile
}
