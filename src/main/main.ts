import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron'
import * as path from 'node:path'
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { importRedditExportFromFolder } from './dataProcessor.js'
import type { RedditDataset, RedditImportProgress, RedditSearchResult } from '../types/reddit.types.js'
import type { GoogleTakeoutImportResult, IdentityEvent, IdentityImportResult, SocialCsvMapping } from '../types/identity.types.js'
import type {
  WriteAgentRequest,
  WriteAgentChunkEvent,
  WriteAgentDoneEvent,
  WriteAgentErrorEvent,
  WriteAgentSliders,
} from '../types/writeAgent.types.js'
import { loadVoiceProfile, clearVoiceProfile } from './voiceProfileStore.js'
import { saveVoiceProfile } from './voiceProfileStore.js'
import { getContactProfile } from './contactProfileStore.js'
import { trainVoice, createTrainingControl } from './voiceTrainer.js'
import { loadVoiceCheckpoint } from './voiceCheckpointStore.js'
import { GoogleGenerativeAI } from '@google/generative-ai'
import { buildWriteLikeMePrompt } from '../ai/writeAgent.js'
import { analyzeVoice, type VoiceProfile } from '../analysis/voiceAnalyzer.js'
import { importGmailEventsFromJson, importGmailEventsFromMbox } from './importers/gmail.js'
import { importSocialCsvEvents, previewSocialCsv } from './importers/socialCsv.js'
import { getIdentitySourceCounts, loadIdentityTimeline, upsertIdentityEvents } from './identityStore.js'
import { learnIdentityProfile } from './identityLearner.js'
import { loadIdentityLearningProfile, saveIdentityLearningProfile } from './identityProfileStore.js'
import {
  importGoogleTakeoutAllFromFolder,
  importChromeTakeoutFromFolder,
  importDiscoverTakeoutFromFolder,
  importGoogleVoiceTakeoutFromFolder,
  importYouTubeTakeoutFromFolder,
} from './importers/googleTakeout.js'
import {
  buildComparisonPrompt,
  buildEvolutionPrompt,
  buildPhraseFrequencyPrompt,
  buildQueryChatPrompt,
  buildTimePeriodSummaryPrompt,
  type QuerySource,
} from './prompts/queryChat.js'
import {
  importInstagramMessagesFromFolder,
  importInstagramCommentsFromFolder,
} from './importers/instagram.js'
import { importLLMChatsFromFolder } from './importers/llmChat.js'
import {
  detectQueryType,
  extractPhrase,
  filterCommentsByTimeframe,
  filterPostsByTimeframe,
  findPhraseMatches,
  findRelevantComments,
} from './utils/queryDetection.js'
import { chunkSmsEvents, stableContactKey as stableContactKeyFromParticipants } from './memory/processor.js'
import { isOllamaRunning, summarizeChunk, summarizeMeta, extractKnowledgeState } from './memory/ollamaClient.js'
import {
  loadMemoryStore,
  saveMemoryStore,
  createMemoryChunk,
  chunkNeedsProcessing,
  upsertMemoryChunk,
  setMetaSummary,
  setKnowledgeState,
} from './memory/store.js'
import {
  getRelevantMemory,
  detectDisclosureQuery,
  evidenceOfDisclosure,
  buildDisclosurePrompt,
} from './memory/retrieval.js'

// Load .env.local for Gemini API key
import { config } from 'dotenv'
config({ path: path.join(process.cwd(), '.env.local') })

const projectRoot = process.cwd()

const isDev = process.env.VITE_DEV_SERVER_URL != null

let mainWindow: BrowserWindow | null = null

let geminiClient: GoogleGenerativeAI | null = null
function getGeminiModel(modelName?: string) {
  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) {
    throw new Error('Missing GEMINI_API_KEY. Set it in .env.local to enable Gemini.')
  }
  if (!geminiClient) geminiClient = new GoogleGenerativeAI(apiKey)
  return geminiClient.getGenerativeModel({
    model: modelName ?? process.env.GEMINI_MODEL ?? 'gemini-2.5-flash',
  })
}

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

const GEMINI_STREAM_TIMEOUT_MS = Number(process.env.GEMINI_STREAM_TIMEOUT_MS || 120_000)

async function loadDatasetFromDisk(): Promise<RedditDataset | null> {
  const datasetPath = path.join(app.getPath('userData'), 'reddit.normalized.json')
  try {
    const raw = await readFile(datasetPath, 'utf8')
    return JSON.parse(raw) as RedditDataset
  } catch {
    return null
  }
}

type SmsMonthlySummaryCache = {
  version: 1
  contacts: Record<
    string,
    {
      fingerprint: string
      monthly: Record<string, { summary: string; evidence: string[]; messageCount: number; updatedAt: string }>
      meta?: { summary: string; updatedAt: string }
    }
  >
}

async function loadSmsMonthlySummaryCache(): Promise<SmsMonthlySummaryCache> {
  const p = path.join(app.getPath('userData'), 'sms.monthlySummaries.json')
  try {
    const raw = await readFile(p, 'utf8')
    const parsed = JSON.parse(raw) as SmsMonthlySummaryCache
    if (!parsed || parsed.version !== 1 || !parsed.contacts) return { version: 1, contacts: {} }
    return parsed
  } catch {
    return { version: 1, contacts: {} }
  }
}

async function saveSmsMonthlySummaryCache(cache: SmsMonthlySummaryCache): Promise<void> {
  const p = path.join(app.getPath('userData'), 'sms.monthlySummaries.json')
  await mkdir(path.dirname(p), { recursive: true })
  await writeFile(p, JSON.stringify(cache), 'utf8')
}

function monthKeyFromIso(iso: string | null | undefined): string | null {
  if (!iso) return null
  const m = iso.match(/^(\d{4})-(\d{2})/)
  return m ? `${m[1]}-${m[2]}` : null
}

