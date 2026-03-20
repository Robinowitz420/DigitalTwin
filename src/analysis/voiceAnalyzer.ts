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

  // Training metadata - tracks what data was used
  trainedAt?: string // ISO timestamp when training completed
  trainingSources?: {
    redditComments: number
    redditPosts: number
    smsMessages: number
    instagramMessages: number
    instagramComments: number
    llmChatMessages: number
  }
}

// Per-contact voice profile for adapting style based on relationship
export type PerContactVoiceProfile = {
  contactName: string
  contactPhone?: string | null
  
  // Relationship metadata
  relationshipType: 'close_friend' | 'friend' | 'family' | 'acquaintance' | 'professional' | 'unknown'
  intimacyScore: number // 0-1, based on message frequency, slang usage, emoji usage
  
  // User's style when talking to THIS contact
  userStyle: {
    avgMessageLength: number
    emojiUsageRate: number // emojis per message
    slangUsageRate: number // lol, lmao, etc per message
    questionRate: number // questions per message
    exclamationRate: number
    responseTimeMinutes?: number // average time to respond
    initiationsCount: number // how often user starts conversation
  }
  
  // Contact's style (for context)
  contactStyle: {
    avgMessageLength: number
    emojiUsageRate: number
    slangUsageRate: number
  }
  
  // Shared context
  sharedPhrases: string[] // inside jokes, recurring phrases
  topicsDiscussed: Array<{ topic: string; count: number }>
  
  // Conversation patterns
  totalMessages: number
  userMessages: number
  contactMessages: number
  firstMessageDate: string | null
  lastMessageDate: string | null
  
  // Sample messages for AI context
  representativeUserMessages: string[] // user's messages to this contact
  representativeContactMessages: string[] // contact's messages for context
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

// Analyze user's communication style with a specific contact
export function analyzePerContactVoice(messages: Array<{
  text: string
  isUserMessage: boolean
  timestamp?: string | null
  senderName?: string
}>): PerContactVoiceProfile | null {
  if (messages.length < 3) return null // Need minimum conversation
  
  const userMessages = messages.filter(m => m.isUserMessage)
  const contactMessages = messages.filter(m => !m.isUserMessage)
  
  if (userMessages.length < 2 || contactMessages.length < 2) return null // Need back-and-forth
  
  // Extract contact name from first non-user message
  const contactName = contactMessages[0]?.senderName ?? 'Unknown'
  
  // Analyze user's style with this contact
  const userTexts = userMessages.map(m => m.text)
  const contactTexts = contactMessages.map(m => m.text)
  
  // Emoji detection
  const emojiRe = /[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu
  const userEmojiCount = userTexts.reduce((sum, t) => sum + (t.match(emojiRe)?.length ?? 0), 0)
  const contactEmojiCount = contactTexts.reduce((sum, t) => sum + (t.match(emojiRe)?.length ?? 0), 0)
  
  // Slang detection
  const slangRe = /\b(lol|lmao|tbh|imo|imho|idk|ngl|ya|yep|nah|gonna|wanna|bruh|fam|bestie|sis|bro)\b/gi
  const userSlangCount = userTexts.reduce((sum, t) => sum + (t.match(slangRe)?.length ?? 0), 0)
  const contactSlangCount = contactTexts.reduce((sum, t) => sum + (t.match(slangRe)?.length ?? 0), 0)
  
  // Questions and exclamations
  const userQuestions = userTexts.reduce((sum, t) => sum + (t.match(/\?/g)?.length ?? 0), 0)
  const userExclamations = userTexts.reduce((sum, t) => sum + (t.match(/!/g)?.length ?? 0), 0)
  
  // Message lengths
  const userLengths = userTexts.map(t => t.length)
  const contactLengths = contactTexts.map(t => t.length)
  const avgUserLen = userLengths.length > 0 ? userLengths.reduce((a, b) => a + b, 0) / userLengths.length : 0
  const avgContactLen = contactLengths.length > 0 ? contactLengths.reduce((a, b) => a + b, 0) / contactLengths.length : 0
  
  // Calculate intimacy score (0-1)
  const emojiRate = userMessages.length > 0 ? userEmojiCount / userMessages.length : 0
  const slangRate = userMessages.length > 0 ? userSlangCount / userMessages.length : 0
  const intimacyScore = clamp01((emojiRate * 2 + slangRate * 2 + (userExclamations / userMessages.length)) / 5)
  
  // Determine relationship type based on patterns
  let relationshipType: PerContactVoiceProfile['relationshipType'] = 'unknown'
  if (intimacyScore > 0.6 && slangRate > 0.3) {
    relationshipType = 'close_friend'
  } else if (intimacyScore > 0.4 || slangRate > 0.2) {
    relationshipType = 'friend'
  } else if (avgUserLen > 100 && userQuestions / userMessages.length > 0.5) {
    relationshipType = 'professional'
  } else if (intimacyScore > 0.3) {
    relationshipType = 'acquaintance'
  }
  
  // Extract shared phrases (n-grams that appear in both sides)
  const userPhrases = new Map<string, number>()
  const contactPhrases = new Map<string, number>()
  
  for (const t of userTexts) {
    const toks = words(t)
    const grams = extractNgrams(toks, 2)
    for (const g of grams) {
      if (!STOPWORDS.has(g.split(' ')[0])) {
        userPhrases.set(g, (userPhrases.get(g) ?? 0) + 1)
      }
    }
  }
  for (const t of contactTexts) {
    const toks = words(t)
    const grams = extractNgrams(toks, 2)
    for (const g of grams) {
      if (!STOPWORDS.has(g.split(' ')[0])) {
        contactPhrases.set(g, (contactPhrases.get(g) ?? 0) + 1)
      }
    }
  }
  
  const sharedPhrases: string[] = []
  for (const [phrase, count] of userPhrases) {
    if (contactPhrases.has(phrase) && count >= 2) {
      sharedPhrases.push(phrase)
    }
  }
  
  // Sort dates
  const dates = messages
    .map(m => m.timestamp)
    .filter((d): d is string => Boolean(d))
    .sort()
  
  // Representative samples
  const representativeUserMessages = userTexts
    .filter(t => t.length > 10 && t.length < 200)
    .slice(0, 10)
  const representativeContactMessages = contactTexts
    .filter(t => t.length > 10 && t.length < 200)
    .slice(0, 10)
  
  return {
    contactName,
    
    relationshipType,
    intimacyScore,
    
    userStyle: {
      avgMessageLength: avgUserLen,
      emojiUsageRate: userMessages.length > 0 ? userEmojiCount / userMessages.length : 0,
      slangUsageRate: userMessages.length > 0 ? userSlangCount / userMessages.length : 0,
      questionRate: userMessages.length > 0 ? userQuestions / userMessages.length : 0,
      exclamationRate: userMessages.length > 0 ? userExclamations / userMessages.length : 0,
      initiationsCount: 0, // Would need conversation-level analysis
    },
    
    contactStyle: {
      avgMessageLength: avgContactLen,
      emojiUsageRate: contactMessages.length > 0 ? contactEmojiCount / contactMessages.length : 0,
      slangUsageRate: contactMessages.length > 0 ? contactSlangCount / contactMessages.length : 0,
    },
    
    sharedPhrases: sharedPhrases.slice(0, 20),
    topicsDiscussed: [], // Would need NLP topic extraction
    
    totalMessages: messages.length,
    userMessages: userMessages.length,
    contactMessages: contactMessages.length,
    firstMessageDate: dates[0] ?? null,
    lastMessageDate: dates[dates.length - 1] ?? null,
    
    representativeUserMessages,
    representativeContactMessages,
  }
}
