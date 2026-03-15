import type { RedditComment, RedditDataset, RedditPost } from '../../types/reddit.types.js'

export type QueryType =
  | { type: 'phrase_frequency'; confidence: number; extractedData: { phrase: string } }
  | {
      type: 'time_period'
      confidence: number
      extractedData: { timeframe: ReturnType<typeof extractTimeframe> }
    }
  | { type: 'comparison'; confidence: number; extractedData: { topics: string[] } }
  | { type: 'evolution'; confidence: number; extractedData: { topic: string } }
  | { type: 'general'; confidence: number }

export type WindowFn = (createdAt: string | null | undefined) => boolean

export function detectQueryType(question: string): QueryType {
  const q = (question ?? '').trim()
  const lowerQ = q.toLowerCase()

  if (isPhraseFrequencyQuery(lowerQ)) {
    return {
      type: 'phrase_frequency',
      confidence: 0.9,
      extractedData: { phrase: extractPhrase(q) },
    }
  }
  if (isTimePeriodQuery(lowerQ)) {
    return {
      type: 'time_period',
      confidence: 0.85,
      extractedData: { timeframe: extractTimeframe(q) },
    }
  }
  if (isComparisonQuery(lowerQ)) {
    return {
      type: 'comparison',
      confidence: 0.8,
      extractedData: { topics: extractComparisonTopics(q) },
    }
  }
  if (isEvolutionQuery(lowerQ)) {
    return {
      type: 'evolution',
      confidence: 0.8,
      extractedData: { topic: extractEvolutionTopic(q) },
    }
  }
  return { type: 'general', confidence: 1 }
}

export function isPhraseFrequencyQuery(question: string): boolean {
  const patterns = [
    /how (often|frequently|many times) (do|did) (i|you) (say|use|mention)/i,
    /count.*(times|instances|occurrences)/i,
    /(do|did) (i|you) (ever|often) (say|use|mention)/i,
    /frequency of.*phrase/i,
    /how many times/i,
  ]
  return patterns.some((p) => p.test(question))
}

export function extractPhrase(question: string): string {
  const quotedMatch = question.match(/["']([^"']+)["']/)
  if (quotedMatch?.[1]) return quotedMatch[1].trim()

  const patterns = [
    /(?:say|use|mention)\s+["']?([^"'?]+)["']?/i,
    /word\s+["']?([^"'?]+)["']?/i,
    /phrase\s+["']?([^"'?]+)["']?/i,
  ]
  for (const p of patterns) {
    const m = question.match(p)
    if (m?.[1]) return m[1].trim()
  }
  return ''
}