function stableContactKey(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

const STOPWORDS = new Set(
  [
    'the','a','an','and','or','but','if','then','so','to','of','in','on','for','with','at','by','from','as','is','are','was','were','be','been','being',
    'i','me','my','mine','you','your','yours','he','him','his','she','her','hers','they','them','their','theirs','we','us','our','ours',
    'this','that','these','those','it','its','im','ive','id','dont','cant','wont','ok','yeah','yep','no','yes','lol','lmao','omg',
  ].map((s) => s.toLowerCase()),
)

function words(text: string) {
  return (text.toLowerCase().match(/[a-z0-9']+/g) ?? []).filter(Boolean)
}

function escapeRegExp(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function buildPhraseRegex(phrase: string): RegExp | null {
  const toks = words(phrase).filter((t) => t.length > 0)
  if (toks.length === 0) return null
  const pattern = `\\b${toks.map((t) => escapeRegExp(t)).join('\\W+')}\\b`
  return new RegExp(pattern, 'gi')
}

function phraseAliases(phrase: string): string[] {
  const p = words(phrase).join(' ')
  const out = new Set<string>([p])
  if (p === 'not gonna lie' || p === 'not going to lie') {
    out.add('ngl')
    out.add('not gon na lie')
  }
  return Array.from(out)
}

type CloneSample = {
  text: string
  createdAt: string | null
  subreddit: string | null
  engagement: number
  relevance: number
}

function formatPunctuationStyle(style: VoiceProfile['punctuationStyle'] | null | undefined): string {
  if (!style) return 'minimal punctuation flair'
  const habits: string[] = []
  if (style.exclamationsPerComment > 0.5) habits.push('heavy exclamation marks')
  if (style.ellipsesPerComment > 0.3) habits.push('frequent ellipses')
  if (style.questionsPerComment > 0.4) habits.push('asks lots of questions')
  if (style.emDashesPerComment > 0.2) habits.push('uses em-dashes')
  if (style.parentheticalsPer100Words > 2) habits.push('lots of parentheticals')
  return habits.length > 0 ? habits.join(', ') : 'minimal punctuation flair'
}

function buildRelatedContext(samples: CloneSample[], limit = 3): string {
  const chosen = [...samples].sort((a, b) => b.relevance - a.relevance).slice(0, limit)
  if (chosen.length === 0) return 'No strongly related past comments found.'
  return chosen
    .map((c, i) => {
      const dt = c.createdAt ? new Date(c.createdAt) : null
      const dateLabel = dt && Number.isFinite(dt.getTime()) ? dt.toLocaleDateString('en-US') : 'unknown date'
      const upvoteLine = c.engagement > 10 ? `\n(This got ${Math.round(c.engagement)} upvotes)` : ''
      return `${i + 1}. On r/${c.subreddit ?? 'unknown'} (${dateLabel}):\n"${c.text.slice(0, 420)}"${upvoteLine}`
    })
    .join('\n\n')
}

function buildDigitalTwinPrompt(input: {
  voiceProfile: VoiceProfile | null
  identitySummary: string
  conversationHistory: Array<{ role: 'user' | 'assistant'; text: string }>
  userQuestion: string
  dateFilterIso?: string
  writingSamples: string[]
  relatedContext: string
}): string {
  const vp = input.voiceProfile
  const avgLen = Math.max(20, Math.round(vp?.avgLength ?? 55))
  const eraContext = input.dateFilterIso
    ? `You are the user as they were on ${new Date(input.dateFilterIso).toLocaleDateString('en-US')}. Your knowledge, opinions, and perspective are frozen at that point in time. You do not know anything after this date.`
    : 'You are the user as they are currently, based on their complete digital history.'

  const phrases = (vp?.commonPhrases ?? []).slice(0, 10).map((p) => `- "${p.phrase}"`).join('\n') || '- (none yet)'
  const signatureWords = (vp?.signatureWords ?? []).slice(0, 20).map((w) => w.word).join(', ') || '(none yet)'
  const starters = (vp?.starterPhrases ?? []).slice(0, 5).map((p) => `- "${p.phrase}"`).join('\n') || '- (none yet)'
  const closers = (vp?.closingPhrases ?? []).slice(0, 5).map((p) => `- "${p.phrase}"`).join('\n') || '- (none yet)'
  const examples =
    input.writingSamples.slice(0, 5).map((ex, i) => `Example ${i + 1}:\n"${ex}"`).join('\n\n') || 'No examples available.'
  const history = input.conversationHistory
    .slice(-8)
    .map((m) => `${m.role === 'assistant' ? 'Clone' : 'User'}: ${m.text}`)
    .join('\n')

  return `${eraContext}

# WHO YOU ARE

You are responding AS this person, not ABOUT them. Speak in first person. You ARE them.

## Your Writing Style:
- Average comment length: ${avgLen} words
- Sentence structure: ${vp?.avgWordsPerSentence != null ? vp.avgWordsPerSentence.toFixed(1) : 'unknown'} words per sentence
- Vocabulary level: ${vp?.vocabularyLevel ?? 'unknown'}
- Punctuation habits: ${formatPunctuationStyle(vp?.punctuationStyle)}

## Phrases You Actually Use:
${phrases}

## Your Signature Words:
${signatureWords}

## How You Start Comments:
${starters}

## How You End Comments:
${closers}

## Your Tone Profile:
- Casual: ${vp?.toneScores?.casual != null ? (vp.toneScores.casual * 100).toFixed(0) : '0'}%
- Formal: ${vp?.toneScores?.formal != null ? (vp.toneScores.formal * 100).toFixed(0) : '0'}%
- Humorous: ${vp?.toneScores?.humorous != null ? (vp.toneScores.humorous * 100).toFixed(0) : '0'}%
- Serious: ${vp?.toneScores?.serious != null ? (vp.toneScores.serious * 100).toFixed(0) : '0'}%
- Passionate: ${vp?.toneScores?.passionate != null ? (vp.toneScores.passionate * 100).toFixed(0) : '0'}%

# EXAMPLES OF YOUR ACTUAL WRITING
${examples}

# YOUR PAST THOUGHTS ON RELATED TOPICS
${input.relatedContext}

# KNOWN IDENTITY SUMMARY
${input.identitySummary}

# CRITICAL INSTRUCTIONS
1. Be authentic: use the same phrasing patterns and cadence shown above.
2. Match length: target around ${avgLen} words unless user asks for more.
3. Use voice markers naturally: starters/signature words/punctuation habits where they fit.
4. Stay grounded: if topic is unfamiliar, say that naturally.
5. No AI-speak:
   - Never say "as an AI", "great question", or "let me break this down" unless this user actually writes that way.
6. Contradictions are OK: acknowledge evolution naturally when needed.
7. Use contractions naturally.
${input.dateFilterIso ? `8. ERA LOCK CRITICAL:
   - It is currently ${new Date(input.dateFilterIso).toLocaleDateString('en-US')}
   - You do not know any events after this date.
   - If asked about future events, answer naturally that it has not happened yet.` : ''}

Recent chat:
${history || '(none)'}

User question: "${input.userQuestion}"

Respond as yourself in first person. Keep it natural and human.`
}

function pickWriteExamples(dataset: RedditDataset, topic: string, fallback: string[]) {
  const queryTokens = words(topic).filter((w) => w.length >= 3)
  const pool = [
    ...dataset.comments.map((c) => ({ text: (c.body ?? '').trim(), score: c.score ?? 0 })),
    ...dataset.posts.map((p) => ({
      text: `${p.title ?? ''}\n${p.body ?? ''}`.trim(),
      score: p.score ?? 0,
    })),
  ]

  // Include SHORT comments too (your style is often 1-2 sentences)
  const scored = pool
    .map((item) => {
      const text = item.text
      if (!text || text.length < 10) return null // Lowered from 40 to 10 to include short comments
      const clipped = text.length > 500 ? `${text.slice(0, 500)}...` : text // Lowered from 900 to 500
      const lower = clipped.toLowerCase()
      const matchHits = queryTokens.reduce((acc, t) => acc + (lower.includes(t) ? 1 : 0), 0)
      const wordCount = words(clipped).length
      // Prefer shorter comments (your style) but still reward relevance
      const lengthScore = wordCount < 50 ? 10 : wordCount < 100 ? 5 : Math.min(3, 300 / wordCount) // Boost short comments
      const engagementScore = Math.max(0, item.score) * 0.02
      const score = matchHits * 12 + lengthScore + engagementScore
      return { text: clipped, score, matchHits, wordCount }
    })
    .filter((x): x is { text: string; score: number; matchHits: number; wordCount: number } => x != null)
    .sort((a, b) => {
      // Prioritize relevant short comments
      if (a.matchHits > 0 && b.matchHits === 0) return -1
      if (a.matchHits === 0 && b.matchHits > 0) return 1
      return b.score - a.score
    })

  // Mix of relevant short comments and typical examples
  const relevant = scored.filter((x) => x.matchHits > 0).slice(0, 8).map((x) => x.text)
  const shortTypical = scored.filter((x) => x.wordCount < 80).slice(0, 6).map((x) => x.text) // Prefer short ones
  const longerTypical = scored.slice(0, 4).map((x) => x.text) // Some longer ones for context
  const combined = [...relevant, ...shortTypical, ...longerTypical, ...fallback].filter((s) => s.trim().length >= 10)

  const deduped: string[] = []
  const seen = new Set<string>()
  for (const s of combined) {
    const key = s.toLowerCase().replace(/\s+/g, ' ').trim()
    if (seen.has(key)) continue
    seen.add(key)
    deduped.push(s)
    if (deduped.length >= 15) break // Increased to include more short examples
  }
  return deduped
}

function pickCrossPlatformExamples(
  timeline: Awaited<ReturnType<typeof loadIdentityTimeline>>,
  topic: string,
  limit = 10,
) {
  if (!timeline?.events?.length) return []
  const queryTokens = words(topic).filter((w) => w.length >= 3)
  const scored = timeline.events
    .map((e) => {
      const text = (e.text ?? '').trim()
      if (text.length < 20) return null
      const low = text.toLowerCase()
      const overlap = queryTokens.reduce((acc, t) => acc + (low.includes(t) ? 1 : 0), 0)
      const sourceBoost = e.source === 'reddit' ? 0 : 1
      const score = overlap * 8 + sourceBoost + Math.min(6, text.length / 180)
      return {
        score,
        line: `[${e.source}${e.channel ? `/${e.channel}` : ''}] ${e.createdAt?.slice(0, 10) ?? 'no-date'}\n${text.slice(0, 500)}`,
      }
    })
    .filter((x): x is { score: number; line: string } => x != null)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)

  const out: string[] = []
  const seen = new Set<string>()
  for (const item of scored) {
    const key = item.line.toLowerCase().replace(/\s+/g, ' ').trim()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(item.line)
    if (out.length >= limit) break
  }
  return out
}

const DEFAULT_WRITE_AGENT_SLIDERS: WriteAgentSliders = {
  formality: 5,
  assertiveness: 5,
  verbosity: 5,
  emotion: 5,
  spicy: 5,
  optimism: 5,
}

function clamp01(n: number) {
  if (!Number.isFinite(n)) return 0
  return Math.max(0, Math.min(1, n))
}

function deriveSlidersForVoiceMode(mode: WriteAgentRequest['voiceMode']): WriteAgentSliders {
  switch (mode) {
    case 'personal_text':
      return { formality: 2, assertiveness: 5, verbosity: 3, emotion: 7, spicy: 5, optimism: 6 }
    case 'close_friend':
      return { formality: 1, assertiveness: 6, verbosity: 4, emotion: 8, spicy: 6, optimism: 7 }
    case 'public_post':
      return { formality: 4, assertiveness: 7, verbosity: 6, emotion: 5, spicy: 6, optimism: 5 }
    case 'professional':
      return { formality: 8, assertiveness: 6, verbosity: 6, emotion: 2, spicy: 2, optimism: 6 }
    case 'unfiltered_me':
      return { formality: 3, assertiveness: 8, verbosity: 5, emotion: 6, spicy: 8, optimism: 4 }
    default:
      return { ...DEFAULT_WRITE_AGENT_SLIDERS }
  }
}

function blendSliders(
  a: WriteAgentSliders,
  b: WriteAgentSliders,
  blendFactor: number,
): WriteAgentSliders {
  const t = clamp01(blendFactor)
  const lerp = (x: number, y: number) => Math.round(x * (1 - t) + y * t)
  return {
    formality: lerp(a.formality, b.formality),
    assertiveness: lerp(a.assertiveness, b.assertiveness),
    verbosity: lerp(a.verbosity, b.verbosity),
    emotion: lerp(a.emotion, b.emotion),
    spicy: lerp(a.spicy, b.spicy),
    optimism: lerp(a.optimism, b.optimism),
  }
}

function pickTimelineExamplesBySource(
  timeline: Awaited<ReturnType<typeof loadIdentityTimeline>>,
  topic: string,
  sources: Array<'sms' | 'gmail'>,
  limit: number,
) {
  if (!timeline?.events?.length) return []
  const filtered = {
    ...timeline,
    events: (timeline.events ?? []).filter((e) => sources.includes(e.source as any)),
  } as Awaited<ReturnType<typeof loadIdentityTimeline>>
  return pickCrossPlatformExamples(filtered, topic, limit)
}

function median(nums: number[]) {
  if (nums.length === 0) return 0
  const sorted = [...nums].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 0) return (sorted[mid - 1] + sorted[mid]) / 2
  return sorted[mid]
}

function pickSmsUserExamples(
  timeline: Awaited<ReturnType<typeof loadIdentityTimeline>>,
  topic: string,
  limit: number,
) {
  if (!timeline?.events?.length) return []
  const queryTokens = words(topic).filter((w) => w.length >= 3)
  const scored = timeline.events
    .filter((e) => e.source === 'sms')
    .filter((e) => {
      const isUser = Boolean((e.metadata as any)?.isUserMessage)
      return isUser
    })
    .map((e) => {
      const text = (e.text ?? '').trim()
      if (text.length < 8) return null
      const low = text.toLowerCase()
      const overlap = queryTokens.reduce((acc, t) => acc + (low.includes(t) ? 1 : 0), 0)
      const lengthScore = Math.min(6, text.length / 120)
      const score = overlap * 10 + lengthScore
      return {
        score,
        text: text.slice(0, 500),
        createdAt: e.createdAt ?? null,
      }
    })
    .filter((x): x is { score: number; text: string; createdAt: string | null } => x != null)
    .sort((a, b) => {
      if (a.score !== b.score) return b.score - a.score
      return (a.createdAt ?? '') < (b.createdAt ?? '') ? 1 : -1
    })
    .slice(0, Math.max(limit * 3, 24))

  const out: string[] = []
  const seen = new Set<string>()
  for (const item of scored) {
    const key = item.text.toLowerCase().replace(/\s+/g, ' ').trim()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(item.text)
    if (out.length >= limit) break
  }
  return out
}

/**
 * Full-corpus SMS retrieval for Write Like Me.
 * - Only outbound messages (isUserMessage === true)
 * - Topic-relevant scoring (same as Model Chat)
 * - Optional contact-scoped filtering
 * - No artificial cap - returns all scored matches up to context budget
 */
function retrieveSmsOutboundForWriteLikeMe(
  timeline: Awaited<ReturnType<typeof loadIdentityTimeline>>,
  topic: string,
  options?: {
    contactName?: string
    maxMessages?: number
  },
): { messages: string[]; stats: { totalCandidates: number; afterDedup: number; topicMatches: number } } {
  if (!timeline?.events?.length) return { messages: [], stats: { totalCandidates: 0, afterDedup: 0, topicMatches: 0 } }

  const queryTokens = words(topic).filter((w) => w.length >= 3)
  const maxMessages = options?.maxMessages ?? 200
  const contactName = options?.contactName?.toLowerCase().trim()

  // Normalize contact name for matching (same as Model Chat)
  const normalizePerson = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, '')
      .replace(/\s+/g, ' ')
      .trim()
  const participantMatches = (participants: string[] | undefined, target: string) => {
    if (!participants?.length) return false
    const normalizedTarget = normalizePerson(target)
    return participants.some((p) => normalizePerson(p).includes(normalizedTarget) || normalizedTarget.includes(normalizePerson(p)))
  }

  const scored = timeline.events
    .filter((e) => e.source === 'sms')
    .filter((e) => {
      // ONLY outbound messages (isUserMessage === true)
      const isUser = Boolean((e.metadata as any)?.isUserMessage)
      return isUser
    })
    .filter((e) => {
      // Optional contact filtering
      if (!contactName) return true
      return participantMatches(e.participants, contactName)
    })
    .map((e) => {
      const text = (e.text ?? '').trim()
      if (text.length < 5) return null // Very short messages are noise
      const low = text.toLowerCase()

      // Topic relevance scoring (same as Model Chat)
      const overlap = queryTokens.reduce((acc, t) => acc + (low.includes(t) ? 1 : 0), 0)

      // Length scoring: prefer medium-length messages (not too short, not too long)
      const len = text.length
      const lengthScore = len < 20 ? 0.5 : len < 150 ? 2 : len < 400 ? 1.5 : 0.8

      // Recency bonus (slightly prefer recent messages)
      const ts = e.createdAt ? Date.parse(e.createdAt) : NaN
      const recencyScore = Number.isFinite(ts) ? Math.min(0.5, (ts / Date.now()) * 0.5) : 0

      const score = overlap * 8 + lengthScore + recencyScore
      return {
        score,
        text: text.slice(0, 600), // Allow longer messages for style analysis
        createdAt: e.createdAt ?? null,
        hasTopicMatch: overlap > 0,
      }
    })
    .filter((x): x is { score: number; text: string; createdAt: string | null; hasTopicMatch: boolean } => x != null)
    .sort((a, b) => {
      // Prioritize topic matches, then by score, then by recency
      if (a.hasTopicMatch && !b.hasTopicMatch) return -1
      if (!a.hasTopicMatch && b.hasTopicMatch) return 1
      if (a.score !== b.score) return b.score - a.score
      return (a.createdAt ?? '') < (b.createdAt ?? '') ? 1 : -1
    })

  const totalCandidates = scored.length
  const topicMatches = scored.filter((x) => x.hasTopicMatch).length

  // Dedupe by content
  const out: string[] = []
  const seen = new Set<string>()
  for (const item of scored) {
    const key = item.text.toLowerCase().replace(/\s+/g, ' ').trim()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(item.text)
    if (out.length >= maxMessages) break
  }

  return {
    messages: out,
    stats: { totalCandidates, afterDedup: out.length, topicMatches },
  }
}

/**
 * Reddit retrieval for Write Like Me using the same scoring as Model Chat.
 * Uses findRelevantComments from queryDetection.ts
 */
function retrieveRedditForWriteLikeMe(
  dataset: RedditDataset,
  topic: string,
  options?: { maxSnippets?: number },
): { snippets: string[]; stats: { totalCandidates: number; afterDedup: number } } {
  const maxSnippets = options?.maxSnippets ?? 100
  const toks = topic
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 3)

  // Score comments (same as Model Chat's findRelevantComments)
  const scoredComments = dataset.comments
    .map((c) => {
      const text = (c.body ?? '').trim()
      if (text.length < 15) return null
      const low = text.toLowerCase()
      const relevance = toks.reduce((acc, t) => acc + (low.includes(t) ? 1 : 0), 0)
      if (relevance === 0) return null
      const lengthScore = Math.min(2, text.length / 300)
      const engagementScore = Math.max(0, (c.score ?? 0)) * 0.01
      const score = relevance * 5 + lengthScore + engagementScore
      return { text: text.slice(0, 700), score, relevance }
    })
    .filter((x): x is { text: string; score: number; relevance: number } => x != null)
    .sort((a, b) => b.score - a.score)

  // Score posts
  const scoredPosts = dataset.posts
    .map((p) => {
      const text = `${p.title ?? ''}\n${p.body ?? ''}`.trim()
      if (text.length < 30) return null
      const low = text.toLowerCase()
      const relevance = toks.reduce((acc, t) => acc + (low.includes(t) ? 1 : 0), 0)
      if (relevance === 0) return null
      const lengthScore = Math.min(2, text.length / 500)
      const engagementScore = Math.max(0, (p.score ?? 0)) * 0.01
      const score = relevance * 5 + lengthScore + engagementScore
      return { text: text.slice(0, 700), score, relevance }
    })
    .filter((x): x is { text: string; score: number; relevance: number } => x != null)
    .sort((a, b) => b.score - a.score)

  const totalCandidates = scoredComments.length + scoredPosts.length

  // Combine and dedupe
  const combined = [...scoredComments, ...scoredPosts]
    .sort((a, b) => b.score - a.score)
    .slice(0, maxSnippets * 2)

  const out: string[] = []
  const seen = new Set<string>()
  for (const item of combined) {
    const key = item.text.toLowerCase().replace(/\s+/g, ' ').trim()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(item.text)
    if (out.length >= maxSnippets) break
  }

  return {
    snippets: out,
    stats: { totalCandidates, afterDedup: out.length },
  }
}

/**
 * Context window budgeting for Write Like Me.
 * Fills context window based on mode priority.
 */
function budgetContextWindow(
  mode: WriteAgentRequest['voiceMode'],
  smsMessages: string[],
  redditSnippets: string[],
  gmailSamples: string[],
  options?: { maxTokens?: number },
): { sms: string[]; reddit: string[]; gmail: string[]; estimatedTokens: number } {
  // Gemini context window budget (leave room for prompt + response)
  const maxTokens = options?.maxTokens ?? 25000 // Conservative for Gemini Flash
  const avgCharsPerToken = 4 // Rough estimate

  // Helper to estimate tokens
  const estimateTokens = (texts: string[]) =>
    Math.ceil(texts.join('\n').length / avgCharsPerToken)

  // Priority order by mode
  let smsPriority: number, redditPriority: number, gmailPriority: number
  switch (mode) {
    case 'personal_text':
    case 'close_friend':
      smsPriority = 3
      redditPriority = 1
      gmailPriority = 2
      break
    case 'public_post':
      smsPriority = 1
      redditPriority = 3
      gmailPriority = 2
      break
    case 'professional':
      smsPriority = 2
      redditPriority = 1
      gmailPriority = 3
      break
    case 'unfiltered_me':
      smsPriority = 2
      redditPriority = 2
      gmailPriority = 1
      break
    default:
      smsPriority = 2
      redditPriority = 2
      gmailPriority = 2
  }

  // Allocate budget by priority
  const budget = { sms: 0, reddit: 0, gmail: 0 }
  const totalPriority = smsPriority + redditPriority + gmailPriority
  budget.sms = Math.floor((maxTokens * smsPriority) / totalPriority)
  budget.reddit = Math.floor((maxTokens * redditPriority) / totalPriority)
  budget.gmail = Math.floor((maxTokens * gmailPriority) / totalPriority)

  // Fill each bucket within budget
  const fillBucket = (messages: string[], tokenBudget: number) => {
    const result: string[] = []
    let used = 0
    for (const msg of messages) {
      const msgTokens = Math.ceil(msg.length / avgCharsPerToken)
      if (used + msgTokens > tokenBudget) break
      result.push(msg)
      used += msgTokens
    }
    return result
  }

  const sms = fillBucket(smsMessages, budget.sms)
  const reddit = fillBucket(redditSnippets, budget.reddit)
  const gmail = fillBucket(gmailSamples, budget.gmail)

  const estimatedTokens = estimateTokens(sms) + estimateTokens(reddit) + estimateTokens(gmail)

  return { sms, reddit, gmail, estimatedTokens }
}

function computeStyleEnvelopeFromSmsExamples(examples: string[]) {
  const cleaned = examples.map((t) => t.trim()).filter(Boolean)
  const wordCounts = cleaned.map((t) => words(t).length).filter((n) => Number.isFinite(n))
  const avgWords = wordCounts.length ? wordCounts.reduce((a, b) => a + b, 0) / wordCounts.length : 0
  const medWords = median(wordCounts)

  const questionRate = cleaned.length ? cleaned.filter((t) => /\?\s*$/.test(t)).length / cleaned.length : 0
  const exclaimRate = cleaned.length ? cleaned.filter((t) => /!/.test(t)).length / cleaned.length : 0
  const ellipsesRate = cleaned.length ? cleaned.filter((t) => /\.\.\./.test(t)).length / cleaned.length : 0
  const lowercaseStartRate = cleaned.length
    ? cleaned.filter((t) => {
        const first = t.trim()[0]
        return first != null && first >= 'a' && first <= 'z'
      }).length / cleaned.length
    : 0
  const emojiRegex = /[\p{Extended_Pictographic}]/gu
  const emojiRate = cleaned.length ? cleaned.filter((t) => emojiRegex.test(t)).length / cleaned.length : 0
  const punctuationPerMsg = cleaned.length
    ? cleaned.reduce((acc, t) => acc + (t.match(/[\.!\?,]/g)?.length ?? 0), 0) / cleaned.length
    : 0

  const maxWords = Math.max(6, Math.round((medWords || avgWords || 12) * 1.35))
  const target = Math.max(4, Math.round(medWords || avgWords || 12))

  return {
    avgWords: Number(avgWords.toFixed(1)),
    medianWords: Number(medWords.toFixed(1)),
    targetWords: target,
    maxWords,
    questionRate: Number(questionRate.toFixed(2)),
    exclaimRate: Number(exclaimRate.toFixed(2)),
    ellipsesRate: Number(ellipsesRate.toFixed(2)),
    lowercaseStartRate: Number(lowercaseStartRate.toFixed(2)),
    emojiRate: Number(emojiRate.toFixed(2)),
    punctuationPerMsg: Number(punctuationPerMsg.toFixed(2)),
  }
}

function getModeSourceWeights(mode: WriteAgentRequest['voiceMode']) {
  switch (mode) {
    case 'personal_text':
      return { sms: 0.85, reddit: 0.05, gmail: 0.1 }
    case 'close_friend':
      return { sms: 0.9, reddit: 0.05, gmail: 0.05 }
    case 'public_post':
      return { sms: 0.2, reddit: 0.7, gmail: 0.1 }
    case 'professional':
      return { sms: 0.2, reddit: 0.2, gmail: 0.6 }
    case 'unfiltered_me':
      return { sms: 0.55, reddit: 0.35, gmail: 0.1 }
    default:
      return { sms: 0.45, reddit: 0.45, gmail: 0.1 }
  }
}

function applySourceLocks(
  weights: { sms: number; reddit: number; gmail: number },
  locks: WriteAgentRequest['sourceLocks'],
) {
  const w = { ...weights }
  if (locks?.includeSms === false) w.sms = 0
  if (locks?.includeReddit === false) w.reddit = 0
  if (locks?.includeGmail === false) w.gmail = 0

  const sum = w.sms + w.reddit + w.gmail
  if (sum <= 0) return { ...weights }
  return { sms: w.sms / sum, reddit: w.reddit / sum, gmail: w.gmail / sum }
}

async function checkGeminiHealth() {
  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) {
    return { ok: false, message: 'Missing GEMINI_API_KEY. Set it in .env.local to enable Gemini.' }
  }
  const model = process.env.GEMINI_MODEL ?? 'gemini-2.5-flash'
  return { ok: true, models: [model] }
}

