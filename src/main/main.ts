import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron'
import * as path from 'node:path'
import { readFile, unlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { importRedditExportFromFolder } from './dataProcessor.js'
import type { RedditDataset, RedditImportProgress, RedditSearchResult } from '../types/reddit.types.js'
import type { GoogleTakeoutImportResult, IdentityEvent, IdentityImportResult, SocialCsvMapping } from '../types/identity.types.js'
import type {
  WriteAgentRequest,
  WriteAgentChunkEvent,
  WriteAgentDoneEvent,
  WriteAgentErrorEvent,
} from '../types/writeAgent.types.js'
import { loadVoiceProfile, clearVoiceProfile } from './voiceProfileStore.js'
import { saveVoiceProfile } from './voiceProfileStore.js'
import { trainVoiceWithGemini } from './voiceTrainer.js'
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
  detectQueryType,
  extractPhrase,
  filterCommentsByTimeframe,
  filterPostsByTimeframe,
  findPhraseMatches,
  findRelevantComments,
} from './utils/queryDetection.js'

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

  const scored = pool
    .map((item) => {
      const text = item.text
      if (!text || text.length < 40) return null
      const clipped = text.length > 900 ? `${text.slice(0, 900)}...` : text
      const lower = clipped.toLowerCase()
      const matchHits = queryTokens.reduce((acc, t) => acc + (lower.includes(t) ? 1 : 0), 0)
      const lengthScore = Math.min(8, clipped.length / 140)
      const engagementScore = Math.max(0, item.score) * 0.02
      const score = matchHits * 12 + lengthScore + engagementScore
      return { text: clipped, score, matchHits }
    })
    .filter((x): x is { text: string; score: number; matchHits: number } => x != null)
    .sort((a, b) => b.score - a.score)

  const relevant = scored.filter((x) => x.matchHits > 0).slice(0, 10).map((x) => x.text)
  const typical = scored.slice(0, 10).map((x) => x.text)
  const combined = [...relevant, ...typical, ...fallback].filter((s) => s.trim().length >= 20)

  const deduped: string[] = []
  const seen = new Set<string>()
  for (const s of combined) {
    const key = s.toLowerCase().replace(/\s+/g, ' ').trim()
    if (seen.has(key)) continue
    seen.add(key)
    deduped.push(s)
    if (deduped.length >= 12) break
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
    const events = await importGoogleVoiceTakeoutFromFolder(folderPath)
    const merged = await upsertIdentityEvents(events)
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

  ipcMain.handle('voice:trainProfile', async () => {
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
      percent: 0,
      message: 'Starting voice training…',
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

    try {
      const profile = await trainVoiceWithGemini(dataset, {
        model: process.env.GEMINI_MODEL ?? 'gemini-2.5-flash',
        onProgress: (p) => sendTrainProgress(p),
      })
      await saveVoiceProfile(profile)
      sendTrainProgress({
        stage: 'training',
        percent: 100,
        message: 'Voice training complete.',
      })
      return profile
    } catch (e) {
      const details = e instanceof Error ? e.message : String(e)
      mainWindow.webContents.send('voice:trainProgress', {
        stage: 'training',
        percent: 0,
        message: `Training failed: ${details}`,
      })
      throw e
    } finally {
      console.log = originalLog
      console.warn = originalWarn
      console.error = originalError
    }
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
        const [identityProfile, identityTimeline] = await Promise.all([
          loadIdentityLearningProfile(),
          loadIdentityTimeline(),
        ])

        const model = input.model?.trim() || process.env.GEMINI_MODEL || 'gemini-2.5-flash'
        const examples = pickWriteExamples(dataset, input.topic, voiceProfile.representativeExamples ?? [])
        const crossPlatformSamples = pickCrossPlatformExamples(identityTimeline, input.topic, 10)
        const prompt = buildWriteLikeMePrompt({
          handle: input.handle,
          topic: input.topic,
          sliders: input.sliders,
          voiceProfile,
          examples,
          identityProfile,
          crossPlatformSamples,
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
