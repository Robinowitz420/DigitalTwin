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
  }
  topWords: Array<{ word: string; count: number }>
  topPhrases: Array<{ phrase: string; count: number }>
  topUpvotedSubreddits: Array<{ subreddit: string; count: number }>
  topTimelineSources: Array<{ source: string; count: number }>
  topChannels: Array<{ channel: string; count: number }>
  topDomains: Array<{ domain: string; count: number }>
  summary: string
}