function getPreloadPath() {
  const candidateA = path.join(projectRoot, 'dist-electron', 'main', 'preload.js')
  const candidateB = path.join(projectRoot, 'dist-electron', 'preload.js')
  const resolved = existsSync(candidateA) ? candidateA : candidateB
  if (!existsSync(resolved)) {
    console.error('[DigitalTwin] Preload file not found:', { candidateA, candidateB })
  }
  return resolved
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    backgroundColor: '#0b0f19',
    title: 'Digital Twin',
    webPreferences: {
      preload: getPreloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
    show: false,
  })

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show()
  })

  if (isDev) {
    await mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL as string)
    mainWindow.webContents.openDevTools({ mode: 'detach' })
  } else {
    await mainWindow.loadFile(path.join(projectRoot, 'dist', 'index.html'))
  }
}

function registerIpcHandlers() {
  ipcMain.handle('reddit:selectFolder', async () => {
    if (!mainWindow) return null

    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Select your Reddit data export folder',
      properties: ['openDirectory'],
    })

    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  ipcMain.handle('data:selectGmailFile', async () => {
    if (!mainWindow) return null
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Select Gmail export file (.json or .mbox)',
      properties: ['openFile'],
      filters: [
        { name: 'Gmail Export', extensions: ['json', 'mbox'] },
        { name: 'JSON', extensions: ['json'] },
        { name: 'MBOX', extensions: ['mbox'] },
      ],
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  ipcMain.handle('data:selectSocialCsvFile', async () => {
    if (!mainWindow) return null
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Select social media CSV file',
      properties: ['openFile'],
      filters: [{ name: 'CSV', extensions: ['csv'] }],
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  ipcMain.handle('data:selectChromeFolder', async () => {
    if (!mainWindow) return null
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Select unzipped Google Takeout folder (Chrome)',
      properties: ['openDirectory'],
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  ipcMain.handle('data:selectDiscoverFolder', async () => {
    if (!mainWindow) return null
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Select unzipped Google Takeout folder (Discover)',
      properties: ['openDirectory'],
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  ipcMain.handle('data:selectGoogleVoiceFolder', async () => {
    if (!mainWindow) return null
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Select unzipped Google Takeout folder (Google Voice)',
      properties: ['openDirectory'],
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  ipcMain.handle('data:selectYouTubeFolder', async () => {
    if (!mainWindow) return null
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Select unzipped Google Takeout folder (YouTube)',
      properties: ['openDirectory'],
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  ipcMain.handle('data:selectGoogleTakeoutFolder', async () => {
    if (!mainWindow) return null
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Select unzipped Google Takeout folder (all products)',
      properties: ['openDirectory'],
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  ipcMain.handle('data:selectInstagramMessagesFolder', async () => {
    if (!mainWindow) return null
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Select Instagram messages folder (your_instagram_activity/messages/inbox)',
      properties: ['openDirectory'],
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  ipcMain.handle('data:selectInstagramCommentsFolder', async () => {
    if (!mainWindow) return null
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Select Instagram comments folder (your_instagram_activity/comments)',
      properties: ['openDirectory'],
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  ipcMain.handle('data:selectLLMChatFolder', async () => {
    if (!mainWindow) return null
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Select LLM chat export folder (ChatGPT, Claude, etc.)',
      properties: ['openDirectory'],
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  ipcMain.handle('reddit:importFromFolder', async (_event, folderPath: string) => {
    if (!mainWindow) throw new Error('Main window not ready')

    const dataset = await importRedditExportFromFolder(folderPath, (p) => {
      mainWindow?.webContents.send('reddit:importProgress', p)
    })

    return dataset
  })

  ipcMain.handle('data:importGmailFile', async (_event, filePath: string): Promise<IdentityImportResult> => {
    const lower = filePath.toLowerCase()
    let events: IdentityEvent[] = []
    if (lower.endsWith('.mbox')) {
      events = await importGmailEventsFromMbox(filePath)
    } else if (lower.endsWith('.json')) {
      events = await importGmailEventsFromJson(filePath)
    } else {
      try {
        events = await importGmailEventsFromJson(filePath)
      } catch {
        events = await importGmailEventsFromMbox(filePath)
      }
    }
    const merged = await upsertIdentityEvents(events)
    return {
      source: 'gmail',
      imported: merged.imported,
      totalAfterImport: merged.totalAfterImport,
    }
  })

  ipcMain.handle('data:importSocialCsvFile', async (_event, filePath: string): Promise<IdentityImportResult> => {
    const fallbackMapping: SocialCsvMapping = {
      textColumn: 'text',
      dateColumn: 'created_at',
      authorColumn: 'author',
      recipientColumn: 'to',
      channelColumn: 'platform',
      idColumn: 'id',
    }
    const events = await importSocialCsvEvents(filePath, fallbackMapping)
    const merged = await upsertIdentityEvents(events)
    return {
      source: 'social_csv',
      imported: merged.imported,
      totalAfterImport: merged.totalAfterImport,
    }
  })

  ipcMain.handle('data:importChromeFolder', async (_event, folderPath: string): Promise<IdentityImportResult> => {
    const events = await importChromeTakeoutFromFolder(folderPath)
    const merged = await upsertIdentityEvents(events)
    return {
      source: 'chrome',
      imported: merged.imported,
      totalAfterImport: merged.totalAfterImport,
    }
  })

  ipcMain.handle('data:importDiscoverFolder', async (_event, folderPath: string): Promise<IdentityImportResult> => {
    const events = await importDiscoverTakeoutFromFolder(folderPath)
    const merged = await upsertIdentityEvents(events)
    return {
      source: 'discover',
      imported: merged.imported,
      totalAfterImport: merged.totalAfterImport,
    }
  })

  ipcMain.handle('data:importGoogleVoiceFolder', async (_event, folderPath: string): Promise<IdentityImportResult> => {
    const result = await importGoogleVoiceTakeoutFromFolder(folderPath)
    const merged = await upsertIdentityEvents(result.events)
    return {
      source: 'google_voice',
      imported: merged.imported,
      totalAfterImport: merged.totalAfterImport,
    }
  })

  ipcMain.handle('data:importYouTubeFolder', async (_event, folderPath: string): Promise<IdentityImportResult> => {
    const events = await importYouTubeTakeoutFromFolder(folderPath)
    const merged = await upsertIdentityEvents(events)
    return {
      source: 'youtube',
      imported: merged.imported,
      totalAfterImport: merged.totalAfterImport,
    }
  })

  ipcMain.handle(
    'data:importGoogleTakeoutFolder',
    async (_event, folderPath: string): Promise<GoogleTakeoutImportResult> => {
      const parsed = await importGoogleTakeoutAllFromFolder(folderPath)
      const merged = await upsertIdentityEvents(parsed.events)
      return {
        imported: merged.imported,
        totalAfterImport: merged.totalAfterImport,
        bySource: parsed.bySource,
      }
    },
  )

  ipcMain.handle('data:importInstagramMessagesFolder', async (_event, folderPath: string): Promise<IdentityImportResult> => {
    const events = await importInstagramMessagesFromFolder(folderPath)
    const merged = await upsertIdentityEvents(events)
    return {
      source: 'instagram',
      imported: merged.imported,
      totalAfterImport: merged.totalAfterImport,
    }
  })

  ipcMain.handle('data:importInstagramCommentsFolder', async (_event, folderPath: string): Promise<IdentityImportResult> => {
    const events = await importInstagramCommentsFromFolder(folderPath)
    const merged = await upsertIdentityEvents(events)
    return {
      source: 'instagram',
      imported: merged.imported,
      totalAfterImport: merged.totalAfterImport,
    }
  })

  ipcMain.handle('data:importLLMChatFolder', async (_event, folderPath: string): Promise<IdentityImportResult> => {
    const events = await importLLMChatsFromFolder(folderPath)
    const merged = await upsertIdentityEvents(events)
    return {
      source: 'llm_chat',
      imported: merged.imported,
      totalAfterImport: merged.totalAfterImport,
    }
  })

  ipcMain.handle('data:previewSocialCsvFile', async (_event, filePath: string) => {
    return previewSocialCsv(filePath)
  })

  ipcMain.handle(
    'data:importSocialCsvFileWithMapping',
    async (_event, filePath: string, mapping: SocialCsvMapping): Promise<IdentityImportResult> => {
      const textColumn = mapping?.textColumn?.trim()
      if (!textColumn) {
        throw new Error('CSV mapping requires a text column.')
      }
      const events = await importSocialCsvEvents(filePath, {
        textColumn,
        dateColumn: mapping.dateColumn?.trim() || undefined,
        authorColumn: mapping.authorColumn?.trim() || undefined,
        recipientColumn: mapping.recipientColumn?.trim() || undefined,
        channelColumn: mapping.channelColumn?.trim() || undefined,
        idColumn: mapping.idColumn?.trim() || undefined,
      })
      const merged = await upsertIdentityEvents(events)
      return {
        source: 'social_csv',
        imported: merged.imported,
        totalAfterImport: merged.totalAfterImport,
      }
    },
  )

  ipcMain.handle('reddit:loadLatest', async () => {
    const datasetPath = path.join(app.getPath('userData'), 'reddit.normalized.json')
    try {
      const raw = await readFile(datasetPath, 'utf8')
      return JSON.parse(raw)
    } catch {
      return null
    }
  })

  ipcMain.handle('data:loadTimeline', async () => {
    return loadIdentityTimeline()
  })

  ipcMain.handle('data:sourceCounts', async () => {
    return getIdentitySourceCounts()
  })

  ipcMain.handle('data:debugMemoryInspector', async () => {
    const timeline = await loadIdentityTimeline()
    const dataset = await loadDatasetFromDisk()

    const toMs = (s: string | null | undefined) => {
      if (!s) return null
      const ms = Date.parse(s)
      return Number.isFinite(ms) ? ms : null
    }

    const summarizeDates = (values: Array<string | null | undefined>) => {
      let min: number | null = null
      let max: number | null = null
      for (const v of values) {
        const m = toMs(v)
        if (m == null) continue
        if (min == null || m < min) min = m
        if (max == null || m > max) max = m
      }
      if (min == null || max == null) return { minIso: null as string | null, maxIso: null as string | null }
      return { minIso: new Date(min).toISOString(), maxIso: new Date(max).toISOString() }
    }

    const events = timeline?.events ?? []
    const bySource: Record<string, number> = {}
    for (const e of events) bySource[e.source] = (bySource[e.source] ?? 0) + 1

    const eventDateRange = summarizeDates(events.map((e) => e.createdAt))

    const sampleBySource: Record<string, Array<{ createdAt: string | null; channel: string | null; text: string }>> = {}
    for (const e of events) {
      const k = e.source
      if (!sampleBySource[k]) sampleBySource[k] = []
      if (sampleBySource[k].length >= 3) continue
      sampleBySource[k].push({
        createdAt: e.createdAt ?? null,
        channel: e.channel ?? null,
        text: (e.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 240),
      })
    }

    const redditStats = (() => {
      if (!dataset) {
        return {
          hasDataset: false,
          counts: null as null | Record<string, number>,
          dateRange: { minIso: null as string | null, maxIso: null as string | null },
        }
      }
      const allDates: Array<string | null | undefined> = [
        ...dataset.comments.map((c) => c.createdAt),
        ...dataset.posts.map((p) => p.createdAt),
        ...dataset.saved.map((s) => s.createdAt),
        ...dataset.upvoted.map((u) => u.createdAt),
      ]
      return {
        hasDataset: true,
        counts: {
          comments: dataset.comments.length,
          posts: dataset.posts.length,
          saved: dataset.saved.length,
          upvoted: dataset.upvoted.length,
        },
        dateRange: summarizeDates(allDates),
      }
    })()

    return {
      identityTimeline: {
        hasTimeline: timeline != null,
        totalEvents: events.length,
        bySource,
        dateRange: eventDateRange,
        samples: sampleBySource,
      },
      redditDataset: redditStats,
    }
  })

  ipcMain.handle('reddit:clearLatest', async () => {
    const datasetPath = path.join(app.getPath('userData'), 'reddit.normalized.json')
    try {
      await unlink(datasetPath)
      return true
    } catch {
      return false
    }
  })

  ipcMain.handle('voice:loadProfile', async () => {
    return loadVoiceProfile()
  })

  ipcMain.handle('identity:loadProfile', async () => {
    return loadIdentityLearningProfile()
  })

  ipcMain.handle('voice:clearProfile', async () => {
    return clearVoiceProfile()
  })

  // Training control state
  let trainingControl: ReturnType<typeof createTrainingControl> | null = null

  ipcMain.handle('voice:trainProfile', async (_, resumeFromCheckpoint = false) => {
    if (!mainWindow) throw new Error('Main window not ready')

    const datasetPath = path.join(app.getPath('userData'), 'reddit.normalized.json')
    let dataset: RedditDataset | null = null
    try {
      const raw = await readFile(datasetPath, 'utf8')
      dataset = JSON.parse(raw) as RedditDataset
    } catch {
      throw new Error('No Reddit dataset found. Import your Reddit export first.')
    }

    let lastTrainPercent = 0
    const sendTrainProgress = (p: RedditImportProgress) => {
      const nextPercent = Number.isFinite(p.percent) ? Math.max(0, Math.min(100, p.percent)) : lastTrainPercent
      lastTrainPercent = Math.max(lastTrainPercent, nextPercent)
      mainWindow?.webContents.send('voice:trainProgress', {
        ...p,
        stage: 'training',
        percent: lastTrainPercent,
      })
    }

    sendTrainProgress({
      stage: 'training',
      percent: resumeFromCheckpoint ? -1 : 0, // -1 indicates resuming
      message: resumeFromCheckpoint ? 'Resuming voice training from checkpoint…' : 'Starting voice training…',
    })

    const originalLog = console.log
    const originalWarn = console.warn
    const originalError = console.error
    const forward = (level: 'log' | 'warn' | 'error', args: unknown[]) => {
      try {
        const text = args
          .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
          .join(' ')
        sendTrainProgress({
          stage: 'training',
          percent: lastTrainPercent,
          message: `[${level}] ${text}`,
        })
      } catch {
        // ignore
      }
    }

    console.log = (...args: unknown[]) => {
      forward('log', args)
      originalLog(...args)
    }
    console.warn = (...args: unknown[]) => {
      forward('warn', args)
      originalWarn(...args)
    }
    console.error = (...args: unknown[]) => {
      forward('error', args)
      originalError(...args)
    }

    // Create training control
    trainingControl = createTrainingControl()

    try {
      // Use unified trainVoice which picks Granite if available, else Gemini
      const profile = await trainVoice(dataset, {
        onProgress: (p) => sendTrainProgress(p),
        resumeFromCheckpoint,
        control: trainingControl,
        includeContactProfiles: true, // Build per-contact style profiles
        preferGranite: true, // Use Granite if watsonx credentials are set
      })
      await saveVoiceProfile(profile)
      sendTrainProgress({
        stage: 'training',
        percent: 100,
        message: 'Voice training complete.',
      })
      trainingControl = null
      return profile
    } catch (e) {
      const details = e instanceof Error ? e.message : String(e)
      mainWindow.webContents.send('voice:trainProgress', {
        stage: 'training',
        percent: lastTrainPercent,
        message: `Training paused: ${details}`,
      })
      trainingControl = null
      throw e
    } finally {
      console.log = originalLog
      console.warn = originalWarn
      console.error = originalError
    }
  })

  ipcMain.handle('voice:pauseTraining', () => {
    if (trainingControl) {
      trainingControl.pause()
      return true
    }
    return false
  })

  ipcMain.handle('voice:resumeTraining', () => {
    if (trainingControl) {
      trainingControl.resume()
      return true
    }
    return false
  })

  ipcMain.handle('voice:abortTraining', () => {
    if (trainingControl) {
      trainingControl.abort()
      trainingControl = null
      return true
    }
    return false
  })

  ipcMain.handle('voice:hasCheckpoint', async () => {
    const checkpoint = await loadVoiceCheckpoint()
    return checkpoint !== null
  })

  // Get all contact profiles for UI dropdown
  ipcMain.handle('contact:getAll', async () => {
    const { getAllContactProfiles } = await import('./contactProfileStore.js')
    return getAllContactProfiles()
  })

  // Knowledge store handlers
  ipcMain.handle('knowledge:getAll', async () => {
    const { getAllEntities } = await import('./knowledgeStore.js')
    return getAllEntities()
  })

  ipcMain.handle('knowledge:getByType', async (_event, type: string) => {
    const { loadKnowledgeStore, findEntitiesByType } = await import('./knowledgeStore.js')
    const store = await loadKnowledgeStore()
    return findEntitiesByType(store, type as import('./knowledgeStore.js').EntityType)
  })

  ipcMain.handle('knowledge:delete', async (_event, entityId: string) => {
    const { loadKnowledgeStore, saveKnowledgeStore, deleteEntity } = await import('./knowledgeStore.js')
    const store = await loadKnowledgeStore()
    await deleteEntity(store, entityId)
    await saveKnowledgeStore(store)
    return { success: true }
  })

  ipcMain.handle('knowledge:clear', async () => {
    const { clearKnowledgeStore } = await import('./knowledgeStore.js')
    await clearKnowledgeStore()
    return { success: true }
  })

  ipcMain.handle('identity:learnProfile', async () => {
    if (!mainWindow) throw new Error('Main window not ready')
    const sendProgress = (p: RedditImportProgress) => {
      mainWindow?.webContents.send('identity:learnProgress', p)
    }

    sendProgress({
      stage: 'analyzing',
      percent: 0,
      message: 'Preparing identity analysis…',
    })

    const reddit = await loadDatasetFromDisk()
    const timeline = await loadIdentityTimeline()
    if (!reddit && !timeline) {
      throw new Error('No data found yet. Import Reddit or other portals first.')
    }

    const profile = await learnIdentityProfile(reddit, timeline, (p) => sendProgress(p))
    await saveIdentityLearningProfile(profile)
    sendProgress({
      stage: 'done',
      percent: 100,
      message: 'Identity analysis complete.',
    })
    return profile
  })

  ipcMain.handle(
    'reddit:search',
    async (
      _event,
      query: string,
      opts?: {
        limit?: number
        include?: Array<'comments' | 'posts' | 'saved' | 'upvoted'>
      },
    ): Promise<RedditSearchResult[]> => {
      const q = (query ?? '').trim().toLowerCase()
      if (q.length < 2) return []

      const datasetPath = path.join(app.getPath('userData'), 'reddit.normalized.json')
      let dataset: RedditDataset | null = null
      try {
        const raw = await readFile(datasetPath, 'utf8')
        dataset = JSON.parse(raw) as RedditDataset
      } catch {
        return []
      }

      const limit = Math.max(1, Math.min(100, opts?.limit ?? 25))
      const include = new Set(opts?.include ?? ['comments', 'posts'])

      function makeSnippet(text: string, idx: number) {
        const start = Math.max(0, idx - 80)
        const end = Math.min(text.length, idx + 160)
        return text.slice(start, end).replace(/\s+/g, ' ').trim()
      }

      const results: RedditSearchResult[] = []

      if (include.has('comments')) {
        for (const c of dataset.comments) {
          const body = (c.body ?? '').toLowerCase()
          const hit = body.indexOf(q)
          if (hit === -1) continue
          results.push({
            kind: 'comment',
            id: c.id,
            subreddit: c.subreddit,
            createdAt: c.createdAt,
            permalink: c.permalink,
            snippet: makeSnippet(c.body ?? '', hit),
            score: c.score ?? undefined,
          })
          if (results.length >= limit) break
        }
      }

      if (results.length < limit && include.has('posts')) {
        for (const p of dataset.posts) {
          const text = `${p.title ?? ''}\n${p.body ?? ''}`
          const lower = text.toLowerCase()
          const hit = lower.indexOf(q)
          if (hit === -1) continue
          results.push({
            kind: 'post',
            id: p.id,
            subreddit: p.subreddit,
            createdAt: p.createdAt,
            permalink: p.permalink,
            title: p.title,
            snippet: makeSnippet(text, hit),
            score: p.score ?? undefined,
          })
          if (results.length >= limit) break
        }
      }

      if (results.length < limit && include.has('saved')) {
        for (const s of dataset.saved) {
          const text = `${s.title ?? ''}\n${s.permalink ?? ''}`
          const lower = text.toLowerCase()
          const hit = lower.indexOf(q)
          if (hit === -1) continue
          results.push({
            kind: 'saved',
            id: s.id,
            subreddit: s.subreddit,
            createdAt: s.createdAt,
            permalink: s.permalink,
            title: s.title,
            snippet: makeSnippet(text, hit),
          })
          if (results.length >= limit) break
        }
      }

      if (results.length < limit && include.has('upvoted')) {
        for (const u of dataset.upvoted) {
          const text = `${u.title ?? ''}\n${u.permalink ?? ''}`
          const lower = text.toLowerCase()
          const hit = lower.indexOf(q)
          if (hit === -1) continue
          results.push({
            kind: 'upvoted',
            id: u.id,
            subreddit: u.subreddit,
            createdAt: u.createdAt,
            permalink: u.permalink,
            title: u.title,
            snippet: makeSnippet(text, hit),
          })
          if (results.length >= limit) break
        }
      }

      return results
    },
  )

  ipcMain.handle('shell:openExternal', async (_event, url: string) => {
    if (!url) return false
    try {
      await shell.openExternal(url)
      return true
    } catch {
      return false
    }
  })

  ipcMain.handle('writeAgent:health', async () => {
    return checkGeminiHealth()
  })

  ipcMain.handle(
    'writeAgent:generate',
    async (
      event,
      input: WriteAgentRequest & {
        requestId: string
      },
    ) => {
      const requestId = input.requestId
      const sendChunk = (payload: Omit<WriteAgentChunkEvent, 'requestId'>) => {
        event.sender.send('writeAgent:chunk', { requestId, ...payload } satisfies WriteAgentChunkEvent)
      }
      const sendDone = (payload: Omit<WriteAgentDoneEvent, 'requestId'>) => {
        event.sender.send('writeAgent:done', { requestId, ...payload } satisfies WriteAgentDoneEvent)
      }
      const sendError = (payload: Omit<WriteAgentErrorEvent, 'requestId'>) => {
        event.sender.send('writeAgent:error', { requestId, ...payload } satisfies WriteAgentErrorEvent)
      }

      try {
        const health = await checkGeminiHealth()
        if (!health.ok) {
          throw new Error(health.message ?? 'Gemini is not configured.')
        }

        const voiceProfile = await loadVoiceProfile()
        if (!voiceProfile) {
          throw new Error('Voice profile not ready yet. Run "Build a copy of me" first.')
        }

        const dataset = await loadDatasetFromDisk()
        if (!dataset) {
          throw new Error('No Reddit dataset found. Import your Reddit export first.')
        }

        // Extract contact name from topic if user mentions someone naturally
        // e.g., "Write a letter to Kevin about my new job" -> extracts "Kevin"
        const { extractContactFromQuery } = await import('./memory/retrieval.js')
        const { getAllContactProfiles } = await import('./contactProfileStore.js')
        const allContacts = await getAllContactProfiles()
        const knownContactNames = allContacts.map(c => c.contactName)
        const extractedContactName = input.contactName || extractContactFromQuery(input.topic, knownContactNames)
        
        // Load contact profile if a contact was mentioned
        const contactProfile = extractedContactName 
          ? await getContactProfile(extractedContactName) 
          : null
        const [identityProfile, identityTimeline] = await Promise.all([
          loadIdentityLearningProfile(),
          loadIdentityTimeline(),
        ])

        const model = input.model?.trim() || process.env.GEMINI_MODEL || 'gemini-2.5-flash'

        // Determine effective sliders (backward compatible):
        // - If explicit sliders provided, use them
        // - Else derive from voiceMode (+ optional blendFactor)
        const mode = input.voiceMode ?? 'personal_text'
        const derived = deriveSlidersForVoiceMode(mode)
        const effectiveSliders = (() => {
          if (input.sliders) return input.sliders
          const bf = clamp01(input.blendFactor ?? 0)
          if (bf <= 0) return derived

          // Blend is meant to interpolate between texting vs posting.
          // We treat personal_text ↔ public_post as the blend axis.
          const textMode = deriveSlidersForVoiceMode('personal_text')
          const postMode = deriveSlidersForVoiceMode('public_post')
          return blendSliders(textMode, postMode, bf)
        })()

        // === NEW RETRIEVAL PIPELINE (same as Model Chat) ===
        // 1. Full-corpus SMS retrieval (outbound only for style imitation)
        const smsRetrieval = retrieveSmsOutboundForWriteLikeMe(
          identityTimeline,
          input.topic,
          {
            contactName: extractedContactName, // Use extracted contact name
            maxMessages: 300, // Pull many, budget will trim
          },
        )

        // 2. Full-corpus Reddit retrieval (same scoring as Model Chat)
        const redditRetrieval = retrieveRedditForWriteLikeMe(dataset, input.topic, { maxSnippets: 150 })

        // 3. Gmail samples (from timeline)
        const gmailSamples = pickTimelineExamplesBySource(identityTimeline, input.topic, ['gmail'], 50)

        // 4. Apply source locks (exclude unchecked sources)
        const locks = input.sourceLocks ?? {}
        const filteredSms = locks.includeSms === false ? [] : smsRetrieval.messages
        const filteredReddit = locks.includeReddit === false ? [] : redditRetrieval.snippets
        const filteredGmail = locks.includeGmail === false ? [] : gmailSamples

        // 5. Context window budgeting based on mode priority
        const budgeted = budgetContextWindow(
          mode,
          filteredSms,
          filteredReddit,
          filteredGmail,
          { maxTokens: 25000 }, // Leave room for prompt + response
        )

        // 6. Compute style envelope from FULL retrieved SMS set (not just 8 samples)
        //    If SMS is locked out, don't compute a style envelope (use defaults from voice profile)
        const styleEnvelope = budgeted.sms.length > 0 
          ? computeStyleEnvelopeFromSmsExamples(budgeted.sms)
          : null

        // 6. Combine for prompt (budgeted already respects mode priority)
        const examples = [
          ...budgeted.sms,
          ...budgeted.reddit,
          ...budgeted.gmail,
        ].filter((t) => typeof t === 'string' && t.trim().length > 0)

        // Debug logging
        console.log('[WriteLikeMe] Retrieval stats:', {
          mode,
          topic: input.topic,
          contactName: extractedContactName ?? '(none)',
          sms: {
            totalCandidates: smsRetrieval.stats.totalCandidates,
            topicMatches: smsRetrieval.stats.topicMatches,
            afterDedup: smsRetrieval.stats.afterDedup,
            budgeted: budgeted.sms.length,
          },
          reddit: {
            totalCandidates: redditRetrieval.stats.totalCandidates,
            afterDedup: redditRetrieval.stats.afterDedup,
            budgeted: budgeted.reddit.length,
          },
          gmail: {
            total: gmailSamples.length,
            budgeted: budgeted.gmail.length,
          },
          styleEnvelope: styleEnvelope ? {
            avgWords: styleEnvelope.avgWords,
            medianWords: styleEnvelope.medianWords,
            targetWords: styleEnvelope.targetWords,
            questionRate: styleEnvelope.questionRate,
            exclaimRate: styleEnvelope.exclaimRate,
            emojiRate: styleEnvelope.emojiRate,
            lowercaseStartRate: styleEnvelope.lowercaseStartRate,
          } : null,
          totalExamples: examples.length,
          estimatedTokens: budgeted.estimatedTokens,
        })

        // Load recent conversation memory for context
        const { 
          loadConversations, 
          formatConversationMemory, 
          saveConversation,
          generateConversationId,
        } = await import('./writeAgentMemory.js')
        const recentConversations = await loadConversations()
        const conversationMemoryBlock = formatConversationMemory(recentConversations)

        // Load relevant knowledge facts
        const { 
          loadKnowledgeStore, 
          getRelevantEntities, 
          formatEntitiesForPrompt 
        } = await import('./knowledgeStore.js')
        const knowledgeStore = await loadKnowledgeStore()
        const relevantEntities = getRelevantEntities(knowledgeStore, input.topic, extractedContactName)
        const knowledgeFactsBlock = formatEntitiesForPrompt(relevantEntities)

        const prompt = buildWriteLikeMePrompt({
          handle: input.handle,
          topic: input.topic,
          sliders: effectiveSliders,
          voiceProfile,
          examples,
          styleEnvelope: styleEnvelope ?? undefined,
          identityProfile,
          crossPlatformSamples: [], // Replaced by full retrieval pipeline
          contactProfile, // Only loaded when contactName was specified
          conversationMemory: conversationMemoryBlock,
          knowledgeFacts: knowledgeFactsBlock,
        })

        const geminiModel = getGeminiModel(model)
        const timeoutMs =
          Number.isFinite(GEMINI_STREAM_TIMEOUT_MS) && GEMINI_STREAM_TIMEOUT_MS > 0
            ? GEMINI_STREAM_TIMEOUT_MS
            : 120_000

        const streamedText = await withTimeout(
          (async () => {
            let text = ''
            const result = await geminiModel.generateContentStream(prompt)
            for await (const chunk of result.stream) {
              const piece = chunk.text()
              if (!piece) continue
              text += piece
              sendChunk({ chunk: piece, text })
            }
            return text
          })(),
          timeoutMs,
          'Gemini write stream',
        )

        // Save conversation to memory for future context
        await saveConversation({
          id: generateConversationId(),
          timestamp: new Date().toISOString(),
          topic: input.topic,
          contactName: extractedContactName,
          request: input.topic,
          response: streamedText,
          voiceMode: mode,
          metadata: {
            hadInsufficientData: !contactProfile && !!extractedContactName,
            dataNote: !contactProfile && !!extractedContactName 
              ? `No contact profile found for ${extractedContactName}` 
              : undefined,
          },
        })

        sendDone({ text: streamedText, model })
        return { text: streamedText, model }
      } catch (e) {
        const details = e instanceof Error ? e.message : String(e)
        sendError({ error: details })
        throw new Error(details)
      }
    },
  )

  ipcMain.handle(
    'twin:askGemini',
    async (
      _event,
      input: string | { question: string; timeWindowDays?: number; styleLine?: string; cutoffDateIso?: string },
    ) => {
      const question = typeof input === 'string' ? input : input.question
      const timeWindowDays = typeof input === 'string' ? undefined : input.timeWindowDays
      const styleLine = typeof input === 'string' ? undefined : input.styleLine
      const cutoffDateIso = typeof input === 'string' ? undefined : input.cutoffDateIso
      const isWriteLikeMe = typeof input !== 'string' && typeof input.styleLine === 'string'

      const voiceProfile = await loadVoiceProfile()
      const identityProfile = await loadIdentityLearningProfile()
      const identityTimeline = await loadIdentityTimeline()
      const dataset = await loadDatasetFromDisk()

      const q = (question ?? '').trim().toLowerCase()
      const asksLexicalStats = /\b(common|commonly|frequent|most used|use most|words?|phrases?|sayings?|terms?)\b/.test(q)
      const quotedPhrase = (() => {
        const m = (question ?? '').match(/"([^"]{2,120})"/)
        return m?.[1]?.trim() || null
      })()
      const yearsAgoMatch = q.match(/\b(\d{1,2})\s+years?\s+ago\b/)

      function toMs(s: string | null) {
        if (!s) return null
        const ms = Date.parse(s)
        return Number.isFinite(ms) ? ms : null
      }

      const upperBoundMs = cutoffDateIso ? toMs(cutoffDateIso) : null
      const lowerBoundMs =
        timeWindowDays != null && dataset
          ? (() => {
              const allDates: number[] = []
              for (const c of dataset.comments) {
                const ms = toMs(c.createdAt)
                if (ms != null) allDates.push(ms)
              }
              for (const p of dataset.posts) {
                const ms = toMs(p.createdAt)
                if (ms != null) allDates.push(ms)
              }
              for (const s of dataset.saved) {
                const ms = toMs(s.createdAt)
                if (ms != null) allDates.push(ms)
              }
              for (const u of dataset.upvoted) {
                const ms = toMs(u.createdAt)
                if (ms != null) allDates.push(ms)
              }
              const maxMs = allDates.length > 0 ? Math.max(...allDates) : Date.now()
              return maxMs - Math.max(1, timeWindowDays) * 24 * 60 * 60 * 1000
            })()
          : null

      function withinWindow(createdAt: string | null | undefined) {
        if (!createdAt) return true
        const ms = Date.parse(createdAt)
        if (!Number.isFinite(ms)) return true
        if (lowerBoundMs != null && ms < lowerBoundMs) return false
        if (upperBoundMs != null && ms > upperBoundMs) return false
        return true
      }

      const identityContextBlock = (() => {
        const events = (identityTimeline?.events ?? []).filter((e) => withinWindow(e.createdAt))
        const bySource: Record<string, number> = {}
        for (const e of events) bySource[e.source] = (bySource[e.source] ?? 0) + 1

        const topSources = Object.entries(bySource)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 12)
          .map(([source, count]) => `- ${source}: ${count.toLocaleString()}`)
          .join('\n')

        const recentBySource = (source: string, take: number, filter?: (e: IdentityEvent) => boolean) => {
          const rows = events
            .filter((e) => e.source === source)
            .filter((e) => (filter ? filter(e) : true))
            .sort((a, b) => (a.createdAt ?? '') < (b.createdAt ?? '') ? 1 : -1)
            .slice(0, take)
          return rows
            .map((e) => {
              const date = e.createdAt?.slice(0, 10) ?? 'no date'
              const channel = e.channel ? ` (${e.channel})` : ''
              const text = (e.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 220)
              return `- [${date}]${channel} ${text}`
            })
            .join('\n')
        }

        // Compute top SMS contacts by message count
        const smsContacts: Record<string, number> = {}
        for (const e of events) {
          if (e.source !== 'sms') continue
          const participants = e.participants ?? []
          for (const p of participants) {
            if (p && p !== 'Me') smsContacts[p] = (smsContacts[p] ?? 0) + 1
          }
        }
        const topSmsContacts = Object.entries(smsContacts)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 20)
          .map(([name, count]) => `- ${name}: ${count.toLocaleString()} messages`)
          .join('\n')

        // SMS with participants for context
        const smsWithParticipants = events
          .filter((e) => e.source === 'sms')
          .sort((a, b) => (a.createdAt ?? '') < (b.createdAt ?? '') ? 1 : -1)
          .slice(0, 200)
          .map((e) => {
            const date = e.createdAt?.slice(0, 10) ?? 'no date'
            const participants = (e.participants ?? []).filter((p) => p).join(', ')
            const text = (e.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 150)
            const fromMe = e.metadata?.isUserMessage ? ' [Me]' : ''
            return `- [${date}]${fromMe} with: ${participants || 'unknown'} | ${text}`
          })
          .join('\n')

        // Top Chrome domains
        const chromeDomains: Record<string, number> = {}
        for (const e of events) {
          if (e.source !== 'chrome' || !e.metadata?.url) continue
          try {
            const url = new URL(e.metadata.url as string)
            const domain = url.hostname.replace(/^www\./, '')
            chromeDomains[domain] = (chromeDomains[domain] ?? 0) + 1
          } catch {}
        }
        const topChromeDomains = Object.entries(chromeDomains)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 30)
          .map(([domain, count]) => `- ${domain}: ${count.toLocaleString()} visits`)
          .join('\n')

        // YouTube watch history
        const youtubeHistory = events
          .filter((e) => e.source === 'youtube')
          .sort((a, b) => (a.createdAt ?? '') < (b.createdAt ?? '') ? 1 : -1)
          .slice(0, 100)
          .map((e) => {
            const date = e.createdAt?.slice(0, 10) ?? 'no date'
            const text = (e.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 120)
            return `- [${date}] ${text}`
          })
          .join('\n')

        const recentChrome = recentBySource('chrome', 10)
        const recentGmail = recentBySource('gmail', 5)
        const recentVoice = recentBySource('google_voice', 5)

        return `# IMPORTED IDENTITY TIMELINE (non-Reddit memory)
The app has a local Identity Timeline containing events from multiple sources. Use this to answer questions about the user's life, contacts, and activities.

## Total Counts by Source:
${topSources || '(no identity timeline data loaded)'}

## SMS Analysis:
Top contacts by message count:
${topSmsContacts || '(no SMS contacts found)'}

Recent SMS messages (with participants):
${smsWithParticipants || '(none)'}

## Chrome Browsing:
Top 30 domains by visit count:
${topChromeDomains || '(no Chrome data)'}

Recent visits:
${recentChrome || '(none)'}

## YouTube Watch History (recent 100):
${youtubeHistory || '(none)'}

## Gmail (recent):
${recentGmail || '(none)'}

## Google Voice (recent):
${recentVoice || '(none)'}`
      })()

      // Deterministic SMS queries (avoid LLM hallucinations for lookup-style questions)
      const smsEvents = (identityTimeline?.events ?? []).filter((e) => e.source === 'sms').filter((e) => withinWindow(e.createdAt))

      const normalizePerson = (s: string) =>
        s
          .toLowerCase()
          .replace(/[^a-z0-9\s]/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()

      const participantMatches = (participants: unknown, target: string) => {
        if (!Array.isArray(participants)) return false
        const t = normalizePerson(target)
        if (!t) return false
        return participants.some((p) => {
          if (typeof p !== 'string') return false
          const n = normalizePerson(p)
          return n === t || n.includes(t) || t.includes(n)
        })
      }

      const extractAfterWith = (raw: string) => {
        const m = raw.match(/\bwith\s+(.+?)\s*\??\s*$/i)
        return m?.[1]?.trim() || null
      }

      const extractQuotedOrTrailingName = (raw: string) => {
        const mQuoted = raw.match(/"([^"]{2,80})"/)
        if (mQuoted?.[1]) return mQuoted[1].trim()
        const mTail = raw.match(/\b(?:with|containing|for)\s+(.+?)\s*\??\s*$/i)
        return mTail?.[1]?.trim() || null
      }

      // 1) "Who do I text most?"
      if (/\bwho\s+do\s+i\s+text\s+the\s+most\b/.test(q) || /\bwho\s+do\s+i\s+text\s+most\b/.test(q)) {
        const counts: Record<string, number> = {}
        for (const e of smsEvents) {
          const participants = Array.isArray(e.participants) ? e.participants : []
          for (const p of participants) {
            if (typeof p !== 'string') continue
            if (normalizePerson(p) === 'me') continue
            counts[p] = (counts[p] ?? 0) + 1
          }
        }
        const top = Object.entries(counts)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 15)
        if (top.length === 0) return { answer: 'I could not find any SMS events to compute this.', sources: [] }
        const [winner, winnerCount] = top[0]
        const lines = top.map(([name, c]) => `- ${name}: ${c.toLocaleString()} messages`).join('\n')
        return {
          answer: `Based on your imported SMS timeline, the person you text most is: ${winner} (${winnerCount.toLocaleString()} messages).\n\nTop contacts:\n${lines}`,
          sources: [],
        }
      }

      // 2) "List/show texts with <name>" and "most recent text with <name>"
      const withName = extractAfterWith(question ?? '')
      const lookupName = withName || extractQuotedOrTrailingName(question ?? '')
      const wantsMostRecent = /\bmost\s+recent\s+text\b/i.test(question ?? '')
      const wantsList = /\b(list|show)\b/i.test(question ?? '') && /\btexts?\b/i.test(question ?? '')
      if (lookupName && (wantsMostRecent || wantsList)) {
        const hits = smsEvents
          .filter((e) => participantMatches(e.participants, lookupName))
          .sort((a, b) => (a.createdAt ?? '') < (b.createdAt ?? '') ? 1 : -1)
        if (hits.length === 0) {
          return {
            answer: `I found 0 SMS messages with a participant matching: ${lookupName}. If the name is stored differently (nickname, phone, full name), try another spelling.`,
            sources: [],
          }
        }

        if (wantsMostRecent) {
          const e = hits[0]
          const date = e.createdAt ?? '(no date)'
          const fromMe = e.metadata?.isUserMessage ? 'Me' : 'Them'
          const participants = Array.isArray(e.participants) ? e.participants.filter((p) => typeof p === 'string').join(', ') : 'unknown'
          const text = (e.text ?? '').trim()
          return {
            answer: `Most recent SMS with ${lookupName}:\n\nDate: ${date}\nFrom: ${fromMe}\nParticipants: ${participants}\n\n${text}`,
            sources: [],
          }
        }

        const take = Math.min(50, hits.length)
        const lines = hits.slice(0, take).map((e) => {
          const date = e.createdAt?.slice(0, 19) ?? 'no date'
          const fromMe = e.metadata?.isUserMessage ? 'Me' : 'Them'
          const text = (e.text ?? '').replace(/\s+/g, ' ').trim()
          return `- [${date}] ${fromMe}: ${text}`
        })
        return {
          answer: `Showing ${take} most recent SMS messages with ${lookupName} (of ${hits.length} found):\n\n${lines.join('\n')}`,
          sources: [],
        }
      }

      // 3) All-time conversation summarization with a specific contact
      // Example queries:
      // - "summarize my conversation with Kevin"
      // - "summarize texts with \"Michelle Joni\""
      const wantsSummary = /\b(summarize|summary|recap|overview)\b/i.test(question ?? '')
      const mentionsConversation = /\b(conversation|texts?|messages?|sms)\b/i.test(question ?? '')

      // 3a) Disclosure query: "Does X know about Y?" or "Did I tell X about Y?"
      // Uses evidenceOfDisclosure for epistemic honesty
      const disclosureQuery = detectDisclosureQuery(question ?? '', Array.from(new Set(smsEvents.flatMap(e => e.participants ?? []).filter(Boolean))))
      if (!isWriteLikeMe && disclosureQuery.isDisclosure && disclosureQuery.contact && disclosureQuery.topic) {
        const discMemoryStore = await loadMemoryStore()
        const result = evidenceOfDisclosure(smsEvents, disclosureQuery.contact, disclosureQuery.topic, discMemoryStore)
        
        // Use Gemini for natural language answer
        const prompt = buildDisclosurePrompt(result)
        const llm = await answerWithPrompt(prompt, [])
        
        return {
          answer: llm.answer,
          sources: [],
        }
      }

      // 3b) Contact + topic retrieval (evidence-first)
      // Example: "what did I tell Michelle about the bus?"
      const wantsTold = /\bwhat\s+did\s+i\s+tell\b/i.test(question ?? '')
      const aboutMatch = (question ?? '').match(/\babout\s+(.+?)\s*\??\s*$/i)
      const aboutTopicRaw = aboutMatch?.[1]?.trim() || null
      if (!isWriteLikeMe && lookupName && wantsTold && aboutTopicRaw) {
        const contactHits = smsEvents
          .filter((e) => participantMatches(e.participants, lookupName))
          .sort((a, b) => (a.createdAt ?? '') < (b.createdAt ?? '') ? -1 : 1)

        if (contactHits.length === 0) {
          return {
            answer: `I couldn't find any SMS messages with a participant matching: ${lookupName}. Try another spelling (nickname/phone/full name).`,
            sources: [],
          }
        }

        const topicTokens = words(aboutTopicRaw)
          .map((t) => t.toLowerCase())
          .filter((t) => t.length >= 3 && !STOPWORDS.has(t))

        if (topicTokens.length === 0) {
          return {
            answer: `I couldn't extract a usable topic from: "${aboutTopicRaw}". Try a more specific keyword.`,
            sources: [],
          }
        }

        const formatSmsEvidence = (e: IdentityEvent) => {
          const ts = e.createdAt?.slice(0, 19) ?? 'no date'
          const fromMe = e.metadata?.isUserMessage ? 'Me' : 'Them'
          const txt = (e.text ?? '').replace(/\s+/g, ' ').trim()
          return `- [${ts}] ${fromMe}: ${txt}`
        }

        // Score by token matches + favor longer texts slightly
        const scored = contactHits
          .map((e) => {
            const txt = (e.text ?? '').toLowerCase()
            let score = 0
            for (const t of topicTokens) if (txt.includes(t)) score += 1
            score += Math.min(0.5, (e.text?.length ?? 0) / 6000)
            return { e, score }
          })
          .filter((r) => r.score > 0)
          .sort((a, b) => b.score - a.score)

        if (scored.length === 0) {
          return {
            answer: `I couldn't find any messages with ${lookupName} that mention: ${topicTokens.join(', ')}.`,
            sources: [],
          }
        }

        const topEvidence = scored.slice(0, 25).map((r) => r.e)
        const evidenceText = topEvidence.map(formatSmsEvidence).join('\n')

        const prompt = `You are answering a question about what the user told a specific contact.

IMPORTANT RULES:
- You ONLY have access to the SMS messages shown in EVIDENCE below.
- Do NOT guess or infer details not present in the evidence.

Question:
${question}

EVIDENCE (most relevant messages, not exhaustive):
${evidenceText}

Answer with:
1) A direct answer in 1-3 sentences.
2) A short bullet list of supporting quotes (with timestamps) from EVIDENCE.
`

        const llm = await answerWithPrompt(prompt, [])
        return {
          answer: `EVIDENCE (top matches):\n${evidenceText}\n\nSUMMARY:\n${llm.answer}`,
          sources: [],
        }
      }
      if (!isWriteLikeMe && wantsSummary && mentionsConversation && lookupName) {
        const hits = smsEvents
          .filter((e) => participantMatches(e.participants, lookupName))
          .sort((a, b) => (a.createdAt ?? '') < (b.createdAt ?? '') ? -1 : 1)

        if (hits.length === 0) {
          return {
            answer: `I couldn't find any SMS messages with a participant matching: ${lookupName}. Try another spelling (nickname/phone/full name).`,
            sources: [],
          }
        }

        const formatSmsLine = (e: IdentityEvent) => {
          const ts = e.createdAt?.slice(0, 19) ?? 'no date'
          const fromMe = e.metadata?.isUserMessage ? 'Me' : 'Them'
          const text = (e.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 320)
          return `- [${ts}] ${fromMe}: ${text}`
        }

        // Month-based hierarchical summarization with cache
        const contactKey = stableContactKey(lookupName)
        const fingerprint = `${hits.length}:${hits[0]?.createdAt ?? ''}:${hits[hits.length - 1]?.createdAt ?? ''}`
        const cache = await loadSmsMonthlySummaryCache()
        const contactCache = cache.contacts[contactKey] ?? { fingerprint: '', monthly: {} }
        if (!contactCache.monthly) contactCache.monthly = {}

        // If the underlying messages changed, reset monthly summaries for this contact
        if (contactCache.fingerprint !== fingerprint) {
          contactCache.fingerprint = fingerprint
          contactCache.monthly = {}
          delete contactCache.meta
        }

        // Group messages by month
        const byMonth = new Map<string, IdentityEvent[]>()
        for (const e of hits) {
          const mk = monthKeyFromIso(e.createdAt) ?? 'unknown'
          const arr = byMonth.get(mk) ?? []
          arr.push(e)
          byMonth.set(mk, arr)
        }

        // Simple per-contact knowledge state (deterministic): top topics + last mentioned + supporting quotes
        const topicCounts: Record<string, number> = {}
        const topicLastMentioned: Record<string, string> = {}
        const topicQuotes: Record<string, string[]> = {}
        for (const e of hits) {
          const ts = e.createdAt ?? ''
          const txt = (e.text ?? '').toLowerCase()
          for (const w of words(txt)) {
            if (w.length < 4) continue
            if (STOPWORDS.has(w)) continue
            topicCounts[w] = (topicCounts[w] ?? 0) + 1
            if (!topicLastMentioned[w] || topicLastMentioned[w] < ts) topicLastMentioned[w] = ts
          }
        }

        const topTopics = Object.entries(topicCounts)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 25)
          .map(([t]) => t)

        // Collect up to 2 supporting quotes for each top topic (most recent matches)
        for (const t of topTopics) topicQuotes[t] = []
        const topTopicSet = new Set(topTopics)
        for (let i = hits.length - 1; i >= 0; i--) {
          const e = hits[i]
          const txt = (e.text ?? '').replace(/\s+/g, ' ').trim()
          if (!txt) continue
          const lower = txt.toLowerCase()
          for (const t of topTopics) {
            if (!topTopicSet.has(t)) continue
            if (!lower.includes(t)) continue
            if (topicQuotes[t].length >= 2) continue
            const ts = e.createdAt?.slice(0, 19) ?? 'no date'
            const fromMe = e.metadata?.isUserMessage ? 'Me' : 'Them'
            topicQuotes[t].push(`[${ts}] ${fromMe}: ${txt.slice(0, 160)}`)
          }
          // early exit if most topics have quotes
          if (topTopics.every((t) => topicQuotes[t].length >= 2)) break
        }

        const months = Array.from(byMonth.keys()).sort()

        // Determine which months still need summaries
        const missingMonths = months.filter((m) => !contactCache.monthly[m])

        // Incremental build to control latency/cost per query.
        // We summarize up to N months per request, prioritizing (a) largest months, (b) earliest+latest.
        const maxNewMonthsPerRequest = 6
        const monthStats = months.map((m) => ({ m, n: (byMonth.get(m) ?? []).length }))
        const sortedBySize = [...monthStats].sort((a, b) => b.n - a.n).map((x) => x.m)
        const prioritized = (() => {
          const set = new Set<string>()
          if (months[0]) set.add(months[0])
          if (months[months.length - 1]) set.add(months[months.length - 1])
          for (const m of sortedBySize) set.add(m)
          return Array.from(set)
        })().filter((m) => missingMonths.includes(m))

        const toBuild = prioritized.slice(0, maxNewMonthsPerRequest)

        for (const m of toBuild) {
          const events = byMonth.get(m) ?? []
          const messageCount = events.length

          // Evidence selection per month: first/last + longest
          const first = events.slice(0, 5)
          const last = events.slice(Math.max(0, events.length - 5))
          const longest = [...events]
            .sort((a, b) => (b.text?.length ?? 0) - (a.text?.length ?? 0))
            .slice(0, 10)
          const evidence = [...first, ...last, ...longest]

          // De-dupe evidence by (createdAt,text)
          const seen = new Set<string>()
          const uniqEvidence: IdentityEvent[] = []
          for (const e of evidence) {
            const key = `${e.createdAt ?? ''}::${(e.text ?? '').slice(0, 80)}`
            if (seen.has(key)) continue
            seen.add(key)
            uniqEvidence.push(e)
          }
          const evidenceLines = uniqEvidence.map(formatSmsLine)

          const monthPrompt = `You are summarizing one month of a user's SMS conversation with a specific contact.

IMPORTANT RULES:
- You ONLY have access to the messages shown in EVIDENCE.
- Do NOT guess missing facts.
- If evidence is incomplete, say so.

Contact: ${lookupName}
Month: ${m}

EVIDENCE:
${evidenceLines.join('\n')}

Write a concise month summary with:
1) Key topics (bullets)
2) Notable events/plans (bullets, include timestamps when present)
3) Relationship/tone notes (1-3 bullets)
`

          const monthResp = await answerWithPrompt(monthPrompt, [])
          contactCache.monthly[m] = {
            summary: monthResp.answer,
            evidence: evidenceLines,
            messageCount,
            updatedAt: new Date().toISOString(),
          }
        }

        // Meta-summary from available monthly summaries (cached + newly built)
        const availableMonths = Object.keys(contactCache.monthly).sort()
        const monthSummaryBlocks = availableMonths
          .map((m) => {
            const s = contactCache.monthly[m]
            return `## ${m} (messages: ${s.messageCount})\n${s.summary}`
          })
          .join('\n\n')

        const metaPrompt = `You are producing an all-time summary of a user's SMS conversation with a specific contact based on per-month summaries.

IMPORTANT RULES:
- You ONLY have access to the per-month summaries shown below.
- Do NOT guess about months not present.
- If the coverage is partial, explicitly say so.

Contact: ${lookupName}
Available months: ${availableMonths.length} of ${months.length}

PER-MONTH SUMMARIES:
${monthSummaryBlocks}

OUTPUT FORMAT:
1) Coverage note (what months are included / missing)
2) High-level relationship/context (1-3 sentences)
3) Recurring themes/topics (bullets)
4) Notable events / plans (bullets)
5) Open loops / unresolved threads (bullets)
`

        const metaResp = await answerWithPrompt(metaPrompt, [])
        contactCache.meta = { summary: metaResp.answer, updatedAt: new Date().toISOString() }

        cache.contacts[contactKey] = contactCache
        await saveSmsMonthlySummaryCache(cache)

        const evidenceOut = availableMonths
          .slice(-12)
          .map((m) => {
            const s = contactCache.monthly[m]
            return `### Evidence for ${m} (sampled)\n${(s.evidence ?? []).slice(0, 20).join('\n')}`
          })
          .join('\n\n')

        const coverageLine = `Coverage: ${availableMonths.length}/${months.length} months summarized (built ${toBuild.length} new month summaries this request).`

        const knowledgeStateText = (() => {
          const lines: string[] = []
          for (const t of topTopics.slice(0, 15)) {
            const count = topicCounts[t] ?? 0
            const last = topicLastMentioned[t]?.slice(0, 10) ?? 'unknown'
            const quotes = (topicQuotes[t] ?? []).map((q) => `  - ${q}`).join('\n')
            lines.push(`- ${t} (${count} mentions, last: ${last})${quotes ? `\n${quotes}` : ''}`)
          }
          return lines.join('\n')
        })()

        return {
          answer: `${coverageLine}\n\nSUMMARY:\n${contactCache.meta.summary}\n\nKNOWLEDGE STATE (deterministic; derived from full conversation text):\n${knowledgeStateText || '(none)'}\n\nEVIDENCE (sampled; showing up to last 12 months with up to 20 lines each):\n${evidenceOut}`,
          sources: [],
        }
      }

      // OLLAMA-BASED SUMMARIZATION ROUTE
      // Uses local LLM for background compression ONLY.
      // Gemini generates the final answer using Ollama summaries + raw message samples.
      // Falls back to Gemini-based route above if Ollama not running.
      const ollamaAvailable = await isOllamaRunning()
      if (!isWriteLikeMe && ollamaAvailable && wantsSummary && mentionsConversation && lookupName) {
        const hits = smsEvents
          .filter((e) => participantMatches(e.participants, lookupName))
          .sort((a, b) => (a.createdAt ?? '') < (b.createdAt ?? '') ? -1 : 1)

        if (hits.length === 0) {
          // Fall through to Gemini route - will return "not found" message
        } else {
          const contactKey = stableContactKeyFromParticipants([lookupName])
          const memoryStore = await loadMemoryStore()

          // Chunk the SMS events
          const rawChunks = chunkSmsEvents(hits, { minPerChunk: 50, maxPerChunk: 200 })

          // Process chunks that need summarization (incremental, max 3 per request)
          const chunksToProcess = rawChunks
            .filter((c) => chunkNeedsProcessing(c, memoryStore))
            .slice(0, 3)

          for (const chunk of chunksToProcess) {
            const summary = await summarizeChunk(chunk)
            const memoryChunk = createMemoryChunk(chunk, summary, 'ollama-llama3.2')
            upsertMemoryChunk(memoryStore, memoryChunk)
          }

          // Save updated store
          await saveMemoryStore(memoryStore)

          // Get relevant memory for this contact
          const memory = getRelevantMemory(memoryStore, contactKey, { limit: 10 })

          // If we have chunks, generate meta-summary if not cached
          if (memory.chunks.length > 0 && !memory.metaSummary) {
            const summaries = memory.chunks.map((c) => ({
              summary: c.summary,
              topics: c.topics,
              notableEvents: c.notableEvents,
              tone: c.tone,
              confidence: c.confidence,
              sourceRange: c.sourceRange,
              messageCount: c.messageCount,
              knowledgeDeltas: c.knowledgeDeltas ?? [],
            }))
            const metaSummary = await summarizeMeta(contactKey, summaries)
            setMetaSummary(memoryStore, contactKey, metaSummary)
            memory.metaSummary = metaSummary
            await saveMemoryStore(memoryStore)
          }

          // Extract knowledge state if not cached
          if (memory.chunks.length > 0 && !memory.knowledgeState) {
            const ks = await extractKnowledgeState(contactKey, rawChunks)
            setKnowledgeState(memoryStore, contactKey, ks.topics)
            memory.knowledgeState = ks.topics
            await saveMemoryStore(memoryStore)
          }

          // Build context for Gemini: chunk summaries + RAW MESSAGE SAMPLES
          // Raw messages are GROUND TRUTH, summaries are ADVISORY
          const formatSmsLine = (e: IdentityEvent) => {
            const ts = e.createdAt?.slice(0, 19) ?? 'no date'
            const fromMe = e.metadata?.isUserMessage ? 'Me' : 'Them'
            const text = (e.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 200)
            return `[${ts}] ${fromMe}: ${text}`
          }

          // Get raw message samples from each chunk (first 3, last 3, longest 2)
          const rawSamplesByChunk = memory.chunks.map((chunk) => {
            const chunkEvents = hits.filter((e) => {
              const ms = e.createdAt ? Date.parse(e.createdAt) : NaN
              return Number.isFinite(ms) && ms >= chunk.startTime && ms <= chunk.endTime
            })
            const first3 = chunkEvents.slice(0, 3)
            const last3 = chunkEvents.slice(-3)
            const longest2 = [...chunkEvents]
              .sort((a, b) => (b.text?.length ?? 0) - (a.text?.length ?? 0))
              .slice(0, 2)
            const samples = [...first3, ...last3, ...longest2]
              .filter((e, i, arr) => arr.findIndex((x) => x.createdAt === e.createdAt && x.text === e.text) === i)
              .slice(0, 6)
            return {
              chunkId: chunk.id,
              conversationKey: chunk.conversationKey,
              samples: samples.map(formatSmsLine),
            }
          })

          const rawSamplesText = rawSamplesByChunk
            .map((c) => `### RAW MESSAGES [${c.conversationKey}] (GROUND TRUTH)\n${c.samples.join('\n')}`)
            .join('\n\n')

          const chunkSummariesText = memory.chunks
            .map((c) => {
              const confBadge = c.confidence >= 0.7 ? '✓' : c.confidence >= 0.4 ? '~' : '?'
              const dateStr = new Date(c.startTime).toISOString().slice(0, 10)
              return `[CHUNK ${dateStr}] (${c.messageCount} msgs, confidence: ${Math.round(c.confidence * 100)}% ${confBadge})\nAI Summary: ${c.summary}\nTopics: ${c.topics.join(', ')}`
            })
            .join('\n\n')

          // Build prompt for Gemini with clear hierarchy: raw = truth, summaries = advisory
          // Enforce evidence binding to prevent false narrative coherence
          const geminiPrompt = `You are summarizing a user's SMS conversation with a contact.

CRITICAL RULES - STRICT COMPLIANCE:
1. RAW MESSAGES below are GROUND TRUTH. Trust them over summaries.
2. AI SUMMARIES below are ADVISORY. They may contain errors or omissions.
3. For each claim you make, cite the chunk: [CHUNK YYYY-MM]
4. If raw messages contradict a summary, trust the raw messages.
5. If you're uncertain, say "based on available context" rather than guessing.
6. Do not combine unrelated topics unless the messages actually connect them.

EVIDENCE BINDING (NON-NEGOTIABLE):
- For EVERY claim, cite which chunk or message supports it
- If MULTIPLE interpretations exist, LIST THEM ALL (don't pick one)
- If evidence CONFLICTS, state the conflict explicitly - do NOT unify
- If evidence is MISSING for a topic, say "no direct evidence" rather than inferring
- Lower confidence summaries (marked ?) should be treated skeptically

CONFLICT HANDLING:
- If early messages say X and later messages say Y, report BOTH with time context
- Do not smooth over contradictions - they are part of the real story
- "The story changed over time" is a valid and valuable observation

CONTACT: ${lookupName}

---
## AI SUMMARIES (ADVISORY - may contain errors)
Confidence legend: ✓ high (≥70%), ~ medium (40-70%), ? low (<40%)
${chunkSummariesText || '(no chunk summaries yet)'}

---
## RAW MESSAGES (GROUND TRUTH - trust these)
${rawSamplesText || '(no raw messages sampled)'}

---
Provide:
1) Relationship context (who is this person, nature of contact)
2) Recurring topics/themes (cite chunks for each, note any conflicts)
3) Notable events or milestones (cite chunks)
4) How things evolved over time (early vs recent, cite chunks - note contradictions)
5) Anything important that summaries might have missed (from raw messages)
6) [OPTIONAL] Conflicting evidence: if messages contradict each other, list them`

          // Use Gemini for the final answer (not Ollama)
          const geminiAnswer = await answerWithPrompt(geminiPrompt, [])

          // Include drill-down hint for user
          const drillDownHint = `\n\n---\n💡 To see raw messages: "show texts with ${lookupName}" or "show messages with ${lookupName} from [date]"`

          return {
            answer: geminiAnswer.answer + drillDownHint,
            sources: [],
          }
        }
      }

      async function answerWithPrompt(prompt: string, sources: RedditSearchResult[]) {
        try {
          const model = getGeminiModel()
          const answer = await withTimeout(
            model.generateContent(prompt).then((r) => r.response.text()),
            45_000,
            'Gemini query-special',
          )
          return { answer: answer.trim(), sources }
        } catch (e) {
          const details = e instanceof Error ? e.message : String(e)
          return { answer: `AI backend error (Gemini). ${details}`, sources }
        }
      }

      if (!isWriteLikeMe && dataset) {
        const queryType = detectQueryType(question ?? '')
        if (queryType.type === 'phrase_frequency') {
          const phrase = queryType.extractedData.phrase || extractPhrase(question ?? '')
          if (phrase.trim()) {
            const matches = findPhraseMatches(phrase, dataset, withinWindow)
            const totalItems = dataset.comments.filter((c) => withinWindow(c.createdAt)).length +
              dataset.posts.filter((p) => withinWindow(p.createdAt)).length
            const sources = matches
              .slice(0, 10)
              .map((m, i) => ({
                kind: m.kind,
                id: `${m.kind}-phrase-${i}`,
                subreddit: m.subreddit,
                createdAt: m.createdAt,
                permalink: null,
                snippet: m.text.slice(0, 260),
                score: m.score,
              } satisfies RedditSearchResult))
            const prompt = buildPhraseFrequencyPrompt(
              phrase,
              matches.map((m) => ({
                text: m.text,
                subreddit: m.subreddit,
                timestamp: m.createdAt,
                score: m.score,
              })),
              Math.max(1, totalItems),
            )
            return answerWithPrompt(prompt, sources)
          }
        }

        if (queryType.type === 'time_period') {
          const timeframe = queryType.extractedData.timeframe
          const comments = filterCommentsByTimeframe(
            dataset.comments.filter((c) => withinWindow(c.createdAt)),
            timeframe,
          )
          const posts = filterPostsByTimeframe(
            dataset.posts.filter((p) => withinWindow(p.createdAt)),
            timeframe,
          )
          const sourceRows: QuerySource[] = [
            ...comments.map((c) => ({
              text: c.body ?? '',
              subreddit: c.subreddit,
              timestamp: c.createdAt,
              score: c.score ?? 0,
            })),
            ...posts.map((p) => ({
              text: `${p.title ?? ''}\n${p.body ?? ''}`.trim(),
              subreddit: p.subreddit,
              timestamp: p.createdAt,
              score: p.score ?? 0,
            })),
          ]
          if (sourceRows.length > 0) {
            const prompt = buildTimePeriodSummaryPrompt(timeframe.value, sourceRows)
            const sources = sourceRows.slice(0, 10).map((s, i) => ({
              kind: 'comment',
              id: `time-${i}`,
              subreddit: s.subreddit,
              createdAt: s.timestamp,
              permalink: null,
              snippet: s.text.slice(0, 260),
              score: s.score,
            } satisfies RedditSearchResult))
            return answerWithPrompt(prompt, sources)
          }
        }

        if (queryType.type === 'comparison') {
          const topics = queryType.extractedData.topics
          if (topics.length >= 2) {
            const aRows = findRelevantComments(topics[0], dataset.comments, withinWindow)
              .slice(0, 8)
              .map((c) => ({
                text: c.body ?? '',
                subreddit: c.subreddit,
                timestamp: c.createdAt,
                score: c.score ?? 0,
              }))
            const bRows = findRelevantComments(topics[1], dataset.comments, withinWindow)
              .slice(0, 8)
              .map((c) => ({
                text: c.body ?? '',
                subreddit: c.subreddit,
                timestamp: c.createdAt,
                score: c.score ?? 0,
              }))
            if (aRows.length > 0 || bRows.length > 0) {
              const prompt = buildComparisonPrompt(topics[0], topics[1], aRows, bRows)
              const sources = [...aRows.slice(0, 5), ...bRows.slice(0, 5)].map((s, i) => ({
                kind: 'comment',
                id: `cmp-${i}`,
                subreddit: s.subreddit,
                createdAt: s.timestamp,
                permalink: null,
                snippet: s.text.slice(0, 260),
                score: s.score,
              } satisfies RedditSearchResult))
              return answerWithPrompt(prompt, sources)
            }
          }
        }

        if (queryType.type === 'evolution') {
          const topic = queryType.extractedData.topic
          if (topic.trim()) {
            const rel = findRelevantComments(topic, dataset.comments, withinWindow)
            const buckets = new Map<string, typeof rel>()
            for (const c of rel) {
              const d = new Date(c.createdAt ?? '')
              if (!Number.isFinite(d.getTime())) continue
              const key = `${d.getUTCFullYear()}-Q${Math.floor(d.getUTCMonth() / 3) + 1}`
              const arr = buckets.get(key) ?? []
              arr.push(c)
              buckets.set(key, arr)
            }
            const phases = Array.from(buckets.entries())
              .sort((a, b) => (a[0] < b[0] ? -1 : 1))
              .slice(-8)
              .map(([timeframe, cs]) => {
                let sent = 0
                for (const c of cs) {
                  const t = (c.body ?? '').toLowerCase()
                  if (/\b(love|great|awesome|good|best)\b/.test(t)) sent += 1
                  if (/\b(hate|terrible|awful|bad|worst|sucks)\b/.test(t)) sent -= 1
                }
                return {
                  timeframe,
                  sentiment: cs.length > 0 ? sent / cs.length : 0,
                  examples: cs.slice(0, 2).map((c) => ({
                    text: c.body ?? '',
                    subreddit: c.subreddit,
                    timestamp: c.createdAt,
                    score: c.score ?? 0,
                  })),
                }
              })
            if (phases.length > 0) {
              const prompt = buildEvolutionPrompt(topic, phases)
              const flat = phases.flatMap((p) => p.examples).slice(0, 10)
              const sources = flat.map((s, i) => ({
                kind: 'comment',
                id: `evo-${i}`,
                subreddit: s.subreddit,
                createdAt: s.timestamp,
                permalink: null,
                snippet: s.text.slice(0, 260),
                score: s.score,
              } satisfies RedditSearchResult))
              return answerWithPrompt(prompt, sources)
            }
          }
        }
      }

      if (!isWriteLikeMe && asksLexicalStats && quotedPhrase && dataset) {
        const aliases = phraseAliases(quotedPhrase)
        const regexes = aliases
          .map((a) => buildPhraseRegex(a))
          .filter((r): r is RegExp => r != null)

        let totalMatches = 0
        const hits: Array<{
          kind: 'comment' | 'post'
          id: string
          subreddit: string | null
          createdAt: string | null
          permalink: string | null
          title?: string
          snippet: string
          score: number
        }> = []

        const makeSnippet = (text: string, idx: number) => {
          const start = Math.max(0, idx - 90)
          const end = Math.min(text.length, idx + 220)
          return text.slice(start, end).replace(/\s+/g, ' ').trim()
        }

        for (const c of dataset.comments) {
          if (!withinWindow(c.createdAt)) continue
          const text = c.body ?? ''
          let localCount = 0
          let firstIdx = -1
          for (const rx of regexes) {
            rx.lastIndex = 0
            const m = rx.exec(text)
            if (m && firstIdx === -1 && typeof m.index === 'number') firstIdx = m.index
            rx.lastIndex = 0
            localCount += (text.match(rx) ?? []).length
          }
          if (localCount > 0) {
            totalMatches += localCount
            hits.push({
              kind: 'comment',
              id: c.id,
              subreddit: c.subreddit,
              createdAt: c.createdAt,
              permalink: c.permalink,
              snippet: makeSnippet(text, Math.max(0, firstIdx)),
              score: c.score ?? 0,
            })
          }
        }

        for (const p of dataset.posts) {
          if (!withinWindow(p.createdAt)) continue
          const text = `${p.title ?? ''}\n${p.body ?? ''}`
          let localCount = 0
          let firstIdx = -1
          for (const rx of regexes) {
            rx.lastIndex = 0
            const m = rx.exec(text)
            if (m && firstIdx === -1 && typeof m.index === 'number') firstIdx = m.index
            rx.lastIndex = 0
            localCount += (text.match(rx) ?? []).length
          }
          if (localCount > 0) {
            totalMatches += localCount
            hits.push({
              kind: 'post',
              id: p.id,
              subreddit: p.subreddit,
              createdAt: p.createdAt,
              permalink: p.permalink,
              title: p.title,
              snippet: makeSnippet(text, Math.max(0, firstIdx)),
              score: p.score ?? 0,
            })
          }
        }

        const ordered = hits
          .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
          .slice(0, 6)
          .map((h) => ({
            kind: h.kind,
            id: h.id,
            subreddit: h.subreddit,
            createdAt: h.createdAt,
            permalink: h.permalink,
            title: h.title,
            snippet: h.snippet,
            score: h.score,
          }))

        const answer =
          totalMatches > 0
            ? [
                `I found ${totalMatches} total matches for "${quotedPhrase}" (including close variants like ${aliases.join(', ')}).`,
                `Matched items: ${hits.length} comments/posts.`,
                upperBoundMs != null ? `Filtered up to: ${new Date(upperBoundMs).toISOString().slice(0, 10)}.` : '',
              ]
                .filter(Boolean)
                .join('\n')
            : `I found 0 matches for "${quotedPhrase}"${upperBoundMs != null ? ` up to ${new Date(upperBoundMs).toISOString().slice(0, 10)}` : ''}.`

        return {
          answer,
          sources: ordered,
        }
      }

      if (!isWriteLikeMe && asksLexicalStats && voiceProfile) {
        const topPhrases = (voiceProfile.commonPhrases ?? []).slice(0, 10)
        const topWords = (voiceProfile.signatureWords ?? []).slice(0, 15)
        const answer = [
          'Your most-used sayings/phrases tend to include:',
          ...topPhrases.map((p, i) => `${i + 1}. "${p.phrase}"`),
          '',
          'Your most-used words/terms include:',
          ...topWords.map((w, i) => `${i + 1}. ${w.word}`),
        ].join('\n')
        const sources: RedditSearchResult[] = [
          {
            kind: 'comment',
            id: 'profile-phrases',
            subreddit: null,
            createdAt: null,
            permalink: null,
            snippet: `Profile phrase frequencies computed from ${voiceProfile.totalComments} comments.`,
          },
          {
            kind: 'comment',
            id: 'profile-words',
            subreddit: null,
            createdAt: null,
            permalink: null,
            snippet: 'Profile word frequencies from your full imported dataset.',
          },
        ]
        return { answer, sources }
      }

      if (!isWriteLikeMe && yearsAgoMatch && dataset) {
        const yearsAgo = Number(yearsAgoMatch[1])
        if (Number.isFinite(yearsAgo) && yearsAgo > 0) {
          const datedMs: number[] = []
          for (const c of dataset.comments) {
            const ms = Date.parse(c.createdAt ?? '')
            if (Number.isFinite(ms)) datedMs.push(ms)
          }
          for (const p of dataset.posts) {
            const ms = Date.parse(p.createdAt ?? '')
            if (Number.isFinite(ms)) datedMs.push(ms)
          }
          const anchor = datedMs.length > 0 ? new Date(Math.max(...datedMs)) : new Date()
          const targetYear = anchor.getUTCFullYear() - yearsAgo

          const yearComments = dataset.comments.filter((c) => {
            const ms = Date.parse(c.createdAt ?? '')
            return Number.isFinite(ms) && new Date(ms).getUTCFullYear() === targetYear
          })
          const yearPosts = dataset.posts.filter((p) => {
            const ms = Date.parse(p.createdAt ?? '')
            return Number.isFinite(ms) && new Date(ms).getUTCFullYear() === targetYear
          })

          if (yearComments.length + yearPosts.length > 0) {
            const profile = analyzeVoice({
              comments: yearComments.map((c) => ({ body: c.body ?? '', score: c.score ?? undefined })),
              posts: yearPosts.map((p) => ({ title: p.title ?? '', body: p.body ?? '', score: p.score ?? undefined })),
            })
            const subs = new Map<string, number>()
            for (const c of yearComments) {
              if (!c.subreddit) continue
              subs.set(c.subreddit, (subs.get(c.subreddit) ?? 0) + 1)
            }
            for (const p of yearPosts) {
              if (!p.subreddit) continue
              subs.set(p.subreddit, (subs.get(p.subreddit) ?? 0) + 1)
            }
            const topSubs = Array.from(subs.entries())
              .sort((a, b) => b[1] - a[1])
              .slice(0, 4)
              .map(([s]) => `r/${s}`)
            const topPhrase = profile.commonPhrases?.[0]?.phrase
            const answer = [
              `Around ${targetYear}, your Reddit voice looked like this:`,
              `- Volume: ${yearComments.length} comments and ${yearPosts.length} posts in that year.`,
              `- Tone: casual ${profile.toneScores.casual.toFixed(2)}, formal ${profile.toneScores.formal.toFixed(2)}, humorous ${profile.toneScores.humorous.toFixed(2)}, serious ${profile.toneScores.serious.toFixed(2)}.`,
              `- Style: avg ${Math.round(profile.avgLength)} words/comment, vocabulary ${profile.vocabularyLevel}.`,
              topPhrase ? `- One common phrase then: "${topPhrase}".` : '',
              topSubs.length > 0 ? `- Most active communities: ${topSubs.join(', ')}.` : '',
            ]
              .filter(Boolean)
              .join('\n')

            const sources: RedditSearchResult[] = [
              ...yearComments.slice(0, 4).map((c) => ({
                kind: 'comment' as const,
                id: c.id,
                subreddit: c.subreddit,
                createdAt: c.createdAt,
                permalink: c.permalink,
                snippet: (c.body ?? '').slice(0, 260),
                score: c.score ?? undefined,
              })),
              ...yearPosts.slice(0, 2).map((p) => ({
                kind: 'post' as const,
                id: p.id,
                subreddit: p.subreddit,
                createdAt: p.createdAt,
                permalink: p.permalink,
                title: p.title,
                snippet: `${p.title ?? ''}\n${p.body ?? ''}`.slice(0, 260),
                score: p.score ?? undefined,
              })),
            ]
            return { answer, sources }
          }
        }
      }

      // 1. Retrieve relevant context via local search + time window
      const contextResults = await (async () => {
        if (!dataset) {
          return []
        }

        // If a Time Machine cutoff is provided, apply it here.

        if (isWriteLikeMe && voiceProfile) {
          const examples = voiceProfile.representativeExamples ?? []
          const high = voiceProfile.highEngagementExamples ?? []
          const picked = [...examples.slice(0, 8), ...high.slice(0, 2)].slice(0, 10)

          return picked
            .filter((t) => typeof t === 'string' && t.trim().length > 0)
            .map((t, idx) => ({
              kind: 'comment' as const,
              id: `voice-example-${idx}`,
              subreddit: null,
              createdAt: null,
              permalink: null,
              snippet: t.trim().slice(0, 700),
            }))
        }

        if (isWriteLikeMe && !voiceProfile) {
          // No cached voice profile yet. Return empty so caller can show a helpful message.
          return []
        }

        const q = (question ?? '').trim().toLowerCase()
        if (q.length < 2) return []

        const limit = 6
        const stopwords = new Set([
          'the','a','an','and','or','but','if','then','else','when','while','for','to','of','in','on','at','by','with','from',
          'is','are','was','were','be','been','being','i','me','my','mine','you','your','yours','we','our','ours','they','their','theirs',
          'it','its','this','that','these','those','as','so','not','no','yes','do','does','did','doing','done','have','has','had','having',
          'can','could','would','should','will','just','like','really','very','im','ive','id','dont','cant','wont','isnt','arent','wasnt','werent',
          'what','which','who','whom','why','how','about','tell','show','give','find','any','anything',
        ])
        const queryTokens = Array.from(new Set(words(q).filter((w) => w.length >= 3 && !stopwords.has(w))))
        const asksLexicalStats = /\b(common|commonly|frequent|most used|use most|words?|phrases?|sayings?|terms?)\b/.test(q)

        function makeSnippet(text: string, idx: number) {
          const start = Math.max(0, idx - 80)
          const end = Math.min(text.length, idx + 160)
          return text.slice(start, end).replace(/\s+/g, ' ').trim()
        }

        const results: RedditSearchResult[] = []
        const scored: Array<
          {
            kind: 'comment' | 'post'
            id: string
            subreddit: string | null
            createdAt: string | null
            permalink: string | null
            title?: string
            text: string
            score: number
            hitIdx: number
          }
        > = []

        for (const c of dataset.comments) {
          if (!withinWindow(c.createdAt)) continue
          const raw = c.body ?? ''
          const body = raw.toLowerCase()
          const fullHit = body.indexOf(q)
          const tokenHits = queryTokens.reduce((acc, t) => acc + (body.includes(t) ? 1 : 0), 0)
          if (fullHit === -1 && tokenHits === 0) continue
          const score = (fullHit >= 0 ? 6 : 0) + tokenHits * 3 + Math.max(0, c.score ?? 0) * 0.01
          const hitIdx = fullHit >= 0 ? fullHit : queryTokens.length > 0 ? body.indexOf(queryTokens[0]) : 0
          scored.push({
            kind: 'comment',
            id: c.id,
            subreddit: c.subreddit,
            createdAt: c.createdAt,
            permalink: c.permalink,
            text: raw,
            score,
            hitIdx: Math.max(0, hitIdx),
          })
        }

        for (const p of dataset.posts) {
          if (!withinWindow(p.createdAt)) continue
          const text = `${p.title ?? ''}\n${p.body ?? ''}`
          const lower = text.toLowerCase()
          const fullHit = lower.indexOf(q)
          const tokenHits = queryTokens.reduce((acc, t) => acc + (lower.includes(t) ? 1 : 0), 0)
          if (fullHit === -1 && tokenHits === 0) continue
          const score = (fullHit >= 0 ? 6 : 0) + tokenHits * 3 + Math.max(0, p.score ?? 0) * 0.01
          const hitIdx = fullHit >= 0 ? fullHit : queryTokens.length > 0 ? lower.indexOf(queryTokens[0]) : 0
          scored.push({
            kind: 'post',
            id: p.id,
            subreddit: p.subreddit,
            createdAt: p.createdAt,
            permalink: p.permalink,
            title: p.title,
            text,
            score,
            hitIdx: Math.max(0, hitIdx),
          })
        }

        // ALSO SEARCH SMS MESSAGES (was missing!)
        // This is why queries like "Boons" weren't being found
        for (const e of smsEvents) {
          if (!withinWindow(e.createdAt)) continue
          const text = (e.text ?? '').trim()
          if (!text) continue
          const lower = text.toLowerCase()
          const fullHit = lower.indexOf(q)
          const tokenHits = queryTokens.reduce((acc, t) => acc + (lower.includes(t) ? 1 : 0), 0)
          if (fullHit === -1 && tokenHits === 0) continue
          const score = (fullHit >= 0 ? 8 : 0) + tokenHits * 4 // Boost SMS matches
          const hitIdx = fullHit >= 0 ? fullHit : queryTokens.length > 0 ? lower.indexOf(queryTokens[0]) : 0
          const fromMe = e.metadata?.isUserMessage ? 'Me' : 'Them'
          const participants = (e.participants ?? []).filter(Boolean).join(', ')
          results.push({
            kind: 'comment', // Use 'comment' kind for SMS too
            id: `sms-${e.createdAt ?? Date.now()}`,
            subreddit: null,
            createdAt: e.createdAt,
            permalink: null,
            snippet: `[SMS ${fromMe} to ${participants}] ${makeSnippet(text, Math.max(0, hitIdx))}`,
            score,
          })
        }

        scored
          .sort((a, b) => b.score - a.score)
          .slice(0, limit)
          .forEach((s) => {
            results.push({
              kind: s.kind,
              id: s.id,
              subreddit: s.subreddit,
              createdAt: s.createdAt,
              permalink: s.permalink,
              title: s.title,
              snippet: makeSnippet(s.text, s.hitIdx),
              score: s.score,
            })
          })

        if (results.length === 0 && asksLexicalStats && voiceProfile) {
          const phraseLines = (voiceProfile.commonPhrases ?? [])
            .slice(0, 12)
            .map((p) => p.phrase)
            .join(', ')
          const wordLines = (voiceProfile.signatureWords ?? [])
            .slice(0, 20)
            .map((w) => w.word)
            .join(', ')
          return [
            {
              kind: 'comment' as const,
              id: 'profile-phrases',
              subreddit: null,
              createdAt: null,
              permalink: null,
              snippet: `Most frequent phrases from your profile: ${phraseLines}`,
            },
            {
              kind: 'comment' as const,
              id: 'profile-words',
              subreddit: null,
              createdAt: null,
              permalink: null,
              snippet: `Most frequent words/terms from your profile: ${wordLines}`,
            },
          ]
        }

        return results
      })()

      const sources = contextResults

      if (sources.length === 0) {
        if (isWriteLikeMe) {
          return {
            answer: 'Your voice profile isn’t ready yet. Re-import your Reddit export to generate it, then try again.',
            sources: [],
          }
        }

        const profileSummary = [
          voiceProfile
            ? `Voice profile: avg length ${Math.round(voiceProfile.avgLength)} words, tone casual ${voiceProfile.toneScores.casual.toFixed(2)}, serious ${voiceProfile.toneScores.serious.toFixed(2)}.`
            : 'Voice profile unavailable.',
          identityProfile ? `Identity summary: ${identityProfile.summary}` : 'Identity profile unavailable.',
        ].join('\n')

        const fallbackPrompt = `You are the user's personal AI assistant with memory of their digital history.
Be conversational and helpful first. This is a chat assistant, not a search-only tool.
If there is no exact evidence for a claim, say that briefly and then still provide a practical best-effort response.
Avoid robotic refusals.

Known profile context:
${profileSummary}

${identityContextBlock}

Question:
${question}`

        try {
          const model = getGeminiModel()
          const answer = await withTimeout(
            model.generateContent(fallbackPrompt).then((r) => r.response.text()),
            45_000,
            'Gemini fallback chat',
          )
          return { answer: answer.trim(), sources: [] }
        } catch (e) {
          const details = e instanceof Error ? e.message : String(e)
          return {
            answer: `I don't have direct matching records for that yet, but here's my best take: ${details}`,
            sources: [],
          }
        }
      }

      const contextText = sources
        .map(
          (r, i) =>
            `[${i + 1}] ${'title' in r && r.title ? `Post: ${r.title}\n` : ''}${r.snippet}\n—r/${r.subreddit ?? 'unknown'} (${r.createdAt?.slice(0, 10) ?? 'no date'})`,
        )
        .join('\n\n')

      const queryRows: QuerySource[] = sources.map((s) => ({
        text: s.snippet,
        subreddit: s.subreddit,
        timestamp: s.createdAt,
        score: 'score' in s && typeof s.score === 'number' ? s.score : 0,
      }))

      const prompt = isWriteLikeMe
        ? `You are an AI writing assistant.
Your job is to write in the user's voice.
You will be given a cached writing-style analysis plus real writing samples from the user. Use both.

WRITING STYLE ANALYSIS:
- Average comment length: ${voiceProfile?.avgLength != null ? Math.round(voiceProfile.avgLength) : 'unknown'} words
- Median comment length: ${voiceProfile?.medianLength != null ? Math.round(voiceProfile.medianLength) : 'unknown'} words
- Vocabulary level: ${voiceProfile?.vocabularyLevel ?? 'unknown'}
- Tone scores (0-1): casual ${voiceProfile?.toneScores?.casual?.toFixed?.(2) ?? 'n/a'}, formal ${voiceProfile?.toneScores?.formal?.toFixed?.(2) ?? 'n/a'}, humorous ${voiceProfile?.toneScores?.humorous?.toFixed?.(2) ?? 'n/a'}, serious ${voiceProfile?.toneScores?.serious?.toFixed?.(2) ?? 'n/a'}
- Punctuation habits: exclamations/comment ${voiceProfile?.punctuationStyle?.exclamationsPerComment?.toFixed?.(2) ?? 'n/a'}, ellipses/comment ${voiceProfile?.punctuationStyle?.ellipsesPerComment?.toFixed?.(2) ?? 'n/a'}

COMMON PHRASES:
${(voiceProfile?.commonPhrases ?? []).slice(0, 10).map((p) => `- ${p.phrase}`).join('\n')}

EXAMPLES OF THEIR ACTUAL WRITING:
${contextText}

${identityContextBlock}

PERSONALITY ADJUSTMENTS FOR THIS RESPONSE:
${styleLine ? styleLine : '(none)'}

TASK:
Write a response about: ${question}

RULES:
- Execute the request directly and output only the requested content.
- Do not comment on the request itself. No preface, pep talk, critique, or "my take" framing.
- Start immediately with the answer body.

Write in their authentic voice, adjusted for the personality settings above.`
        : `${buildQueryChatPrompt(
            question ?? '',
            voiceProfile,
            identityProfile,
            queryRows,
            upperBoundMs != null ? new Date(upperBoundMs) : undefined,
          )}
${styleLine ? `\nStyle constraints: ${styleLine}\n` : ''}

${identityContextBlock}

Context from user data:
${contextText}
`

      try {
        const model = getGeminiModel()
        const startedAt = Date.now()
        const timeoutMs = 45_000

        console.log('[Gemini] Sending prompt:', prompt.slice(0, 200) + '...')
        const answer = await withTimeout(
          model.generateContent(prompt).then((r) => r.response.text()),
          timeoutMs,
          'Gemini chat',
        )
        const trimmed = answer.trim()
        console.log('[Gemini] Received answer:', trimmed.slice(0, 200) + '...')
        console.log('[Gemini] Duration ms:', Date.now() - startedAt)
        return { answer: trimmed, sources }
      } catch (e) {
        console.error('[Gemini] Error:', e)
        const details = e instanceof Error ? e.message : String(e)
        const maybeTimeout = details.toLowerCase().includes('timed out')
        if (maybeTimeout) {
          return {
            answer: 'AI backend timeout (Gemini). The model took too long to respond. Try again.',
            sources,
          }
        }
        return {
          answer: `AI backend error (Gemini). ${details}`,
          sources,
        }
      }
    },
  )

  ipcMain.handle(
    'twin:chatClone',
    async (
      _event,
      input: {
        message: string
        lockedDateIso?: string
        history?: Array<{ role: 'user' | 'assistant'; text: string }>
      },
    ) => {
      const message = (input?.message ?? '').trim()
      if (message.length < 2) {
        return { answer: 'Say a bit more and I will respond.', model: process.env.GEMINI_MODEL ?? 'gemini-2.5-flash' }
      }

      const dataset = await loadDatasetFromDisk()
      const voiceProfile = await loadVoiceProfile()
      const identityProfile = await loadIdentityLearningProfile()

      const lockedDate = input?.lockedDateIso ? new Date(input.lockedDateIso) : null
      const lockedMs = lockedDate && Number.isFinite(lockedDate.getTime()) ? lockedDate.getTime() : null

      const queryTokens = Array.from(new Set(words(message))).filter((w) => w.length >= 3)
      const candidates: CloneSample[] = []

      if (dataset) {
        for (const c of dataset.comments) {
          const createdMs = c.createdAt ? Date.parse(c.createdAt) : NaN
          if (lockedMs != null && Number.isFinite(createdMs) && createdMs > lockedMs) continue
          const text = (c.body ?? '').trim()
          if (text.length < 40) continue
          const lower = text.toLowerCase()
          const overlap = queryTokens.reduce((acc, t) => acc + (lower.includes(t) ? 1 : 0), 0)
          const score = overlap * 8 + Math.min(8, text.length / 140) + Math.max(0, c.score ?? 0) * 0.02
          candidates.push({
            text: text.slice(0, 900),
            createdAt: c.createdAt ?? null,
            subreddit: c.subreddit ?? null,
            engagement: c.score ?? 0,
            relevance: score,
          })
        }
        for (const p of dataset.posts) {
          const createdMs = p.createdAt ? Date.parse(p.createdAt) : NaN
          if (lockedMs != null && Number.isFinite(createdMs) && createdMs > lockedMs) continue
          const text = `${p.title ?? ''}\n${p.body ?? ''}`.trim()
          if (text.length < 40) continue
          const lower = text.toLowerCase()
          const overlap = queryTokens.reduce((acc, t) => acc + (lower.includes(t) ? 1 : 0), 0)
          const score = overlap * 8 + Math.min(8, text.length / 140) + Math.max(0, p.score ?? 0) * 0.02
          candidates.push({
            text: text.slice(0, 900),
            createdAt: p.createdAt ?? null,
            subreddit: p.subreddit ?? null,
            engagement: p.score ?? 0,
            relevance: score,
          })
        }
      }

      const sampleContext = candidates
        .sort((a, b) => b.relevance - a.relevance)
        .slice(0, 10)
        .map((c) => c.text)

      if (sampleContext.length === 0 && voiceProfile) {
        for (const ex of (voiceProfile.representativeExamples ?? []).slice(0, 8)) {
          sampleContext.push(ex)
        }
      }

      const identitySummary = identityProfile
        ? [
            identityProfile.summary,
            `Top words: ${identityProfile.topWords.slice(0, 12).map((x) => x.word).join(', ')}`,
            `Top phrases: ${identityProfile.topPhrases.slice(0, 8).map((x) => x.phrase).join(', ')}`,
          ].join('\n')
        : 'No identity-learning profile is available yet.'

      const relatedContext = buildRelatedContext(candidates, 3)
      const prompt = buildDigitalTwinPrompt({
        voiceProfile,
        identitySummary,
        conversationHistory: input?.history ?? [],
        userQuestion: message,
        dateFilterIso: lockedMs != null ? new Date(lockedMs).toISOString() : undefined,
        writingSamples: sampleContext,
        relatedContext,
      })

      try {
        const modelName = process.env.GEMINI_MODEL ?? 'gemini-2.5-flash'
        const model = getGeminiModel(modelName)
        const answer = await withTimeout(
          model.generateContent(prompt).then((r) => r.response.text()),
          45_000,
          'Gemini clone chat',
        )
        return { answer: answer.trim(), model: modelName }
      } catch (e) {
        const details = e instanceof Error ? e.message : String(e)
        return {
          answer: `Clone chat error (Gemini): ${details}`,
          model: process.env.GEMINI_MODEL ?? 'gemini-2.5-flash',
        }
      }
    },
  )
}

app.whenReady().then(async () => {
  registerIpcHandlers()
  await createWindow()

  app.on('activate', async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      await createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
