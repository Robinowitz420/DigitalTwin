import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { RedditDataset } from '../../types/reddit.types'
import type { IdentityTimeline as IdentityTimelineData } from '../../types/identity.types'

type Props = {
  dataset: RedditDataset | null
  mode?: 'default' | 'time-machine'
  onSelectEra?: (date: Date) => void
}

type Bucket = {
  key: string
  label: string
  total: number
  bySource: Record<string, number>
}

type CorpusEntry = {
  source: string
  createdAt: string
  text: string
  hour: number
}

type Contradiction = {
  topic: string
  positive: CorpusEntry
  negative: CorpusEntry
  gapDays: number
}

type InsightScore = {
  id: string
  label: string
  score: number
  note: string
}

function monthKeyFromIso(iso: string) {
  return iso.slice(0, 7)
}

function monthLabelFromKey(key: string) {
  const d = new Date(`${key}-01T00:00:00Z`)
  if (!Number.isFinite(d.getTime())) return key
  return d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' })
}

function parseIsoMaybe(s: string | null | undefined) {
  if (!s) return null
  const d = new Date(s)
  return Number.isFinite(d.getTime()) ? d.toISOString() : null
}

function clamp01(n: number) {
  return Math.max(0, Math.min(1, n))
}

function pct(n: number) {
  return `${Math.round(clamp01(n) * 100)}%`
}

