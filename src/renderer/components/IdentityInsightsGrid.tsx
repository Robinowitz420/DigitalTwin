import { useEffect, useState } from 'react'
import type { IdentityLearningProfile, IdentityInsight } from '../../types/identityLearning.types'

const CATEGORY_COLORS: Record<IdentityInsight['category'], { bg: string; border: string; accent: string }> = {
  political_leanings: { bg: 'bg-red-500/10', border: 'border-red-500/30', accent: 'text-red-400' },
  interest_evolution: { bg: 'bg-blue-500/10', border: 'border-blue-500/30', accent: 'text-blue-400' },
  personality_traits: { bg: 'bg-purple-500/10', border: 'border-purple-500/30', accent: 'text-purple-400' },
  topic_expertise: { bg: 'bg-amber-500/10', border: 'border-amber-500/30', accent: 'text-amber-400' },
  mood_patterns: { bg: 'bg-pink-500/10', border: 'border-pink-500/30', accent: 'text-pink-400' },
  writing_style: { bg: 'bg-emerald-500/10', border: 'border-emerald-500/30', accent: 'text-emerald-400' },
  consumption_vs_creation: { bg: 'bg-cyan-500/10', border: 'border-cyan-500/30', accent: 'text-cyan-400' },
  contradictions: { bg: 'bg-orange-500/10', border: 'border-orange-500/30', accent: 'text-orange-400' },
}

const CATEGORY_LABELS: Record<IdentityInsight['category'], string> = {
  political_leanings: 'Political Leanings',
  interest_evolution: 'Interest Evolution',
  personality_traits: 'Personality Traits',
  topic_expertise: 'Topic Expertise',
  mood_patterns: 'Mood Patterns',
  writing_style: 'Writing Style',
  consumption_vs_creation: 'Consumption vs Creation',
  contradictions: 'Contradictions',
}

const CONFIDENCE_ICONS: Record<IdentityInsight['confidence'], string> = {
  high: '●',
  medium: '◐',
  low: '○',
}

export default function IdentityInsightsGrid() {
  const [profile, setProfile] = useState<IdentityLearningProfile | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const loaded = await window.digitalTwin?.loadIdentityProfile?.() as IdentityLearningProfile | null | undefined
        if (!cancelled) setProfile(loaded ?? null)
      } catch {
        // No profile yet
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [])

  if (loading) {
    return (
      <div className="rounded-xl border border-white/10 bg-white/5 p-4">
        <div className="text-sm text-white/60">Loading identity insights…</div>
      </div>
    )
  }

  if (!profile || !profile.insights?.length) {
    return (
      <div className="rounded-xl border border-white/10 bg-white/5 p-4">
        <div className="text-sm text-white/60">
          No identity insights yet. Run "Learn Who I Am" to generate insights.
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-white">Identity Insights</h2>
        <div className="text-xs text-white/50">
          Generated {new Date(profile.generatedAt).toLocaleDateString()}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
        {profile.insights.map((insight) => {
          const colors = CATEGORY_COLORS[insight.category]
          return (
            <div
              key={insight.category}
              className={`rounded-xl border ${colors.border} ${colors.bg} p-4`}
            >
              <div className="flex items-start justify-between">
                <div className="text-sm font-medium text-white">
                  {insight.title || CATEGORY_LABELS[insight.category]}
                </div>
                <div className="flex items-center gap-2">
                  {insight.score !== undefined && (
                    <span className={`text-xs font-mono ${colors.accent}`}>
                      {insight.score}
                    </span>
                  )}
                  <span 
                    className={`text-xs ${colors.accent}`}
                    title={`Confidence: ${insight.confidence}`}
                  >
                    {CONFIDENCE_ICONS[insight.confidence]}
                  </span>
                </div>
              </div>

              <p className="mt-2 text-xs text-white/70 leading-relaxed">
                {insight.summary}
              </p>

              {insight.details.length > 0 && (
                <div className="mt-3 space-y-1">
                  {insight.details.slice(0, 3).map((detail, i) => (
                    <div key={i} className="text-[11px] text-white/50 flex gap-2">
                      <span className={colors.accent}>•</span>
                      <span className="flex-1 truncate">{detail}</span>
                    </div>
                  ))}
                  {insight.details.length > 3 && (
                    <div className="text-[10px] text-white/40">
                      +{insight.details.length - 3} more
                    </div>
                  )}
                </div>
              )}

              <div className="mt-3 flex items-center gap-2">
                <span className={`text-[10px] uppercase tracking-wide ${colors.accent}`}>
                  {insight.confidence} confidence
                </span>
              </div>
            </div>
          )
        })}
      </div>

      {/* Summary */}
      <div className="rounded-xl border border-white/10 bg-white/5 p-4">
        <div className="text-xs font-medium text-white/80 mb-2">Overall Summary</div>
        <p className="text-sm text-white/70">{profile.summary}</p>
      </div>
    </div>
  )
}
