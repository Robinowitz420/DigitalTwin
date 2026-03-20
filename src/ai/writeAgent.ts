import type { VoiceProfile, PerContactVoiceProfile } from '../analysis/voiceAnalyzer.js'
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
  styleEnvelope?: {
    avgWords: number
    medianWords: number
    targetWords: number
    maxWords: number
    questionRate: number
    exclaimRate: number
    ellipsesRate: number
    lowercaseStartRate: number
    emojiRate: number
    punctuationPerMsg: number
  }
  identityProfile?: IdentityLearningProfile | null
  crossPlatformSamples?: string[]
  contactProfile?: PerContactVoiceProfile | null
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

  // Dynamically determine style characteristics from the profile
  const isQuestionHeavy = vp.punctuationStyle.questionsPerComment > 0.3
  const isCasual = vp.toneScores.casual > 0.6
  const isFormal = vp.toneScores.formal > 0.5
  const avgSentenceLength = vp.avgWordsPerSentence

  // Length should be driven primarily by the verbosity slider (the user intent),
  // and only secondarily by historical median length.
  // NOTE: sliders are 0-10 scale, so we normalize by dividing by 10.
  const verbosity = (input.sliders.verbosity ?? 5) / 10
  const medianWords = Math.max(12, Math.round(vp.medianLength || 0))
  const styleEnvelopeTarget = input.styleEnvelope?.targetWords
  const styleEnvelopeMax = input.styleEnvelope?.maxWords
  
  // Parse explicit length/tone requests from the topic
  const topicLower = input.topic.toLowerCase()
  const explicitLong = /\b(long|detailed|thorough|comprehensive|full|essay|letter|article|story|explanation|in-depth)\b/.test(topicLower)
  const explicitShort = /\b(short|brief|concise|quick|one-liner|tweet)\b/.test(topicLower)
  const explicitLength = explicitLong ? 'long' : explicitShort ? 'short' : null
  
  // Parse explicit tone from topic
  const explicitFormal = /\b(formal|professional|business|official)\b/.test(topicLower)
  const explicitCasual = /\b(casual|informal|relaxed|friendly|chill)\b/.test(topicLower)
  const explicitTone = explicitFormal ? 'formal' : explicitCasual ? 'casual' : null
  
  // Determine effective verbosity - explicit length requests override slider
  const effectiveVerbosity = explicitLength === 'long' ? 0.85 
    : explicitLength === 'short' ? 0.15 
    : verbosity
  
  const baselineTarget = Math.max(medianWords, styleEnvelopeTarget ?? 0)
  const targetWords =
    effectiveVerbosity >= 0.75
      ? Math.max(baselineTarget, 220)
      : effectiveVerbosity >= 0.5
        ? Math.max(baselineTarget, 120)
        : effectiveVerbosity >= 0.25
          ? Math.max(Math.min(baselineTarget, 120), 60)
          : Math.max(Math.min(baselineTarget, 80), 30)
  const hardMaxWords =
    styleEnvelopeMax != null
      ? (effectiveVerbosity < 0.35 ? styleEnvelopeMax : Math.round(styleEnvelopeMax * 2.5))
      : (effectiveVerbosity < 0.35 ? Math.round(targetWords * 1.15) : Math.round(targetWords * 2.5))

  const lengthGuidance = (() => {
    if (explicitLength === 'long' || effectiveVerbosity >= 0.75) {
      return `Target length: ~${targetWords} words. Write a complete response with structure (multiple paragraphs if helpful). Hard max: ${hardMaxWords} words. The user explicitly requested a longer response.`
    }
    if (effectiveVerbosity >= 0.5) {
      return `Target length: ~${targetWords} words. Aim for a few solid paragraphs. Hard max: ${hardMaxWords} words.`
    }
    if (effectiveVerbosity >= 0.25) {
      return `Target length: ~${targetWords} words. Keep it readable and to the point. Hard max: ${hardMaxWords} words.`
    }
    return `Target length: ~${targetWords} words (often 1-3 sentences). Keep it concise. Hard max: ${hardMaxWords} words.`
  })()

  const questionGuidance = isQuestionHeavy
    ? `This user frequently asks questions. Use questions naturally where appropriate ("wait...", "what's that?", "why?", "how?", "is that...?").`
    : `Use questions only when they naturally fit the topic.`

  const toneGuidance = explicitTone
    ? explicitTone === 'formal'
      ? `The user requested a FORMAL tone. Use polished, professional wording with clean structure.`
      : `The user requested a CASUAL tone. Write in a relaxed, conversational style with contractions and informal phrasing.`
    : isCasual
      ? `Write in a casual, conversational tone. Use contractions, casual language, and direct phrasing.`
      : isFormal
        ? `Write in a more polished, structured tone. Use complete sentences and clear organization.`
        : `Match the tone shown in the examples below - balanced between casual and formal.`

  const neverUsePhrases = [
    'You know',
    'I mean',
    'Honestly',
    'Look',
    'To be fair',
    'At the end of the day',
    'I just wanted to',
  ]
    .map((p) => `- "${p}"`)
    .join('\n')

  const se = input.styleEnvelope
  const styleEnvelopeBlock = se
    ? `
STYLE ENVELOPE (measured from the user's SMS samples selected for THIS request):
- Avg words/message: ${se.avgWords}
- Median words/message: ${se.medianWords}
- Target length: ~${se.targetWords} words
- Max length: ${se.maxWords} words (strict only when verbosity is low)
- Emoji usage rate: ${se.emojiRate} (0..1)
- Lowercase-start rate: ${se.lowercaseStartRate} (0..1)
- Punctuation density: ${se.punctuationPerMsg} punctuation marks/message
- Questions end-rate: ${se.questionRate} (0..1)
- Exclamation usage rate: ${se.exclaimRate} (0..1)
- Ellipses usage rate: ${se.ellipsesRate} (0..1)
`
    : ''

  // Build contact-specific context if available
  const cp = input.contactProfile
  const contactContext = cp ? `
CONTACT-SPECIFIC STYLE (talking to ${cp.contactName}):
- Relationship: ${cp.relationshipType.replace('_', ' ')} (intimacy: ${Math.round(cp.intimacyScore * 100)}%)
- Your style with them: avg ${Math.round(cp.userStyle.avgMessageLength)} chars, ${cp.userStyle.emojiUsageRate.toFixed(2)} emojis/msg, ${cp.userStyle.slangUsageRate.toFixed(2)} slang/msg
- Their style: avg ${Math.round(cp.contactStyle.avgMessageLength)} chars, ${cp.contactStyle.emojiUsageRate.toFixed(2)} emojis/msg
- Shared phrases: ${cp.sharedPhrases.slice(0, 8).join(', ') || '(none)'}
- Total messages: ${cp.totalMessages} (${cp.userMessages} from you, ${cp.contactMessages} from them)

SAMPLES OF YOUR MESSAGES TO ${cp.contactName.toUpperCase()}:
${cp.representativeUserMessages.slice(0, 5).map((m, i) => `${i + 1}. "${m}"`).join('\n') || '(none)'}

SAMPLES OF THEIR MESSAGES (for context):
${cp.representativeContactMessages.slice(0, 3).map((m, i) => `${i + 1}. "${m}"`).join('\n') || '(none)'}
` : ''

  return `You are writing as ${name} based on their complete digital writing history (Reddit, Gmail, Chrome, YouTube, Google Voice, Discover, and other platforms).
${contactContext}
WRITING STYLE ANALYSIS (from their actual writing):
- Average comment length: ${Math.round(vp.avgLength)} words
- Median comment length: ${Math.round(vp.medianLength)} words
- Vocabulary level: ${vp.vocabularyLevel}
- Tone scores (0-1): ${toneSummary}
- Average words per sentence: ${avgSentenceLength.toFixed(1)}
- Complex sentence ratio: ${vp.complexSentenceRatio.toFixed(2)}
- Punctuation habits: exclamations/comment ${vp.punctuationStyle.exclamationsPerComment.toFixed(2)}, questions/comment ${vp.punctuationStyle.questionsPerComment.toFixed(2)}, ellipses/comment ${vp.punctuationStyle.ellipsesPerComment.toFixed(2)}, em-dashes/comment ${vp.punctuationStyle.emDashesPerComment.toFixed(2)}

MOST FREQUENT PHRASES (use these naturally when they fit):
${phrases}

MOST FREQUENT WORDS/TERMS (use these naturally when they fit):
${signatures}

STARTER PHRASES (how they typically begin):
${starters}

CLOSING PHRASES (how they typically end):
${closers}

EXAMPLES OF THEIR ACTUAL WRITING (CRITICAL - study these closely and match their style):
${examples || '(none)'}

${styleEnvelopeBlock}

CROSS-PLATFORM IDENTITY PROFILE (learned from Gmail/Chrome/YouTube/Voice/Discover/etc):
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

CRITICAL LENGTH REQUIREMENT:
${lengthGuidance}
This is a HARD REQUIREMENT, not a suggestion. If the user asked for a long response, you MUST write multiple paragraphs.

RULES:
- Match the user's actual writing style shown in the examples above. Study their tone, sentence structure, and phrasing patterns.
- ${toneGuidance}
- ${questionGuidance}
- Use their frequent phrases and words naturally when they fit the context.
- Match their punctuation habits (exclamations, questions, ellipses, etc.) based on the metrics above.
- Apply the personality slider adjustments while staying true to their core voice.
- IMPORTANT: Length guidance above is MANDATORY. Do NOT write a short response when the user asked for a long one.
- Hard constraints:
  - NEVER use these phrases (Gemini filler tics):
${neverUsePhrases}
  - Do NOT add connective tissue filler ("you know", "I mean", etc.). If the transition isn't present in the examples, keep it abrupt.
  - Do NOT "clean up" the writing. Prefer slightly messy, natural phrasing if the examples are messy.
  - Do NOT over-explain ONLY WHEN the user asked for brevity. Otherwise, provide sufficient detail.
  - If STYLE ENVELOPE is present, match its casing/punctuation/emoji frequency. Its max length is OVERRIDDEN by explicit length requests.
- Write ONLY the response itself. No meta-commentary, no explanations, no "Hey everyone" intros unless that's how they actually write.
- Match the EXAMPLES' style, but RESPECT the user's explicit length/tone request above all.

Write in their authentic voice, adjusted for the personality settings above.`
}
