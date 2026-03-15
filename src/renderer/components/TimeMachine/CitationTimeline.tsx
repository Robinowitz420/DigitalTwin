import { useMemo } from 'react'
import type { RedditSearchResult } from '../../../types/reddit.types'

type Props = {
  citations: RedditSearchResult[]
}

export default function CitationTimeline({ citations }: Props) {
  const grouped = useMemo(() => {
    const map = new Map<number, RedditSearchResult[]>()
    for (const c of citations) {
      const d = c.createdAt ? new Date(c.createdAt) : null
      const year = d && Number.isFinite(d.getTime()) ? d.getUTCFullYear() : 0
      const arr = map.get(year) ?? []
      arr.push(c)
      map.set(year, arr)
    }
    return Array.from(map.entries()).sort((a, b) => a[0] - b[0])
  }, [citations])

  return (
    <div className="space-y-4">
      <div className="text-xs font-medium text-white/60">Timeline View</div>
      {grouped.map(([year, rows]) => (
        <div key={year} className="rounded-lg border border-white/10 bg-black/20 p-3">
          <div className="mb-2 text-sm font-medium text-cyan-200">{year || 'Unknown year'}</div>
          <div className="space-y-2">
            {rows.map((c, i) => (
              <div key={`${c.id}-${i}`} className="rounded border-l-2 border-cyan-400/70 bg-black/25 px-3 py-2 text-xs text-white/80">
                <div className="mb-1 text-white/55">r/{c.subreddit ?? 'unknown'} · {c.createdAt?.slice(0, 10) ?? 'unknown'}</div>
                <div className="line-clamp-2">{c.title ? `${c.title}\n` : ''}{c.snippet}</div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

