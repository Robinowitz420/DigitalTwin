export type VoiceTrainingCheckpoint = {
  version: 1
  startedAt: string
  lastCheckpointAt: string
  totalChunks: number
  processedChunks: number
  chunkSummaries: Array<{
    observations: {
      tone?: string
      vocabulary?: string
      punctuation?: string
      structure?: string
    }
    rules: string[]
    common_phrases: string[]
    do: string[]
    dont: string[]
  }>
  skippedChunks: number
  status: 'in_progress' | 'paused' | 'completed' | 'failed'
  error?: string
  datasetStats: {
    totalItems: number
    comments: number
    posts: number
    smsMessages: number
    instagramMessages: number
    instagramComments: number
    llmChatMessages: number
  }
}

export type VoiceTrainingControl = {
  pause: () => void
  resume: () => void
  isPaused: () => boolean
  abort: () => void
  isAborted: () => boolean
}
