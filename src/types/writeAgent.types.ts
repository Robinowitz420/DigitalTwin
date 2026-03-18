export type WriteAgentSliderKey =
  | 'formality'
  | 'assertiveness'
  | 'verbosity'
  | 'emotion'
  | 'spicy'
  | 'optimism'

export type WriteAgentSliders = Record<WriteAgentSliderKey, number>

export type WriteAgentPreset = {
  label: string
  values: WriteAgentSliders
}

export type WriteAgentVoiceMode =
  | 'personal_text'
  | 'close_friend'
  | 'public_post'
  | 'professional'
  | 'unfiltered_me'

export type WriteAgentSourceLocks = {
  includeSms?: boolean
  includeReddit?: boolean
  includeGmail?: boolean
}

export type WriteAgentRequest = {
  topic: string
  sliders?: WriteAgentSliders
  voiceMode?: WriteAgentVoiceMode
  blendFactor?: number // 0..1, optional interpolation between voice modes
  sourceLocks?: WriteAgentSourceLocks
  model?: string
  handle?: string
  contactName?: string // Optional: only load contact profile when specified
}

export type WriteAgentResult = {
  text: string
  model: string
}

export type WriteAgentChunkEvent = {
  requestId: string
  chunk: string
  text: string
}

export type WriteAgentDoneEvent = {
  requestId: string
  text: string
  model: string
}

export type WriteAgentErrorEvent = {
  requestId: string
  error: string
}
