import type { RedditDataset, RedditImportProgress } from '../types/reddit.types.js'
import { analyzeVoice, type VoiceProfile } from '../analysis/voiceAnalyzer.js'
import { GoogleGenerativeAI } from '@google/generative-ai'

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

  const chunkSizeDefault = 30
  const maxChunkCharsDefault = 16_000
  const maxItemCharsDefault = 900
  const maxItemsDefault = Number.MAX_SAFE_INTEGER
  const minTextLenDefault = 40

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
    .filter((c) => c.text.length > 0)

  const posts = dataset.posts
    .map((p) => ({ text: `${p.title ?? ''}\n${p.body ?? ''}`.trim(), score: p.score ?? 0 }))
    .filter((p) => p.text.length > 0)

  const localBaseline = analyzeVoice({
    comments: dataset.comments.map((c) => ({ body: c.body ?? '', score: c.score ?? undefined })),
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

  // Use all data, but order so we get high-signal chunks first.
  const all = [...comments, ...posts]
    .filter((x) => x.text.length >= minTextLen)
    .sort((a, b) => (b.text.length + b.score) - (a.text.length + a.score))
    .slice(0, maxItems)

  // Chunk by item count and prompt size to avoid slow / timed-out generations.
  const chunks = chunkBySizeAndChars(all, chunkSize, maxChunkChars, maxItemChars)
  console.log('[VoiceTrainer] Training set', {
    totalItems: all.length,
    chunkSize,
    maxChunkChars,
    maxItemChars,
    chunks: chunks.length,
  })

  const total = Math.max(1, chunks.length)
  const chunkSummaries: ChunkStyle[] = []
  let blockedChunks = 0
  let invalidJsonChunks = 0
  let timeoutChunks = 0

  if (chunks.length === 0) {
    throw new Error('Not enough Reddit content to train a voice profile. Try importing more data or lowering filters.')
  }

  for (let i = 0; i < chunks.length; i++) {
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
            continue
          }
          throw new Error(`Gemini generate failed (chunk ${i + 1}/${total} retry): ${retryDetails}`)
        }
      } else {
        throw new Error(`Gemini generate failed (chunk ${i + 1}/${total}): ${details}`)
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
  }

  if (chunkSummaries.length === 0) {
    opts.onProgress?.({
      stage: 'training',
      percent: 95,
      message: 'Using local fallback analyzer due to Gemini safety blocks…',
    })
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
    totalTexts: all.length,
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
      return useLocalFallback('Reduce blocked by safety filter')
    }
    throw new Error(`Gemini generate failed (reduce): ${details}`)
  }

  reduceRaw = reduceRaw.trim()
  const reduceJson = extractFirstJsonObject(reduceRaw) ?? reduceRaw
  const profile = safeJsonParse<VoiceProfile>(reduceJson)
  if (!profile) {
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

  return profile
}
