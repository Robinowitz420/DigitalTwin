import type { RedditDataset, RedditImportProgress } from '../types/reddit.types.js'
import type { IdentityTimeline } from '../types/identity.types.js'
import type { IdentityLearningProfile } from '../types/identityLearning.types.js'

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
      const pct = 2 + Math.round((i / total) * 88)
      onProgress?.({ stage: 'analyzing', percent: Math.max(2, Math.min(90, pct)), message: `Analyzing data… (${i + 1}/${total})` })
      await new Promise((r) => setTimeout(r, 0))
    }
  }

  onProgress?.({ stage: 'analyzing', percent: 95, message: 'Synthesizing your identity profile…' })

  const topWords = topK(wordCounts, 40).map(([word, count]) => ({ word, count }))
  const topPhrases = topK(phraseCounts, 25).map(([phrase, count]) => ({ phrase, count }))
  const topUpvotedSubreddits = topK(upvoteSubs, 12).map(([subreddit, count]) => ({ subreddit, count }))
  const topTimelineSources = topK(sourceCounts, 12).map(([source, count]) => ({ source, count }))
  const topChannels = topK(channelCounts, 12).map(([channel, count]) => ({ channel, count }))
  const topDomains = topK(domainCounts, 15).map(([domain, count]) => ({ domain, count }))

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
  }

  return profile
}
