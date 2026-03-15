import type { VoiceProfile } from '../../analysis/voiceAnalyzer.js'
import type { IdentityLearningProfile } from '../../types/identityLearning.types.js'

export type QuerySource = {
  text: string
  subreddit: string | null
  timestamp: string | null
  score: number
}

export function buildQueryChatPrompt(
  question: string,
  voiceProfile: VoiceProfile | null,
  identityProfile: IdentityLearningProfile | null,
  retrievedSources: QuerySource[],
  cutoffDate?: Date,
): string {
  const hasStrongSources = retrievedSources.length >= 3
  return hasStrongSources
    ? buildSourceBasedPrompt(question, voiceProfile, retrievedSources, cutoffDate)
    : buildProfileBasedPrompt(question, voiceProfile, identityProfile, cutoffDate)
}

export function buildSourceBasedPrompt(
  question: string,
  voiceProfile: VoiceProfile | null,
  sources: QuerySource[],
  cutoffDate?: Date,
): string {
  const eraContext = cutoffDate ? `Time period: only use data on or before ${cutoffDate.toLocaleDateString('en-US')}.` : ''
  const casualPct = voiceProfile ? (voiceProfile.toneScores.casual * 100).toFixed(0) : '60'
  const humorPct = voiceProfile ? (voiceProfile.toneScores.humorous * 100).toFixed(0) : '20'
  const seriousPct = voiceProfile ? (voiceProfile.toneScores.serious * 100).toFixed(0) : '40'
  return `You are the user's chat assistant with memory of their data.

Question:
"${question}"
${eraContext}

Relevant history:
${sources
  .slice(0, 8)
  .map((src, i) => {
    const dt = src.timestamp ? new Date(src.timestamp) : null
    const dateLabel = dt && Number.isFinite(dt.getTime()) ? dt.toLocaleDateString('en-US') : 'unknown date'
    return `[${i + 1}] r/${src.subreddit ?? 'unknown'} on ${dateLabel}:\n"${src.text}"${src.score > 5 ? `\n(${src.score} upvotes)` : ''}`
  })
  .join('\n\n')}

Instructions:
1. Answer directly and conversationally, like a trusted friend who knows their history.
2. Synthesize patterns, don't just quote.
3. Use natural citations for key claims only, e.g. [1], [2].
4. Note changes over time when present.
5. If there are contradictions, acknowledge them naturally.
6. Keep answer around 3-6 sentences by default.
7. Vibe target: casual ${casualPct}%, humorous ${humorPct}%, serious ${seriousPct}%.
`
}

export function buildProfileBasedPrompt(
  question: string,
  voiceProfile: VoiceProfile | null,
  identityProfile: IdentityLearningProfile | null,
  cutoffDate?: Date,
): string {
  const eraContext = cutoffDate ? `Only consider data on or before ${cutoffDate.toLocaleDateString('en-US')}.` : ''
  const topWords = identityProfile?.topWords.slice(0, 12).map((x) => x.word).join(', ') || '(limited)'
  const topSources = identityProfile?.topTimelineSources.slice(0, 8).map((x) => `${x.source}(${x.count})`).join(', ') || '(limited)'
  const topSubs = identityProfile?.topUpvotedSubreddits.slice(0, 8).map((x) => `r/${x.subreddit}`).join(', ') || '(limited)'
  return `You are the user's chat assistant with partial evidence.

Question:
"${question}"
${eraContext}

What we know:
- Summary: ${identityProfile?.summary ?? 'No identity summary available yet.'}
- Top words: ${topWords}
- Top active sources: ${topSources}
- Top subreddit clusters: ${topSubs}
- Voice style: ${voiceProfile ? `${(voiceProfile.toneScores.casual * 100).toFixed(0)}% casual, avg ${Math.round(voiceProfile.avgLength)} words` : 'voice profile unavailable'}

Instructions:
1. Be clear this is an inference when evidence is thin.
2. Still give a useful best-effort answer; do not refuse.
3. Keep tone conversational and human.
4. Suggest where they likely discussed this if relevant.
5. Keep it short (3-5 sentences).
`
}

