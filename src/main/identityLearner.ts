import type { RedditDataset, RedditImportProgress } from '../types/reddit.types.js'
import type { IdentityTimeline } from '../types/identity.types.js'
import type { IdentityLearningProfile, IdentityInsight } from '../types/identityLearning.types.js'
import { isOllamaRunning } from './memory/ollamaClient.js'

const STOPWORDS = new Set(
  [
    'the','a','an','and','or','but','if','then','else','when','while','for','to','of','in','on','at','by','with','from',
    'is','are','was','were','be','been','being','i','me','my','mine','you','your','yours','we','our','ours','they','their','theirs',
    'it','its','this','that','these','those','as','so','not','no','yes','do','does','did','doing','done','have','has','had','having',
    'can','could','would','should','will','just','like','really','very','im','ive','id','dont','cant','wont','isnt','arent','wasnt','werent',
  ],
)

function words(text: string) {
  return (text.toLowerCase().match(/[a-z0-9']+/g) ?? []).filter(Boolean)
}

function addCount(map: Map<string, number>, key: string, by = 1) {
  if (!key) return
  map.set(key, (map.get(key) ?? 0) + by)
}

function topK(map: Map<string, number>, k: number) {
  return Array.from(map.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, k)
}

function extractDomains(text: string): string[] {
  const matches = text.match(/https?:\/\/[^\s)]+/gi) ?? []
  const out: string[] = []
  for (const m of matches) {
    try {
      const u = new URL(m)
      out.push(u.hostname.replace(/^www\./, ''))
    } catch {
      // ignore
    }
  }
  return out
}

const OLLAMA_HOST = 'http://localhost:11434'
const DEFAULT_MODEL = 'llama3.2'

async function ollamaGenerate(prompt: string, model: string = DEFAULT_MODEL): Promise<string> {
  const res = await fetch(`${OLLAMA_HOST}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      prompt,
      stream: false,
      options: { temperature: 0.3, num_predict: 2048 },
    }),
  })
  if (!res.ok) throw new Error(`Ollama failed: ${res.status}`)
  const data = await res.json() as { response?: string }
  return data.response?.trim() ?? ''
}

/**
 * Generate rich identity insights using Ollama
 */
async function generateInsights(
  corpusSample: string,
  topWords: Array<{ word: string; count: number }>,
  topSubreddits: Array<{ subreddit: string; count: number }>,
  onProgress?: (p: RedditImportProgress) => void,
): Promise<IdentityInsight[]> {
  const insights: IdentityInsight[] = []
  const ollamaAvailable = await isOllamaRunning()
  
  if (!ollamaAvailable) {
    // Fallback: generate basic insights from stats
    insights.push({
      category: 'writing_style',
      title: 'Writing Style (Statistical)',
      summary: 'Based on word frequency analysis (Ollama not available)',
      details: topWords.slice(0, 10).map(w => `"${w.word}" used ${w.count} times`),
      confidence: 'low',
    })
    if (topSubreddits.length > 0) {
      insights.push({
        category: 'interest_evolution',
        title: 'Interest Areas',
        summary: 'Top communities you engage with',
        details: topSubreddits.slice(0, 5).map(s => `r/${s.subreddit} (${s.count} interactions)`),
        confidence: 'medium',
      })
    }
    return insights
  }

  // Generate each insight category via Ollama
  const categories: Array<{ cat: IdentityInsight['category']; prompt: string }> = [
    {
      cat: 'political_leanings',
      prompt: `Analyze the following user's text data for political leanings. Look for political language, values, policy preferences, ideological markers. Be neutral and evidence-based.

Sample text:
${corpusSample.slice(0, 3000)}

Respond in JSON format:
{"title": "...", "score": 0-100 (0=far left, 50=centrist, 100=far right), "summary": "2-3 sentences", "details": ["detail1", "detail2", ...], "confidence": "high|medium|low"}`,
    },
    {
      cat: 'interest_evolution',
      prompt: `Analyze how this user's interests have evolved over time. Look for topic shifts, new hobbies, abandoned interests, deepening expertise.

Sample text:
${corpusSample.slice(0, 3000)}

Respond in JSON format:
{"title": "...", "summary": "2-3 sentences about interest evolution", "details": ["interest1: description", "interest2: description", ...], "confidence": "high|medium|low"}`,
    },
    {
      cat: 'personality_traits',
      prompt: `Analyze personality traits from this user's text. Look for: extraversion/introversion, openness, conscientiousness, agreeableness, emotional stability. Use Big Five framework.

Sample text:
${corpusSample.slice(0, 3000)}

Respond in JSON format:
{"title": "...", "summary": "2-3 sentences about personality", "details": ["trait1: evidence", "trait2: evidence", ...], "confidence": "high|medium|low"}`,
    },
    {
      cat: 'topic_expertise',
      prompt: `Identify areas where this user shows expertise or deep knowledge. Look for: technical terminology, detailed explanations, correct facts, teaching others.

Sample text:
${corpusSample.slice(0, 3000)}

Respond in JSON format:
{"title": "...", "summary": "2-3 sentences about expertise areas", "details": ["expertise1: evidence", "expertise2: evidence", ...], "confidence": "high|medium|low"}`,
    },
    {
      cat: 'mood_patterns',
      prompt: `Analyze mood and emotional patterns in this user's text. Look for: emotional vocabulary, sentiment shifts, stress indicators, joy/frustration markers.

Sample text:
${corpusSample.slice(0, 3000)}

Respond in JSON format:
{"title": "...", "summary": "2-3 sentences about mood patterns", "details": ["pattern1: description", "pattern2: description", ...], "confidence": "high|medium|low"}`,
    },
    {
      cat: 'writing_style',
      prompt: `Analyze this user's writing style. Look for: formality level, sentence structure, punctuation habits, vocabulary complexity, humor/sarcasm use, emoji usage.

Sample text:
${corpusSample.slice(0, 3000)}

Respond in JSON format:
{"title": "...", "summary": "2-3 sentences about writing style", "details": ["style1: evidence", "style2: evidence", ...], "confidence": "high|medium|low"}`,
    },
    {
      cat: 'consumption_vs_creation',
      prompt: `Analyze whether this user is primarily a content consumer or creator. Look for: original posts vs comments, sharing vs discussing, creating vs reacting.

Sample text:
${corpusSample.slice(0, 3000)}

Respond in JSON format:
{"title": "...", "score": 0-100 (0=pure consumer, 100=pure creator), "summary": "2-3 sentences", "details": ["evidence1", "evidence2", ...], "confidence": "high|medium|low"}`,
    },
    {
      cat: 'contradictions',
      prompt: `Find contradictions or inconsistencies in this user's statements over time. Look for: changed opinions, conflicting values, hypocritical statements.

Sample text:
${corpusSample.slice(0, 3000)}

Respond in JSON format:
{"title": "...", "summary": "2-3 sentences about contradictions found (or 'No significant contradictions found')", "details": ["contradiction1: description", ...], "confidence": "high|medium|low"}`,
    },
  ]

  for (let i = 0; i < categories.length; i++) {
    const { cat, prompt } = categories[i]
    onProgress?.({ 
      stage: 'analyzing', 
      percent: 50 + Math.round((i / categories.length) * 40), 
      message: `Analyzing: ${cat.replace(/_/g, ' ')}…` 
    })
    
    try {
      const response = await ollamaGenerate(prompt)
      // Parse JSON from response
      const jsonMatch = response.match(/\{[\s\S]*\}/)
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]) as Partial<IdentityInsight>
        insights.push({
          category: cat,
          title: parsed.title ?? cat.replace(/_/g, ' '),
          score: parsed.score,
          summary: parsed.summary ?? 'Analysis unavailable',
          details: Array.isArray(parsed.details) ? parsed.details : [],
          confidence: parsed.confidence ?? 'low',
        })
      }
    } catch {
      insights.push({
        category: cat,
        title: cat.replace(/_/g, ' '),
        summary: 'Analysis failed',
        details: [],
        confidence: 'low',
      })
    }
  }

  return insights
}

export async function learnIdentityProfile(
  reddit: RedditDataset | null,
  timeline: IdentityTimeline | null,
  onProgress?: (p: RedditImportProgress) => void,
): Promise<IdentityLearningProfile> {
  const wordCounts = new Map<string, number>()
  const phraseCounts = new Map<string, number>()
  const upvoteSubs = new Map<string, number>()
  const sourceCounts = new Map<string, number>()
  const channelCounts = new Map<string, number>()
  const domainCounts = new Map<string, number>()

  const commentTexts = reddit?.comments.map((c) => c.body ?? '') ?? []
  const postTexts = reddit?.posts.map((p) => `${p.title ?? ''}\n${p.body ?? ''}`.trim()) ?? []
  const savedTexts = reddit?.saved.map((s) => `${s.title ?? ''}\n${s.permalink ?? ''}`.trim()) ?? []
  const upvotedTexts = reddit?.upvoted.map((u) => `${u.title ?? ''}\n${u.permalink ?? ''}`.trim()) ?? []

  for (const u of reddit?.upvoted ?? []) {
    if (u.subreddit) addCount(upvoteSubs, u.subreddit)
  }

  const timelineTexts = timeline?.events.map((e) => e.text ?? '') ?? []
  for (const e of timeline?.events ?? []) {
    addCount(sourceCounts, e.source)
    if (e.channel) addCount(channelCounts, e.channel)
  }

  const corpus = [...commentTexts, ...postTexts, ...savedTexts, ...upvotedTexts, ...timelineTexts]
  const total = Math.max(1, corpus.length)

  onProgress?.({ stage: 'analyzing', percent: 2, message: 'Starting deep identity analysis…' })

  // Phase 1: Statistical analysis
  for (let i = 0; i < corpus.length; i++) {
    const text = corpus[i]
    const toks = words(text)

    for (const t of toks) {
      if (t.length < 3 || STOPWORDS.has(t)) continue
      addCount(wordCounts, t)
    }

    for (let j = 0; j < toks.length - 1; j++) {
      const a = toks[j]
      const b = toks[j + 1]
      if (a.length < 3 || b.length < 3) continue
      if (STOPWORDS.has(a) && STOPWORDS.has(b)) continue
      addCount(phraseCounts, `${a} ${b}`)
    }

    for (const d of extractDomains(text)) addCount(domainCounts, d)

    if (i % 500 === 0 || i === corpus.length - 1) {
      const pct = 2 + Math.round((i / total) * 45)
      onProgress?.({ stage: 'analyzing', percent: Math.max(2, Math.min(50, pct)), message: `Analyzing data… (${i + 1}/${total})` })
      await new Promise((r) => setTimeout(r, 0))
    }
  }

  const topWords = topK(wordCounts, 40).map(([word, count]) => ({ word, count }))
  const topPhrases = topK(phraseCounts, 25).map(([phrase, count]) => ({ phrase, count }))
  const topUpvotedSubreddits = topK(upvoteSubs, 12).map(([subreddit, count]) => ({ subreddit, count }))
  const topTimelineSources = topK(sourceCounts, 12).map(([source, count]) => ({ source, count }))
  const topChannels = topK(channelCounts, 12).map(([channel, count]) => ({ channel, count }))
  const topDomains = topK(domainCounts, 15).map(([domain, count]) => ({ domain, count }))

  // Phase 2: Ollama deep analysis
  onProgress?.({ stage: 'analyzing', percent: 50, message: 'Running AI-powered identity analysis…' })
  
  const corpusSample = corpus.slice(0, 100).join('\n\n---\n\n')
  const insights = await generateInsights(corpusSample, topWords, topUpvotedSubreddits, onProgress)

  onProgress?.({ stage: 'analyzing', percent: 95, message: 'Synthesizing your identity profile…' })

  const profile: IdentityLearningProfile = {
    generatedAt: new Date().toISOString(),
    totals: {
      redditComments: reddit?.comments.length ?? 0,
      redditPosts: reddit?.posts.length ?? 0,
      redditSaved: reddit?.saved.length ?? 0,
      redditUpvoted: reddit?.upvoted.length ?? 0,
      timelineEvents: timeline?.events.length ?? 0,
      youtubeEvents: timeline?.events.filter((e) => e.source === 'youtube').length ?? 0,
      gmailEvents: timeline?.events.filter((e) => e.source === 'gmail').length ?? 0,
      googleVoiceEvents: timeline?.events.filter((e) => e.source === 'google_voice').length ?? 0,
      chromeEvents: timeline?.events.filter((e) => e.source === 'chrome').length ?? 0,
      discoverEvents: timeline?.events.filter((e) => e.source === 'discover').length ?? 0,
      instagramEvents: timeline?.events.filter((e) => e.source === 'instagram').length ?? 0,
      llmChatEvents: timeline?.events.filter((e) => e.source === 'llm_chat').length ?? 0,
      smsEvents: timeline?.events.filter((e) => e.source === 'sms').length ?? 0,
    },
    topWords,
    topPhrases,
    topUpvotedSubreddits,
    topTimelineSources,
    topChannels,
    topDomains,
    summary: [
      `Analyzed ${corpus.length.toLocaleString()} text items from all connected data sources.`,
      topUpvotedSubreddits.length > 0
        ? `Most upvoted activity clusters around: ${topUpvotedSubreddits.slice(0, 5).map((x) => `r/${x.subreddit}`).join(', ')}.`
        : 'No upvote subreddit signals found yet.',
      topTimelineSources.length > 0
        ? `Strongest non-Reddit data signals: ${topTimelineSources.slice(0, 5).map((x) => `${x.source} (${x.count})`).join(', ')}.`
        : 'No additional portal signals found yet.',
      topWords.length > 0
        ? `Recurring language markers include: ${topWords.slice(0, 12).map((x) => x.word).join(', ')}.`
        : 'No recurring language markers found yet.',
    ].join(' '),
    insights,
  }

  return profile
}