function wordTokens(text: string) {
  return (text.toLowerCase().match(/[a-z0-9']+/g) ?? []).filter(Boolean)
}

function topWords(entries: CorpusEntry[], limit: number) {
  const stop = new Set([
    'the', 'and', 'that', 'this', 'with', 'have', 'your', 'from', 'just', 'like', 'they', 'what', 'when', 'were', 'will', 'would', 'about', 'there', 'their', 'them', 'then', 'than', 'into', 'because', 'could', 'should', 'really', 'also', 'more', 'very', 'you', 'for', 'not', 'are', 'was', 'but', 'can', 'its', 'our', 'out', 'all', 'any', 'how',
  ])
  const counts = new Map<string, number>()
  for (const e of entries) {
    for (const w of wordTokens(e.text)) {
      if (w.length < 3 || stop.has(w)) continue
      counts.set(w, (counts.get(w) ?? 0) + 1)
    }
  }
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
}

function extractDomains(text: string): string[] {
  const matches = text.match(/https?:\/\/[^\s)]+/gi) ?? []
  const out: string[] = []
  for (const m of matches) {
    try {
      const u = new URL(m)
      out.push(u.hostname.replace(/^www\./, ''))
    } catch {
      // ignore
    }
  }
  return out
}

function shannonEntropy(counts: number[]) {
  const total = counts.reduce((a, b) => a + b, 0)
  if (total <= 0) return 0
  let h = 0
  for (const c of counts) {
    if (c <= 0) continue
    const p = c / total
    h += -p * Math.log2(p)
  }
  return h
}

function computeContradictions(entries: CorpusEntry[]): Contradiction[] {
  const topics: Record<string, string[]> = {
    teamwork: ['team', 'teams', 'collaboration', 'coworker', 'manager', 'office'],
    politics: ['politics', 'political', 'election', 'policy', 'government'],
    work: ['job', 'career', 'work', 'company', 'boss'],
    social_media: ['instagram', 'twitter', 'facebook', 'reddit', 'social media'],
    health: ['health', 'exercise', 'diet', 'sleep', 'mental health', 'therapy'],
  }
  const posMarkers = ['love', 'like', 'enjoy', 'great', 'good', 'support', 'best']
  const negMarkers = ['hate', 'dislike', 'awful', 'terrible', 'bad', 'worst', 'hell']

  const contradictions: Contradiction[] = []

  for (const [topic, keys] of Object.entries(topics)) {
    const topicEntries = entries.filter((e) => {
      const low = e.text.toLowerCase()
      return keys.some((k) => low.includes(k))
    })
    if (topicEntries.length < 2) continue

    const positive = topicEntries.find((e) => {
      const low = e.text.toLowerCase()
      return posMarkers.some((m) => low.includes(m))
    })
    const negative = topicEntries.find((e) => {
      const low = e.text.toLowerCase()
      return negMarkers.some((m) => low.includes(m))
    })

    if (!positive || !negative) continue

    const gapDays = Math.abs(Date.parse(positive.createdAt) - Date.parse(negative.createdAt)) / (1000 * 60 * 60 * 24)
    if (!Number.isFinite(gapDays) || gapDays < 7) continue

    contradictions.push({ topic, positive, negative, gapDays })
  }

  return contradictions.sort((a, b) => b.gapDays - a.gapDays).slice(0, 8)
}

export default function IdentityTimeline({ dataset, mode = 'default', onSelectEra }: Props) {
  const navigate = useNavigate()
  const [timeline, setTimeline] = useState<IdentityTimelineData | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [selectedContradiction, setSelectedContradiction] = useState<number>(0)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const tl = await window.digitalTwin.loadIdentityTimeline()
        if (!cancelled) setTimeline(tl)
      } catch {
        if (!cancelled) setTimeline(null)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const buckets = useMemo(() => {
    const map = new Map<string, Bucket>()

    function add(source: string, iso: string | null) {
      if (!iso) return
      const key = monthKeyFromIso(iso)
      const b = map.get(key) ?? {
        key,
        label: monthLabelFromKey(key),
        total: 0,
        bySource: {},
      }
      b.total += 1
      b.bySource[source] = (b.bySource[source] ?? 0) + 1
      map.set(key, b)
    }

    for (const c of dataset?.comments ?? []) add('reddit', parseIsoMaybe(c.createdAt))
    for (const p of dataset?.posts ?? []) add('reddit', parseIsoMaybe(p.createdAt))
    for (const s of dataset?.saved ?? []) add('reddit', parseIsoMaybe(s.createdAt))
    for (const u of dataset?.upvoted ?? []) add('reddit', parseIsoMaybe(u.createdAt))

    for (const e of timeline?.events ?? []) add(e.source, parseIsoMaybe(e.createdAt))

    return Array.from(map.values()).sort((a, b) => (a.key < b.key ? -1 : 1))
  }, [dataset, timeline])

  useEffect(() => {
    if (buckets.length === 0) {
      setSelected(null)
      return
    }
    if (!selected || !buckets.some((b) => b.key === selected)) {
      setSelected(buckets[buckets.length - 1].key)
    }
  }, [buckets, selected])

  const selectedBucket = useMemo(() => buckets.find((b) => b.key === selected) ?? null, [buckets, selected])
  const selectedDate = useMemo(() => {
    if (!selectedBucket) return null
    const d = new Date(`${selectedBucket.key}-01T00:00:00`)
    return Number.isFinite(d.getTime()) ? d : null
  }, [selectedBucket])
  const maxTotal = useMemo(() => Math.max(1, ...buckets.map((b) => b.total)), [buckets])

  const corpus = useMemo(() => {
    const entries: CorpusEntry[] = []

    function add(source: string, text: string | null | undefined, createdAt: string | null | undefined) {
      const iso = parseIsoMaybe(createdAt)
      const trimmed = (text ?? '').trim()
      if (!iso || !trimmed) return
      const d = new Date(iso)
      entries.push({
        source,
        createdAt: iso,
        text: trimmed.slice(0, 1800),
        hour: d.getHours(),
      })
    }

    for (const c of dataset?.comments ?? []) add('reddit', c.body, c.createdAt)
    for (const p of dataset?.posts ?? []) add('reddit', `${p.title ?? ''}\n${p.body ?? ''}`, p.createdAt)
    for (const e of timeline?.events ?? []) add(e.source, e.text, e.createdAt)

    return entries
  }, [dataset, timeline])

  const platformCounts = useMemo(() => {
    const events = timeline?.events ?? []
    const channelMatch = (re: RegExp) => events.filter((e) => re.test((e.channel ?? '').toLowerCase())).length

    return {
      reddit: (dataset?.comments.length ?? 0) + (dataset?.posts.length ?? 0) + (dataset?.saved.length ?? 0) + (dataset?.upvoted.length ?? 0),
      twitter: channelMatch(/twitter|x\b/),
      instagram: channelMatch(/instagram|insta/),
      facebook: channelMatch(/facebook|fb\b/),
      youtube: events.filter((e) => e.source === 'youtube').length,
      tiktok: channelMatch(/tiktok|tik\s*tok/),
      linkedin: channelMatch(/linkedin/),
      spotify: channelMatch(/spotify|music/),
      gmail: events.filter((e) => e.source === 'gmail').length,
      googleVoice: events.filter((e) => e.source === 'google_voice').length,
      chrome: events.filter((e) => e.source === 'chrome').length,
      discover: events.filter((e) => e.source === 'discover').length,
      totalTimeline: events.length,
    }
  }, [dataset, timeline])

  const contradictions = useMemo(() => computeContradictions(corpus), [corpus])

  useEffect(() => {
    if (selectedContradiction >= contradictions.length) setSelectedContradiction(0)
  }, [contradictions, selectedContradiction])

  const scores = useMemo(() => {
    const publicCount = platformCounts.linkedin + platformCounts.twitter + platformCounts.instagram + platformCounts.facebook
    const privateCount = platformCounts.reddit + platformCounts.youtube + platformCounts.gmail + platformCounts.googleVoice
    const totalPubPriv = Math.max(1, publicCount + privateCount)

    const passive = platformCounts.youtube + platformCounts.chrome + platformCounts.discover
    const active = (dataset?.comments.length ?? 0) + (dataset?.posts.length ?? 0) + platformCounts.twitter + platformCounts.instagram + platformCounts.facebook + platformCounts.linkedin
    const totalActivePassive = Math.max(1, passive + active)

    const longReddit = (dataset?.comments ?? []).filter((c) => wordTokens(c.body ?? '').length >= 80).length
    const lateNight = corpus.filter((c) => c.hour >= 0 && c.hour <= 5).length
    const totalCorpus = Math.max(1, corpus.length)

    const byPlatformForEntropy = [
      platformCounts.reddit,
      platformCounts.twitter,
      platformCounts.instagram,
      platformCounts.facebook,
      platformCounts.youtube,
      platformCounts.tiktok,
      platformCounts.linkedin,
      platformCounts.spotify,
    ]
    const entropy = shannonEntropy(byPlatformForEntropy)
    const entropyMax = Math.log2(8)

    const domainSet = new Set<string>()
    for (const c of corpus) {
      for (const d of extractDomains(c.text)) domainSet.add(d)
    }

    const monthlyTotals = buckets.map((b) => b.total)
    const firstHalf = monthlyTotals.slice(0, Math.max(1, Math.floor(monthlyTotals.length / 2)))
    const secondHalf = monthlyTotals.slice(Math.max(1, Math.floor(monthlyTotals.length / 2)))
    const avg = (arr: number[]) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0)
    const growth = avg(secondHalf) - avg(firstHalf)
    const growthNorm = clamp01((growth + 50) / 120)

    const platformCoverage = [
      platformCounts.reddit,
      platformCounts.twitter,
      platformCounts.instagram,
      platformCounts.facebook,
      platformCounts.youtube,
      platformCounts.tiktok,
      platformCounts.linkedin,
      platformCounts.spotify,
    ].filter((n) => n > 0).length / 8

    const contradictionScore = clamp01(contradictions.length / 6)
    const authenticityScore = privateCount / totalPubPriv
    const performativity = publicCount / totalPubPriv
    const hiddenInterestScore = clamp01(passive / totalActivePassive)

    const items: InsightScore[] = [
      { id: 'public_private', label: '1. Public vs Private Self', score: authenticityScore, note: `Private ${privateCount}, Public ${publicCount}` },
      { id: 'consumption_creation', label: '2. Consumption vs Creation', score: clamp01(active / totalActivePassive), note: `Active ${active}, Passive ${passive}` },
      { id: 'stated_revealed', label: '3. Stated vs Revealed Preferences', score: clamp01(0.45 + platformCoverage * 0.4 - contradictionScore * 0.2), note: 'Improves with more profile/bio + behavioral data.' },
      { id: 'authenticity', label: '4. Authenticity Score', score: authenticityScore, note: 'Proxy: private-weighted expression share.' },
      { id: 'knowledge_map', label: '5. Knowledge Map', score: clamp01((longReddit / 800 + platformCounts.youtube / 2500) / 2), note: `${longReddit} long-form comments + YouTube learning signals` },
      { id: 'social_identity', label: '6. Social Identity', score: clamp01(platformCoverage), note: `Coverage across ${Math.round(platformCoverage * 8)}/8 platforms` },
      { id: 'temporal_patterns', label: '7. Temporal Patterns', score: clamp01(buckets.length / 36), note: `${buckets.length} active months detected` },
      { id: 'contradiction_detector', label: '8. Contradiction Detector', score: contradictionScore, note: `${contradictions.length} contradiction candidates found` },
      { id: 'life_phase', label: '9. Life Phase Analysis', score: clamp01((buckets.length / 48 + growthNorm) / 2), note: 'Based on multi-year activity shifts and momentum.' },
      { id: 'influence_sources', label: '10. Influence Sources', score: clamp01(domainSet.size / 80), note: `${domainSet.size} unique linked domains` },
      { id: 'energy_investment', label: '11. Energy Investment Map', score: clamp01(active / totalActivePassive), note: 'Higher = more effortful creation vs passive consumption.' },
      { id: 'hidden_interests', label: '12. Hidden Interests', score: hiddenInterestScore, note: 'Higher = more passive/under-shared interest signals.' },
      { id: 'performativity', label: '13. Performativity Index', score: performativity, note: 'Proxy from public-platform share.' },
      { id: 'identity_fragmentation', label: '14. Identity Fragmentation', score: clamp01(entropy / entropyMax), note: 'Higher = more diversified/fragmented platform expression.' },
      { id: 'value_alignment', label: '15. Value Alignment', score: clamp01(0.9 - contradictionScore * 0.5), note: 'Estimated from contradiction intensity.' },
      { id: 'loneliness', label: '16. Loneliness Indicators', score: clamp01((lateNight / totalCorpus) * 2), note: `${lateNight} late-night items out of ${totalCorpus}` },
      { id: 'growth', label: '17. Growth Trajectory', score: growthNorm, note: 'Trend from early-period to recent-period activity.' },
      { id: 'future', label: '18. Future Self Prediction', score: clamp01((growthNorm + platformCoverage) / 2), note: 'Trajectory confidence from growth + breadth.' },
    ]

    return items
  }, [platformCounts, dataset, corpus, contradictions, buckets])

  const perPlatformInsights = useMemo(() => {
    const missing = (count: number) => count === 0
    return {
      reddit: [
        `Intellectual interests: ${dataset?.subreddits?.length ?? 0} subreddit memberships plus heavy comment volume suggest your deepest engagement zones.`,
        `Opinions & values: ${dataset?.comments.length ?? 0} comments reveal where you argue and what principles you defend.`,
        `Expertise areas: ${(dataset?.comments ?? []).filter((c) => wordTokens(c.body ?? '').length >= 80).length} long-form responses indicate higher-detail domains.`,
        `Community belonging: ${(dataset?.upvoted ?? []).length} upvotes and subreddit spread map your tribes.`,
        `Authenticity: pseudonymous context generally surfaces more candid expression and less professional filtering.`,
        `Evolution of views: date-sliced Reddit analysis can show belief shifts over years and major events.`,
      ],
      twitter: missing(platformCounts.twitter)
        ? ['No Twitter/X data connected yet. Import via Social CSV to unlock these insights.']
        : ['Public persona, real-time interests, hot takes, network shape, political tilt, and performativity are now measurable in timeline periods.'],
      instagram: missing(platformCounts.instagram)
        ? ['No Instagram data connected yet. Import via Social CSV to unlock these insights.']
        : ['Lifestyle aesthetics, social circles, aspirational identity, visual themes, life milestones, and authenticity ratio are tracked by period.'],
      facebook: missing(platformCounts.facebook)
        ? ['No Facebook data connected yet. Import via Social CSV to unlock these insights.']
        : ['Relationships, life events, casual sharing cadence, cause engagement, nostalgia, and groups/community signals can be profiled.'],
      youtube: missing(platformCounts.youtube)
        ? ['No YouTube data connected yet. Import Google Takeout to unlock these insights.']
        : [`Passive consumption: ${platformCounts.youtube} YouTube events captured so far with topic/channel trend potential.`],
      tiktok: missing(platformCounts.tiktok)
        ? ['No TikTok data connected yet. Import via Social CSV to unlock these insights.']
        : ['Entertainment profile, trend behavior, short-cycle interests, and algorithmic preference mirror can be inferred.'],
      linkedin: missing(platformCounts.linkedin)
        ? ['No LinkedIn data connected yet. Import via Social CSV to unlock these insights.']
        : ['Professional narrative, role trajectory, industry focus, networking pattern, and thought-leadership style become visible.'],
      spotify: missing(platformCounts.spotify)
        ? ['No Spotify/music data connected yet. Import via Social CSV to unlock these insights.']
        : ['Mood/energy signatures, nostalgia, genre identity, and listening-time patterns can be profiled over time.'],
    }
  }, [dataset, platformCounts])

  const authenticitySpectrum = useMemo(() => {
    const platforms = [
      { id: 'reddit', label: 'Reddit', count: platformCounts.reddit, score: 0.85 },
      { id: 'twitter', label: 'Twitter/X', count: platformCounts.twitter, score: 0.55 },
      { id: 'instagram', label: 'Instagram', count: platformCounts.instagram, score: 0.42 },
      { id: 'facebook', label: 'Facebook', count: platformCounts.facebook, score: 0.58 },
      { id: 'youtube', label: 'YouTube', count: platformCounts.youtube, score: 0.7 },
      { id: 'linkedin', label: 'LinkedIn', count: platformCounts.linkedin, score: 0.3 },
      { id: 'spotify', label: 'Spotify', count: platformCounts.spotify, score: 0.74 },
    ]
    return platforms
      .filter((p) => p.count > 0)
      .sort((a, b) => b.score - a.score)
  }, [platformCounts])

  const constellation = useMemo(() => {
    const raw = [
      { label: 'Professional', v: platformCounts.linkedin + platformCounts.twitter * 0.4 },
      { label: 'Anonymous', v: platformCounts.reddit + platformCounts.youtube * 0.2 },
      { label: 'Social', v: platformCounts.instagram + platformCounts.facebook + platformCounts.tiktok * 0.5 },
      { label: 'Creative', v: platformCounts.spotify + platformCounts.youtube * 0.3 + platformCounts.instagram * 0.2 },
    ]
    const max = Math.max(1, ...raw.map((r) => r.v))
    return raw.map((r, idx) => ({
      ...r,
      size: 44 + Math.round((r.v / max) * 56),
      left: [16, 56, 28, 70][idx],
      top: [36, 24, 66, 60][idx],
    }))
  }, [platformCounts])

  const knowledgeWords = useMemo(() => topWords(corpus, 12), [corpus])
  const knowledgeNodes = useMemo(() => {
    const expert = knowledgeWords.slice(0, 4)
    const learning = knowledgeWords.slice(4, 8)
    const curious = knowledgeWords.slice(8, 12)
    return { expert, learning, curious }
  }, [knowledgeWords])

  const contradictionMatrix = useMemo(() => {
    const base = clamp01(scores.find((s) => s.id === 'contradiction_detector')?.score ?? 0)
    return [
      { axis: 'Values', reddit: clamp01(base * 0.85), linkedin: clamp01(base * 0.6), instagram: clamp01(base * 0.55) },
      { axis: 'Tone', reddit: clamp01(base * 0.7), linkedin: clamp01(base * 0.9), instagram: clamp01(base * 0.8) },
      { axis: 'Claims', reddit: clamp01(base * 0.75), linkedin: clamp01(base * 0.5), instagram: clamp01(base * 0.45) },
      { axis: 'Lifestyle', reddit: clamp01(base * 0.4), linkedin: clamp01(base * 0.5), instagram: clamp01(base * 0.95) },
    ]
  }, [scores])

  const energyInvestment = useMemo(() => {
    const redditCreate = (dataset?.comments.length ?? 0) + (dataset?.posts.length ?? 0)
    const youtubeConsume = platformCounts.youtube
    const socialLowEffort = platformCounts.instagram + platformCounts.facebook + platformCounts.tiktok
    const max = Math.max(1, redditCreate, youtubeConsume, socialLowEffort)
    return [
      { label: 'High Effort (create)', value: redditCreate, color: 'bg-emerald-500/80', pct: Math.round((redditCreate / max) * 100) },
      { label: 'Passive (consume)', value: youtubeConsume, color: 'bg-blue-500/80', pct: Math.round((youtubeConsume / max) * 100) },
      { label: 'Low Effort (react)', value: socialLowEffort, color: 'bg-amber-500/80', pct: Math.round((socialLowEffort / max) * 100) },
    ]
  }, [dataset, platformCounts])

  if (!dataset && !timeline) {
    return (
      <div className="rounded-xl border border-white/10 bg-white/5 p-6">
        <h2 className="text-lg font-semibold text-white">Identity Timeline</h2>
        <p className="mt-2 text-sm text-white/60">Import data to build your interactive life timeline.</p>
      </div>
    )
  }

  return (
    <div className="rounded-xl border border-white/10 bg-white/5 p-6">
      <h2 className="text-lg font-semibold text-white">Identity Timeline</h2>
      <p className="mt-2 text-sm text-white/60">
        {mode === 'time-machine'
          ? 'Pick an era, lock chat context, and jump into era-based writing.'
          : 'Click any dot to inspect that period, scores, contradictions, and platform insights.'}
      </p>

      <div className="mt-4 overflow-x-auto">
        <div className="min-w-[980px] px-2 pb-2">
          <div className="relative h-24">
            <div className="absolute left-0 right-0 top-10 h-[2px] bg-white/15" />
            <div className="absolute inset-0 flex items-center justify-between">
              {buckets.map((b) => {
                const isSelected = b.key === selectedBucket?.key
                const size = 10 + Math.round((b.total / maxTotal) * 18)
                return (
                  <button
                    key={b.key}
                    onClick={() => setSelected(b.key)}
                    className={`relative rounded-full border transition-colors ${isSelected ? 'border-emerald-300 bg-emerald-500/90' : 'border-white/20 bg-indigo-500/80 hover:bg-indigo-500'}`}
                    style={{ width: size, height: size }}
                    title={`${b.label}: ${b.total.toLocaleString()} events`}
                  >
                    <span className="pointer-events-none absolute left-1/2 top-7 -translate-x-1/2 whitespace-nowrap text-[10px] text-white/70">{b.label}</span>
                  </button>
                )
              })}
            </div>
          </div>
        </div>
      </div>

      {selectedBucket && (
        <div className="mt-6 space-y-4">
          <div className="rounded-lg border border-white/10 bg-black/20 p-3">
            <div className="text-sm font-medium text-white">{selectedBucket.label}</div>
            <div className="mt-1 text-xs text-white/60">Total activity: {selectedBucket.total.toLocaleString()} events</div>
            <div className="mt-2 flex flex-wrap gap-2 text-xs text-white/70">
              {Object.entries(selectedBucket.bySource)
                .sort((a, b) => b[1] - a[1])
                .map(([source, count]) => (
                  <span key={source} className="rounded bg-white/10 px-2 py-1">{source}: {count}</span>
                ))}
            </div>
            {selectedDate && (
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  className="rounded-lg border border-cyan-300/30 bg-gradient-to-r from-cyan-500/80 to-indigo-500/80 px-3 py-1.5 text-xs font-medium text-white shadow-sm shadow-cyan-900/40 transition-colors hover:from-cyan-500 hover:to-indigo-500"
                  onClick={() => {
                    if (onSelectEra) onSelectEra(selectedDate)
                    else navigate('/time', { state: { lockedDate: selectedDate.toISOString() } })
                  }}
                >
                  Lock Chat to Era
                </button>
                <button
                  className="rounded-lg border border-emerald-300/30 bg-gradient-to-r from-emerald-500/80 to-teal-500/80 px-3 py-1.5 text-xs font-medium text-white shadow-sm shadow-emerald-900/40 transition-colors hover:from-emerald-500 hover:to-teal-500"
                  onClick={() => navigate('/write', { state: { lockedDate: selectedDate.toISOString() } })}
                >
                  Write in This Era
                </button>
              </div>
            )}
          </div>

          <div className="rounded-lg border border-white/10 bg-black/20 p-3">
            <div className="mb-2 text-sm font-medium text-white">Cross-Platform Scores</div>
            <div className="grid gap-2 md:grid-cols-2">
              {scores.map((s) => (
                <div key={s.id} className="rounded border border-white/10 bg-black/30 p-2">
                  <div className="flex items-center justify-between text-xs text-white/80">
                    <span>{s.label}</span>
                    <span className="tabular-nums text-white/90">{pct(s.score)}</span>
                  </div>
                  <div className="mt-1 h-2 w-full overflow-hidden rounded bg-white/10">
                    <div className="h-full bg-emerald-500/80" style={{ width: `${Math.round(clamp01(s.score) * 100)}%` }} />
                  </div>
                  <div className="mt-1 text-[11px] text-white/55">{s.note}</div>
                </div>
              ))}
            </div>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <div className="rounded-lg border border-white/10 bg-black/20 p-3">
              <div className="mb-2 text-sm font-medium text-white">Identity Constellation</div>
              <div className="relative h-52 overflow-hidden rounded border border-white/10 bg-black/30">
                {constellation.map((n) => (
                  <div
                    key={n.label}
                    className="absolute -translate-x-1/2 -translate-y-1/2 rounded-full border border-white/20 bg-indigo-500/35 px-2 text-center text-[11px] text-white"
                    style={{ left: `${n.left}%`, top: `${n.top}%`, width: n.size, height: n.size, lineHeight: `${n.size}px` }}
                    title={`${n.label}: ${Math.round(n.v)} weight`}
                  >
                    {n.label}
                  </div>
                ))}
              </div>
            </div>

            <div className="rounded-lg border border-white/10 bg-black/20 p-3">
              <div className="mb-2 text-sm font-medium text-white">Authenticity Spectrum</div>
              <div className="space-y-2">
                {authenticitySpectrum.length === 0 && <div className="text-xs text-white/60">Add more platforms to unlock this spectrum.</div>}
                {authenticitySpectrum.map((p) => (
                  <div key={p.id}>
                    <div className="flex items-center justify-between text-xs text-white/75">
                      <span>{p.label}</span>
                      <span>{pct(p.score)}</span>
                    </div>
                    <div className="mt-1 h-2 overflow-hidden rounded bg-white/10">
                      <div className="h-full bg-cyan-500/80" style={{ width: `${Math.round(p.score * 100)}%` }} />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <div className="rounded-lg border border-white/10 bg-black/20 p-3">
              <div className="mb-2 text-sm font-medium text-white">Knowledge Map</div>
              <div className="grid gap-2 text-xs text-white/75 md:grid-cols-3">
                <div>
                  <div className="mb-1 text-white/90">Expert</div>
                  <div className="space-y-1">
                    {knowledgeNodes.expert.map(([w, c]) => <div key={`e-${w}`} className="rounded bg-emerald-500/15 px-2 py-1">{w} ({c})</div>)}
                  </div>
                </div>
                <div>
                  <div className="mb-1 text-white/90">Learning</div>
                  <div className="space-y-1">
                    {knowledgeNodes.learning.map(([w, c]) => <div key={`l-${w}`} className="rounded bg-blue-500/15 px-2 py-1">{w} ({c})</div>)}
                  </div>
                </div>
                <div>
                  <div className="mb-1 text-white/90">Curious</div>
                  <div className="space-y-1">
                    {knowledgeNodes.curious.map(([w, c]) => <div key={`c-${w}`} className="rounded bg-amber-500/15 px-2 py-1">{w} ({c})</div>)}
                  </div>
                </div>
              </div>
            </div>

            <div className="rounded-lg border border-white/10 bg-black/20 p-3">
              <div className="mb-2 text-sm font-medium text-white">Energy Investment</div>
              <div className="space-y-2">
                {energyInvestment.map((e) => (
                  <div key={e.label}>
                    <div className="flex items-center justify-between text-xs text-white/75">
                      <span>{e.label}</span>
                      <span>{e.value}</span>
                    </div>
                    <div className="mt-1 h-3 overflow-hidden rounded bg-white/10">
                      <div className={`h-full ${e.color}`} style={{ width: `${e.pct}%` }} />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="rounded-lg border border-white/10 bg-black/20 p-3">
            <div className="mb-2 text-sm font-medium text-white">Contradiction Matrix</div>
            <div className="overflow-auto">
              <table className="w-full min-w-[560px] text-xs">
                <thead>
                  <tr className="text-left text-white/65">
                    <th className="py-1 pr-2">Axis</th>
                    <th className="py-1 pr-2">Reddit</th>
                    <th className="py-1 pr-2">LinkedIn</th>
                    <th className="py-1 pr-2">Instagram</th>
                  </tr>
                </thead>
                <tbody>
                  {contradictionMatrix.map((r) => (
                    <tr key={r.axis} className="border-t border-white/10">
                      <td className="py-2 pr-2 text-white/80">{r.axis}</td>
                      {[r.reddit, r.linkedin, r.instagram].map((v, idx) => (
                        <td key={`${r.axis}-${idx}`} className="py-2 pr-2">
                          <div className="h-2 overflow-hidden rounded bg-white/10">
                            <div className="h-full bg-red-500/75" style={{ width: `${Math.round(v * 100)}%` }} />
                          </div>
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <div className="rounded-lg border border-white/10 bg-black/20 p-3 text-xs text-white/80">
              <div className="mb-2 text-sm font-medium text-white">Contradiction Detector</div>
              {contradictions.length === 0 ? (
                <div className="text-white/60">No clear contradiction pairs detected yet. Add more cross-platform data to improve this.</div>
              ) : (
                <div className="space-y-2">
                  <div className="flex flex-wrap gap-2">
                    {contradictions.map((c, idx) => (
                      <button
                        key={`${c.topic}-${idx}`}
                        onClick={() => setSelectedContradiction(idx)}
                        className={`rounded px-2 py-1 text-xs transition-colors ${selectedContradiction === idx ? 'bg-red-500/80 text-white' : 'bg-white/10 text-white/80 hover:bg-white/15'}`}
                      >
                        {c.topic} ({Math.round(c.gapDays)}d)
                      </button>
                    ))}
                  </div>

                  {contradictions[selectedContradiction] && (
                    <div className="rounded border border-white/10 bg-black/30 p-2">
                      <div className="text-white/70">Potential contradiction on <span className="text-white">{contradictions[selectedContradiction].topic}</span></div>
                      <div className="mt-2 grid gap-2">
                        <div className="rounded border border-emerald-400/20 bg-emerald-500/10 p-2">
                          <div className="text-[11px] text-emerald-100/90">Positive stance · {contradictions[selectedContradiction].positive.source} · {contradictions[selectedContradiction].positive.createdAt.slice(0, 10)}</div>
                          <div className="mt-1 text-white/80">{contradictions[selectedContradiction].positive.text.slice(0, 260)}</div>
                        </div>
                        <div className="rounded border border-red-400/20 bg-red-500/10 p-2">
                          <div className="text-[11px] text-red-100/90">Negative stance · {contradictions[selectedContradiction].negative.source} · {contradictions[selectedContradiction].negative.createdAt.slice(0, 10)}</div>
                          <div className="mt-1 text-white/80">{contradictions[selectedContradiction].negative.text.slice(0, 260)}</div>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>

            <div className="rounded-lg border border-white/10 bg-black/20 p-3 text-xs text-white/80">
              <div className="mb-2 text-sm font-medium text-white">Per-Platform Insights</div>
              <div className="space-y-3 max-h-[460px] overflow-auto pr-1">
                {[
                  ['Reddit', perPlatformInsights.reddit],
                  ['Twitter/X', perPlatformInsights.twitter],
                  ['Instagram', perPlatformInsights.instagram],
                  ['Facebook', perPlatformInsights.facebook],
                  ['YouTube', perPlatformInsights.youtube],
                  ['TikTok', perPlatformInsights.tiktok],
                  ['LinkedIn', perPlatformInsights.linkedin],
                  ['Spotify/Music', perPlatformInsights.spotify],
                ].map(([name, lines]) => (
                  <div key={String(name)}>
                    <div className="font-medium text-white/90">{String(name)}</div>
                    <div className="mt-1 space-y-1 text-white/70">
                      {(lines as string[]).map((line, idx) => (
                        <div key={idx}>- {line}</div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