function generatePhraseVariations(phrase: string): string[] {
  const lower = phrase.toLowerCase().trim()
  const out = new Set<string>([lower, lower.replace(/[^\w\s']/g, ''), lower.replace(/\s+/g, ' ')])
  const abbrevs: Record<string, string> = {
    'to be honest': 'tbh',
    'in my opinion': 'imo',
    'by the way': 'btw',
    "for what it's worth": 'fwiw',
    'as far as i know': 'afaik',
    'not gonna lie': 'ngl',
    'not going to lie': 'ngl',
  }
  if (abbrevs[lower]) out.add(abbrevs[lower])
  for (const [full, short] of Object.entries(abbrevs)) {
    if (short === lower) out.add(full)
  }
  return Array.from(out)
}

export function findPhraseMatches(
  phrase: string,
  dataset: RedditDataset,
  withinWindow: WindowFn,
): Array<{ kind: 'comment' | 'post'; text: string; createdAt: string | null; subreddit: string | null; score: number }> {
  const vars = generatePhraseVariations(phrase)
  const out: Array<{ kind: 'comment' | 'post'; text: string; createdAt: string | null; subreddit: string | null; score: number }> = []

  for (const c of dataset.comments) {
    if (!withinWindow(c.createdAt)) continue
    const t = (c.body ?? '').toLowerCase()
    if (vars.some((v) => t.includes(v))) {
      out.push({
        kind: 'comment',
        text: c.body ?? '',
        createdAt: c.createdAt,
        subreddit: c.subreddit,
        score: c.score ?? 0,
      })
    }
  }
  for (const p of dataset.posts) {
    if (!withinWindow(p.createdAt)) continue
    const full = `${p.title ?? ''}\n${p.body ?? ''}`.toLowerCase()
    if (vars.some((v) => full.includes(v))) {
      out.push({
        kind: 'post',
        text: `${p.title ?? ''}\n${p.body ?? ''}`.trim(),
        createdAt: p.createdAt,
        subreddit: p.subreddit,
        score: p.score ?? 0,
      })
    }
  }
  return out
}

export function isTimePeriodQuery(question: string): boolean {
  const patterns = [
    /(\d+)\s+(year|month|week)s?\s+ago/i,
    /back in \d{4}/i,
    /in (early|mid|late)?\s*\d{4}/i,
    /what (was|were) (i|you) like/i,
    /how (did|have) (i|you) (change|evolve)/i,
  ]
  return patterns.some((p) => p.test(question))
}

export function extractTimeframe(question: string): {
  type: 'relative' | 'absolute' | 'descriptive'
  value: string
  startDate?: Date
  endDate?: Date
} {
  const rel = question.match(/(\d+)\s+(year|month|week)s?\s+ago/i)
  if (rel) {
    const amount = Number(rel[1])
    const unit = rel[2].toLowerCase()
    const now = new Date()
    const start = new Date(now)
    if (unit.startsWith('year')) start.setFullYear(start.getFullYear() - amount)
    else if (unit.startsWith('month')) start.setMonth(start.getMonth() - amount)
    else start.setDate(start.getDate() - amount * 7)
    return { type: 'relative', value: `${amount} ${unit}s ago`, startDate: start, endDate: now }
  }

  const year = question.match(/\b(20\d{2})\b/)
  if (year) {
    const y = Number(year[1])
    return {
      type: 'absolute',
      value: String(y),
      startDate: new Date(Date.UTC(y, 0, 1)),
      endDate: new Date(Date.UTC(y, 11, 31, 23, 59, 59)),
    }
  }

  if (/pandemic|covid/i.test(question)) {
    return {
      type: 'descriptive',
      value: 'pandemic',
      startDate: new Date(Date.UTC(2020, 0, 1)),
      endDate: new Date(Date.UTC(2021, 11, 31, 23, 59, 59)),
    }
  }

  return { type: 'descriptive', value: 'recent' }
}

export function filterCommentsByTimeframe(comments: RedditComment[], tf: ReturnType<typeof extractTimeframe>): RedditComment[] {
  if (!tf.startDate || !tf.endDate) return comments
  const start = tf.startDate.getTime()
  const end = tf.endDate.getTime()
  return comments.filter((c) => {
    const ms = Date.parse(c.createdAt ?? '')
    if (!Number.isFinite(ms)) return false
    return ms >= start && ms <= end
  })
}

export function filterPostsByTimeframe(posts: RedditPost[], tf: ReturnType<typeof extractTimeframe>): RedditPost[] {
  if (!tf.startDate || !tf.endDate) return posts
  const start = tf.startDate.getTime()
  const end = tf.endDate.getTime()
  return posts.filter((p) => {
    const ms = Date.parse(p.createdAt ?? '')
    if (!Number.isFinite(ms)) return false
    return ms >= start && ms <= end
  })
}

export function isComparisonQuery(question: string): boolean {
  const patterns = [/\bvs\b/i, /\bversus\b/i, /prefer.*or/i, /difference between/i]
  return patterns.some((p) => p.test(question))
}

export function extractComparisonTopics(question: string): string[] {
  const vs = question.match(/(.+?)\s+(?:vs|versus|or)\s+(.+?)(?:\?|$)/i)
  if (vs) return [vs[1].trim(), vs[2].trim()]
  const between = question.match(/between\s+(.+?)\s+and\s+(.+?)(?:\?|$)/i)
  if (between) return [between[1].trim(), between[2].trim()]
  return []
}

export function isEvolutionQuery(question: string): boolean {
  const patterns = [/how (have|has|did).*(change|evolve|shift)/i, /(used to|formerly).*(think|believe|say)/i, /still (think|believe|say)/i]
  return patterns.some((p) => p.test(question))
}

export function extractEvolutionTopic(question: string): string {
  const m = question.match(/(?:on|about|regarding)\s+(.+?)(?:\?|$)/i)
  return m?.[1]?.trim() ?? ''
}

export function findRelevantComments(topic: string, comments: RedditComment[], withinWindow?: WindowFn): RedditComment[] {
  const toks = topic
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 3)
  return comments
    .filter((c) => (withinWindow ? withinWindow(c.createdAt) : true))
    .map((c) => {
      const low = (c.body ?? '').toLowerCase()
      const relevance = toks.reduce((acc, t) => acc + (low.includes(t) ? 1 : 0), 0)
      return { c, relevance }
    })
    .filter((x) => x.relevance > 0)
    .sort((a, b) => b.relevance - a.relevance)
    .map((x) => x.c)
}

