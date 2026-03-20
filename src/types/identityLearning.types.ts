export type IdentityInsight = {
  category: 'political_leanings' | 'interest_evolution' | 'personality_traits' | 'topic_expertise' | 'mood_patterns' | 'writing_style' | 'consumption_vs_creation' | 'contradictions'
  title: string
  score?: number // 0-100 where applicable
  summary: string
  details: string[]
  confidence: 'high' | 'medium' | 'low'
}

export type IdentityLearningProfile = {
  generatedAt: string
  totals: {
    redditComments: number
    redditPosts: number
    redditSaved: number
    redditUpvoted: number
    timelineEvents: number
    youtubeEvents: number
    gmailEvents: number
    googleVoiceEvents: number
    chromeEvents: number
    discoverEvents: number
    instagramEvents: number
    llmChatEvents: number
    smsEvents: number
  }
  topWords: Array<{ word: string; count: number }>
  topPhrases: Array<{ phrase: string; count: number }>
  topUpvotedSubreddits: Array<{ subreddit: string; count: number }>
  topTimelineSources: Array<{ source: string; count: number }>
  topChannels: Array<{ channel: string; count: number }>
  topDomains: Array<{ domain: string; count: number }>
  summary: string
  // Rich insights from Ollama analysis
  insights: IdentityInsight[]
}
