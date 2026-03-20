import { useEffect, useMemo, useState } from 'react'
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import type { RedditDataset } from '../../types/reddit.types'
import ImportFlow from './ImportFlow'
import IdentityInsightsGrid from './IdentityInsightsGrid'

type Stat = { label: string; value: string }

function groupByDay(isoDates: Array<string | null | undefined>) {
  const map = new Map<string, number>()
  for (const d of isoDates) {
    if (!d) continue
    const day = d.slice(0, 10)
    map.set(day, (map.get(day) ?? 0) + 1)
  }
  return Array.from(map.entries())
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([day, count]) => ({ day, count }))
}

export default function Dashboard() {
  const [dataset, setDataset] = useState<RedditDataset | null>(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const latest = await window.digitalTwin?.loadLatestRedditDataset?.()
      if (!cancelled && latest) setDataset(latest)
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const stats: Stat[] = useMemo(() => {
    if (!dataset) {
      return [
        { label: 'Comments', value: '—' },
        { label: 'Posts', value: '—' },
        { label: 'Saved', value: '—' },
        { label: 'Upvoted', value: '—' },
      ]
    }

    return [
      { label: 'Comments', value: String(dataset.comments.length) },
      { label: 'Posts', value: String(dataset.posts.length) },
      { label: 'Saved', value: String(dataset.saved.length) },
      { label: 'Upvoted', value: String(dataset.upvoted.length) },
    ]
  }, [dataset])

  const timelineData = useMemo(() => {
    if (!dataset) return []
    const dates = [...dataset.comments.map((c) => c.createdAt), ...dataset.posts.map((p) => p.createdAt)]
    return groupByDay(dates)
  }, [dataset])

  const topSubreddits = useMemo(() => {
    if (!dataset) return []
    const map = new Map<string, number>()
    for (const c of dataset.comments) {
      if (!c.subreddit) continue
      map.set(c.subreddit, (map.get(c.subreddit) ?? 0) + 1)
    }
    for (const p of dataset.posts) {
      if (!p.subreddit) continue
      map.set(p.subreddit, (map.get(p.subreddit) ?? 0) + 1)
    }
    return Array.from(map.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([name, count]) => ({ name, count }))
  }, [dataset])

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-white">Who Am I</h1>
          <p className="mt-1 text-sm text-white/60">Your Reddit activity, normalized locally.</p>
        </div>
      </div>

      <ImportFlow onImported={setDataset} />

      <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
        {stats.map((s) => (
          <div key={s.label} className="rounded-xl border border-white/10 bg-white/5 p-4">
            <div className="text-xs text-white/60">{s.label}</div>
            <div className="mt-2 text-2xl font-semibold text-white">{s.value}</div>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2 rounded-xl border border-white/10 bg-white/5 p-4">
          <div className="text-sm font-medium text-white">Activity timeline</div>
          <div className="mt-3 h-64">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={timelineData} margin={{ left: 0, right: 8, top: 8, bottom: 0 }}>
                <CartesianGrid stroke="rgba(255,255,255,0.08)" vertical={false} />
                <XAxis dataKey="day" tick={{ fill: 'rgba(255,255,255,0.6)', fontSize: 12 }} />
                <YAxis tick={{ fill: 'rgba(255,255,255,0.6)', fontSize: 12 }} />
                <Tooltip
                  contentStyle={{
                    background: 'rgba(10, 10, 14, 0.95)',
                    border: '1px solid rgba(255,255,255,0.12)',
                    borderRadius: 8,
                    color: 'white',
                  }}
                  cursor={{ fill: 'rgba(255,255,255,0.05)' }}
                />
                <Bar dataKey="count" fill="rgba(99, 102, 241, 0.85)" radius={[6, 6, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="rounded-xl border border-white/10 bg-white/5 p-4">
          <div className="text-sm font-medium text-white">Top subreddits</div>
          <div className="mt-3 space-y-2">
            {topSubreddits.length === 0 ? (
              <div className="text-sm text-white/60">Import to see data.</div>
            ) : (
              topSubreddits.map((s) => (
                <div key={s.name} className="flex items-center justify-between">
                  <div className="truncate text-sm text-white/80">r/{s.name}</div>
                  <div className="text-xs text-white/60">{s.count}</div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {/* Identity Insights */}
      <IdentityInsightsGrid />
    </div>
  )
}
