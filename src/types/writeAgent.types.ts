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

export type WriteAgentRequest = {
  topic: string
  sliders: WriteAgentSliders
  model?: string
  handle?: string
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
