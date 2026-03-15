import type { VoiceProfile } from '../analysis/voiceAnalyzer.js'
import type { IdentityLearningProfile } from '../types/identityLearning.types.js'
import type { WriteAgentPreset, WriteAgentSliders } from '../types/writeAgent.types.js'

function clampSlider(value: number) {
  if (!Number.isFinite(value)) return 5
  return Math.max(0, Math.min(10, Math.round(value)))
}

function sliderInstruction(key: keyof WriteAgentSliders, value: number) {
  const v = clampSlider(value)
  switch (key) {
    case 'formality':
      if (v <= 2) return `${v}/10 - Keep it conversational, plainspoken, and relaxed.`
      if (v <= 7) return `${v}/10 - Keep a balanced tone: clear but natural.`
      return `${v}/10 - Use polished, professional wording with clean structure.`
    case 'assertiveness':
      if (v <= 2) return `${v}/10 - Be diplomatic and soft in claims.`
      if (v <= 7) return `${v}/10 - Be confident without sounding aggressive.`
      return `${v}/10 - Be direct, decisive, and unambiguous.`
    case 'verbosity':
      if (v <= 2) return `${v}/10 - Keep it short and tight.`
      if (v <= 7) return `${v}/10 - Use medium length with enough context.`
      return `${v}/10 - Be detailed and thorough while staying coherent.`
    case 'emotion':
      if (v <= 2) return `${v}/10 - Keep emotional language minimal and controlled.`
      if (v <= 7) return `${v}/10 - Add moderate warmth and human texture.`
      return `${v}/10 - Be expressive with vivid feeling and emphasis.`
    case 'spicy':
      if (v <= 2) return `${v}/10 - Stay safe, neutral, and non-inflammatory.`
      if (v <= 7) return `${v}/10 - Add a little edge and wit where natural.`
      return `${v}/10 - Lean into bold, provocative framing without being abusive.`
    case 'optimism':
      if (v <= 2) return `${v}/10 - Lean skeptical and critical of weak assumptions.`
      if (v <= 7) return `${v}/10 - Keep a balanced outlook with realistic framing.`
      return `${v}/10 - Emphasize constructive, supportive, hopeful framing.`
  }
}

export const WRITE_AGENT_PRESETS: WriteAgentPreset[] = [
  {
    label: 'Work Mode',
    values: { formality: 8, assertiveness: 5, verbosity: 6, emotion: 2, spicy: 2, optimism: 6 },
  },
  {
    label: 'Debate Mode',
    values: { formality: 5, assertiveness: 9, verbosity: 7, emotion: 4, spicy: 7, optimism: 4 },
  },
  {
    label: 'Casual Mode',
    values: { formality: 2, assertiveness: 5, verbosity: 4, emotion: 7, spicy: 5, optimism: 7 },
  },
  {
    label: 'Spicy Mode',
    values: { formality: 3, assertiveness: 9, verbosity: 5, emotion: 8, spicy: 10, optimism: 3 },
  },
]

type BuildPromptInput = {
  handle?: string
  topic: string
  sliders: WriteAgentSliders
  voiceProfile: VoiceProfile
  examples: string[]
  identityProfile?: IdentityLearningProfile | null
  crossPlatformSamples?: string[]
}

