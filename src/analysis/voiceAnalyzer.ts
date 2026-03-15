export type VoiceProfile = {
  avgLength: number
  medianLength: number
  totalComments: number

  commonPhrases: Array<{ phrase: string; frequency: number }>
  signatureWords: Array<{ word: string; frequency: number }>

  toneScores: {
    casual: number
    formal: number
    humorous: number
    serious: number
    passionate: number
  }

  punctuationStyle: {
    exclamationsPerComment: number
    questionsPerComment: number
    ellipsesPerComment: number
    emDashesPerComment: number
    parentheticalsPer100Words: number
    quotesUsagePer100Words: number
  }

  vocabularyLevel: 'simple' | 'moderate' | 'advanced' | 'technical'
  avgWordsPerSentence: number
  complexSentenceRatio: number

  starterPhrases: Array<{ phrase: string; count: number }>
  closingPhrases: Array<{ phrase: string; count: number }>
  paragraphUsage: number

  shortFormRatio: number
  longFormRatio: number

  representativeExamples: string[]
  highEngagementExamples: string[]
}

type AnalyzeVoiceInput = {
  comments: Array<{ body: string; score?: number | null }>
  posts?: Array<{ title?: string; body?: string; score?: number | null }>
}

const STOPWORDS = new Set(
  [
    'the','a','an','and','or','but','if','then','else','when','while','for','to','of','in','on','at','by','with','from',
    'is','are','was','were','be','been','being','i','me','my','mine','you','your','yours','we','our','ours','they','their','theirs',
    'it','its','this','that','these','those','as','so','not','no','yes','do','does','did','doing','done','have','has','had','having',
    'can','could','would','should','will','just','like','really','very','im','ive','id','dont','cant','wont','isnt','arent','wasnt','werent',
  ].map((s) => s.toLowerCase()),
)

function clamp01(n: number) {
  return Math.max(0, Math.min(1, n))
}