export function buildPhraseFrequencyPrompt(
  phrase: string,
  matches: QuerySource[],
  totalItems: number,
): string {
  const frequency = matches.length
  const percentage = totalItems > 0 ? ((frequency / totalItems) * 100).toFixed(1) : '0.0'
  const sorted = [...matches]
    .filter((m) => m.timestamp)
    .sort((a, b) => Date.parse(a.timestamp ?? '') - Date.parse(b.timestamp ?? ''))
  const first = sorted[0]?.timestamp ? new Date(sorted[0].timestamp ?? '').toLocaleDateString('en-US') : null
  const last = sorted[sorted.length - 1]?.timestamp
    ? new Date(sorted[sorted.length - 1].timestamp ?? '').toLocaleDateString('en-US')
    : null
  return `You found ${frequency} instances of "${phrase}" across ${totalItems} total items (${percentage}%).

Write a natural response (not robotic) that:
1. States whether this is common for them.
2. Notes trend over time if possible (first ${first ?? 'n/a'}, latest ${last ?? 'n/a'}).
3. Includes 2-3 short example citations like [1], [2], [3].
4. Stays under 4 sentences before examples.
`
}

export function buildTimePeriodSummaryPrompt(
  timeframe: string,
  sources: QuerySource[],
): string {
  const topSubs = topSubredditNames(sources, 5)
  return `Summarize what the user was like during "${timeframe}" based on these sources.

Data:
- Activity count: ${sources.length}
- Active communities: ${topSubs.join(', ') || '(unknown)'}
- Examples:
${sources
  .slice(0, 8)
  .map((s, i) => `[${i + 1}] r/${s.subreddit ?? 'unknown'}: "${s.text}"`)
  .join('\n')}

Write a 4-6 sentence narrative summary:
1. Main interests at that time
2. Tone/mood and style
3. Notable shifts if visible
4. Cite 1-3 sources inline [1], [2]
Use conversational style, not a dry report.
`
}

export function buildComparisonPrompt(topicA: string, topicB: string, a: QuerySource[], b: QuerySource[]): string {
  const sentA = sentimentLabel(a)
  const sentB = sentimentLabel(b)
  return `Compare the user's stance on "${topicA}" vs "${topicB}".

Data:
- ${topicA}: ${a.length} items, sentiment ${sentA}
- ${topicB}: ${b.length} items, sentiment ${sentB}
- ${topicA} examples:
${a.slice(0, 4).map((x, i) => `[A${i + 1}] "${x.text}"`).join('\n')}
- ${topicB} examples:
${b.slice(0, 4).map((x, i) => `[B${i + 1}] "${x.text}"`).join('\n')}

Write 4-5 sentences:
1. Clear lean/preference conclusion
2. Engagement difference
3. Tone contrast
4. Use citations like [A1], [B2]
`
}

export function buildEvolutionPrompt(
  topic: string,
  phases: Array<{ timeframe: string; sentiment: number; examples: QuerySource[] }>,
): string {
  return `Track how the user's opinion on "${topic}" evolved.

Evolution phases:
${phases
  .map(
    (p, i) => `- ${p.timeframe}: sentiment ${p.sentiment.toFixed(2)}
${p.examples.map((e, j) => `  [${i + 1}.${j + 1}] "${e.text}"`).join('\n')}`,
  )
  .join('\n')}

Write 5-6 sentences:
1. Starting stance
2. Key changes
3. Current stance
4. Consistency vs flip-flop
5. Cite examples like [1.1], [2.1]
`
}

function topSubredditNames(items: QuerySource[], limit: number) {
  const counts = new Map<string, number>()
  for (const i of items) {
    const s = i.subreddit ?? 'unknown'
    counts.set(s, (counts.get(s) ?? 0) + 1)
  }
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([s]) => `r/${s}`)
}

function sentimentLabel(items: QuerySource[]): string {
  const pos = ['love', 'great', 'awesome', 'good', 'best', 'excellent', 'amazing']
  const neg = ['hate', 'terrible', 'awful', 'bad', 'worst', 'horrible', 'sucks']
  let score = 0
  for (const item of items) {
    const t = item.text.toLowerCase()
    for (const p of pos) if (t.includes(p)) score++
    for (const n of neg) if (t.includes(n)) score--
  }
  if (score > 0) return 'positive'
  if (score < 0) return 'negative'
  return 'neutral'
}
