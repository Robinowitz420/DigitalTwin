export type RedditImportStage = 'reading' | 'parsing' | 'writing' | 'done'

export type RedditImportProgress = {
  stage: RedditImportStage
  percent: number
  message?: string
  outputPath?: string
}

export type RedditComment = {
  id: string
  subreddit: string | null
  permalink: string | null
  body: string
  createdAt: string | null
  score?: number | null
}

export type RedditPost = {
  id: string
  subreddit: string | null
  permalink: string | null
  title: string
  body?: string
  createdAt: string | null
  score?: number | null
}

export type RedditSaved = {
  id: string
  subreddit: string | null
  permalink: string | null
  title?: string
  createdAt: string | null
}

export type RedditUpvoted = {
  id: string
  subreddit: string | null
  permalink: string | null
  title?: string
  createdAt: string | null
}

export type RedditSubscription = {
  name: string
}

export type RedditDataset = {
  source: 'reddit'
  importedAt: string
  comments: RedditComment[]
  posts: RedditPost[]
  saved: RedditSaved[]
  upvoted: RedditUpvoted[]
  subreddits: RedditSubscription[]
}