export function buildWriteLikeMePrompt(input: BuildPromptInput) {
  const name = input.handle?.trim() || "the user's Reddit persona"
  const vp = input.voiceProfile
  const phrases = vp.commonPhrases.slice(0, 25).map((p) => `- ${p.phrase}`).join('\n') || '- (none)'
  const starters = vp.starterPhrases.slice(0, 12).map((s) => `- ${s.phrase}`).join('\n') || '- (none)'
  const closers = vp.closingPhrases.slice(0, 12).map((s) => `- ${s.phrase}`).join('\n') || '- (none)'
  const signatures = vp.signatureWords.slice(0, 60).map((w) => `- ${w.word}`).join('\n') || '- (none)'
  const toneSummary = `casual ${vp.toneScores.casual.toFixed(2)}, formal ${vp.toneScores.formal.toFixed(2)}, humorous ${vp.toneScores.humorous.toFixed(2)}, serious ${vp.toneScores.serious.toFixed(2)}, passionate ${vp.toneScores.passionate.toFixed(2)}`
  const examples = input.examples
    .slice(0, 12)
    .map((ex, i) => `Example ${i + 1}:\n${ex.trim()}`)
    .join('\n\n')
  const idp = input.identityProfile
  const crossSamples = (input.crossPlatformSamples ?? [])
    .slice(0, 10)
    .map((ex, i) => `Signal ${i + 1}:\n${ex.trim()}`)
    .join('\n\n')
  const identitySummary = idp
    ? [
        idp.summary,
        `Top cross-platform words: ${idp.topWords.slice(0, 20).map((w) => w.word).join(', ') || '(none)'}`,
        `Top cross-platform phrases: ${idp.topPhrases.slice(0, 12).map((p) => p.phrase).join(', ') || '(none)'}`,
        `Top timeline sources: ${idp.topTimelineSources.slice(0, 8).map((s) => `${s.source} (${s.count})`).join(', ') || '(none)'}`,
        `Top channels: ${idp.topChannels.slice(0, 8).map((c) => `${c.channel} (${c.count})`).join(', ') || '(none)'}`,
        `Top domains: ${idp.topDomains.slice(0, 12).map((d) => `${d.domain} (${d.count})`).join(', ') || '(none)'}`,
      ].join('\n')
    : 'No cross-platform identity profile available yet.'

  return `You are writing as ${name} based on their Reddit writing plus cross-platform digital history.

WRITING STYLE ANALYSIS:
- Average comment length: ${Math.round(vp.avgLength)} words
- Median comment length: ${Math.round(vp.medianLength)} words
- Vocabulary level: ${vp.vocabularyLevel}
- Tone scores (0-1): ${toneSummary}
- Average words per sentence: ${vp.avgWordsPerSentence.toFixed(1)}
- Complex sentence ratio: ${vp.complexSentenceRatio.toFixed(2)}
- Punctuation habits: exclamations/comment ${vp.punctuationStyle.exclamationsPerComment.toFixed(2)}, questions/comment ${vp.punctuationStyle.questionsPerComment.toFixed(2)}, ellipses/comment ${vp.punctuationStyle.ellipsesPerComment.toFixed(2)}, em-dashes/comment ${vp.punctuationStyle.emDashesPerComment.toFixed(2)}

MOST FREQUENT PHRASES:
${phrases}

MOST FREQUENT WORDS/TERMS:
${signatures}

STARTER PHRASES:
${starters}

CLOSING PHRASES:
${closers}

EXAMPLES OF THEIR ACTUAL WRITING:
${examples || '(none)'}

CROSS-PLATFORM IDENTITY PROFILE (Gmail/Chrome/YouTube/Voice/Discover/etc):
${identitySummary}

RELEVANT CROSS-PLATFORM SIGNALS FOR THIS TOPIC:
${crossSamples || '(none)'}

PERSONALITY ADJUSTMENTS FOR THIS RESPONSE:
- Formality: ${sliderInstruction('formality', input.sliders.formality)}
- Assertiveness: ${sliderInstruction('assertiveness', input.sliders.assertiveness)}
- Verbosity: ${sliderInstruction('verbosity', input.sliders.verbosity)}
- Emotion: ${sliderInstruction('emotion', input.sliders.emotion)}
- Spicy: ${sliderInstruction('spicy', input.sliders.spicy)}
- Optimism: ${sliderInstruction('optimism', input.sliders.optimism)}

TASK:
Write a response about: ${input.topic}

RULES:
- Execute the request directly. If the user asks for a poem, output only the poem. If they ask for an email, output only the email.
- Do not comment on the request itself. No preface, critique, pep talk, or "my take" style framing.
- Start immediately with the requested content.
- Output only the drafted response, no analysis labels.
- Match the user voice first, then apply slider adjustments.
- Blend in cross-platform identity signals (interests, terms, channels) where relevant, without inventing facts.
- Prioritize lexical and phrase similarity to the examples and frequent words/phrases above.
- Keep factual claims modest unless the topic itself demands certainty.
- Avoid repeating the same phrase unnaturally.

Write in their authentic voice, adjusted for the personality settings above.`
}