function words(text: string) {
  return (text.toLowerCase().match(/[a-z0-9']+/g) ?? []).filter(Boolean)
}

function sentences(text: string) {
  // Simple splitter; good enough for V1
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

function median(nums: number[]) {
  if (nums.length === 0) return 0
  const sorted = [...nums].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

function topKFromMap(map: Map<string, number>, k: number) {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, k)
}

function extractNgrams(tokens: string[], n: 2 | 3) {
  const out: string[] = []
  for (let i = 0; i <= tokens.length - n; i++) {
    out.push(tokens.slice(i, i + n).join(' '))
  }
  return out
}

function normalizeTextForExamples(s: string) {
  return s.replace(/\s+/g, ' ').trim()
}

export function analyzeVoice(input: AnalyzeVoiceInput): VoiceProfile {
  const rawComments = input.comments
    .map((c) => ({ body: (c.body ?? '').trim(), score: c.score ?? null }))
    .filter((c) => c.body.length > 0)

  const filtered = rawComments
    .filter((c) => {
      const wc = words(c.body).length
      if (wc < 5) return false
      const low = c.body.toLowerCase().trim()
      if (low === '[deleted]' || low === '[removed]') return false
      return true
    })

  const bodies = filtered.map((c) => c.body)
  const totalComments = bodies.length

  const wordCounts = bodies.map((b) => words(b).length)
  const totalWords = wordCounts.reduce((a, b) => a + b, 0)
  const avgLength = totalComments > 0 ? totalWords / totalComments : 0
  const medianLength = median(wordCounts)

  const shortFormRatio = totalComments > 0 ? wordCounts.filter((n) => n < 20).length / totalComments : 0
  const longFormRatio = totalComments > 0 ? wordCounts.filter((n) => n > 100).length / totalComments : 0

  // Phrases + words
  const phraseCounts = new Map<string, number>()
  const wordCountsMap = new Map<string, number>()

  for (const b of bodies) {
    const toks = words(b)
    for (const w of toks) {
      if (STOPWORDS.has(w)) continue
      wordCountsMap.set(w, (wordCountsMap.get(w) ?? 0) + 1)
    }

    const grams2 = extractNgrams(toks, 2)
    const grams3 = extractNgrams(toks, 3)
    for (const g of [...grams2, ...grams3]) {
      // Filter boring grams that are mostly stopwords
      const parts = g.split(' ')
      const nonStop = parts.filter((p) => !STOPWORDS.has(p)).length
      if (nonStop === 0) continue
      phraseCounts.set(g, (phraseCounts.get(g) ?? 0) + 1)
    }
  }

  const commonPhrases = topKFromMap(phraseCounts, 20).map(([phrase, count]) => ({
    phrase,
    frequency: totalComments > 0 ? count / totalComments : 0,
  }))

  const signatureWords = topKFromMap(wordCountsMap, 50).map(([word, count]) => ({
    word,
    frequency: totalWords > 0 ? count / totalWords : 0,
  }))

  // Tone heuristics
  const contractionRe = /\b(i'm|i've|i'd|can't|won't|don't|isn't|aren't|wasn't|weren't|it's|that's|there's|you're|we're|they're)\b/gi
  const slangRe = /\b(lol|lmao|tbh|imo|imho|idk|ngl|ya|yep|nah|gonna|wanna)\b/gi
  const humorRe = /\b(lol|lmao|haha|hehe|rofl|\/s)\b/gi
  const seriousRe = /\b(study|data|evidence|source|according|research|statistic|analysis)\b/gi
  const passionateRe = /\*[^*]+\*|\b[A-Z]{3,}\b/g

  let casualHits = 0
  let formalHits = 0
  let humorHits = 0
  let seriousHits = 0
  let passionateHits = 0

  for (const b of bodies) {
    casualHits += (b.match(contractionRe) ?? []).length
    casualHits += (b.match(slangRe) ?? []).length

    // naive formal marker: proper sentence capitalization / fewer contractions
    const hasCapStart = /^[A-Z]/.test(b.trim())
    if (hasCapStart) formalHits += 1

    humorHits += (b.match(humorRe) ?? []).length
    seriousHits += (b.match(seriousRe) ?? []).length
    passionateHits += (b.match(passionateRe) ?? []).length
  }

  const denom = Math.max(1, totalComments)
  const toneScores = {
    casual: clamp01(casualHits / (denom * 3)),
    formal: clamp01(formalHits / denom),
    humorous: clamp01(humorHits / denom),
    serious: clamp01(seriousHits / denom),
    passionate: clamp01(passionateHits / denom),
  }

  // Punctuation
  let exclamations = 0
  let questions = 0
  let ellipses = 0
  let emDashes = 0
  let parentheticals = 0
  let quotes = 0

  for (const b of bodies) {
    exclamations += (b.match(/!/g) ?? []).length
    questions += (b.match(/\?/g) ?? []).length
    ellipses += (b.match(/\.\.\./g) ?? []).length
    emDashes += (b.match(/—|--/g) ?? []).length
    parentheticals += (b.match(/\([^)]*\)/g) ?? []).length
    quotes += (b.match(/["“”]/g) ?? []).length
  }

  const punctuationStyle = {
    exclamationsPerComment: totalComments > 0 ? exclamations / totalComments : 0,
    questionsPerComment: totalComments > 0 ? questions / totalComments : 0,
    ellipsesPerComment: totalComments > 0 ? ellipses / totalComments : 0,
    emDashesPerComment: totalComments > 0 ? emDashes / totalComments : 0,
    parentheticalsPer100Words: totalWords > 0 ? (parentheticals / totalWords) * 100 : 0,
    quotesUsagePer100Words: totalWords > 0 ? (quotes / totalWords) * 100 : 0,
  }

  // Sentence structure
  const allSentences = bodies.flatMap((b) => sentences(b))
  const sentenceWordCounts = allSentences.map((s) => words(s).length).filter((n) => n > 0)
  const avgWordsPerSentence =
    sentenceWordCounts.length > 0
      ? sentenceWordCounts.reduce((a, b) => a + b, 0) / sentenceWordCounts.length
      : 0

  const complexCount = allSentences.filter((s) => /,|;|\b(and|but|because|however|although)\b/i.test(s)).length
  const complexSentenceRatio = allSentences.length > 0 ? complexCount / allSentences.length : 0

  // Paragraph usage
  const paragraphUsage =
    totalComments > 0
      ? bodies.reduce((acc, b) => acc + Math.max(1, b.split(/\n\n+/).filter(Boolean).length), 0) / totalComments
      : 0

  // Starters / closers
  const startersMap = new Map<string, number>()
  const closersMap = new Map<string, number>()
  for (const b of bodies) {
    const toks = words(b)
    const start = toks.slice(0, 5).join(' ')
    const end = toks.slice(Math.max(0, toks.length - 5)).join(' ')
    if (start) startersMap.set(start, (startersMap.get(start) ?? 0) + 1)
    if (end) closersMap.set(end, (closersMap.get(end) ?? 0) + 1)
  }

  const starterPhrases = topKFromMap(startersMap, 15).map(([phrase, count]) => ({ phrase, count }))
  const closingPhrases = topKFromMap(closersMap, 15).map(([phrase, count]) => ({ phrase, count }))

  // Vocabulary level (very rough proxy)
  const uniq = new Set<string>()
  let longWordCount = 0
  for (const b of bodies) {
    for (const w of words(b)) {
      uniq.add(w)
      if (w.length >= 9) longWordCount++
    }
  }
  const longWordRatio = totalWords > 0 ? longWordCount / totalWords : 0
  const vocab: VoiceProfile['vocabularyLevel'] =
    longWordRatio > 0.18 ? 'technical' : longWordRatio > 0.12 ? 'advanced' : longWordRatio > 0.08 ? 'moderate' : 'simple'

  // Representative examples: pick medium length closest to median
  const scored = filtered
    .map((c) => ({
      text: normalizeTextForExamples(c.body),
      score: c.score ?? 0,
      wc: words(c.body).length,
    }))
    .filter((x) => x.text.length >= 80)

  const rep = [...scored]
    .sort((a, b) => Math.abs(a.wc - medianLength) - Math.abs(b.wc - medianLength))
    .slice(0, 10)
    .map((x) => x.text)

  const high = [...scored]
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    .slice(0, 5)
    .map((x) => x.text)

  return {
    avgLength,
    medianLength,
    totalComments,

    commonPhrases,
    signatureWords,

    toneScores,
    punctuationStyle,

    vocabularyLevel: vocab,
    avgWordsPerSentence,
    complexSentenceRatio,

    starterPhrases,
    closingPhrases,
    paragraphUsage,

    shortFormRatio,
    longFormRatio,

    representativeExamples: rep,
    highEngagementExamples: high,
  }
}
