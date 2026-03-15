import type { RedditSearchResult } from '../../../types/reddit.types'

type Props = {
  citation: RedditSearchResult
  index: number
  highlighted?: boolean
}

export default function CitationCard({ citation, index, highlighted = false }: Props) {
  const date = citation.createdAt ? new Date(citation.createdAt) : null
  const dateLabel = date && Number.isFinite(date.getTime()) ? date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : 'Unknown date'
  const isHighEngagement = (citation.score ?? 0) > 10
  const displayText = citation.title ? `${citation.title}\n${citation.snippet}` : citation.snippet

  return (
    <div
      className={`rounded-lg border bg-black/20 transition-colors ${highlighted ? 'border-cyan-400/70' : 'border-white/10 hover:border-white/20'}`}
    >
      <div className="flex items-center justify-between border-b border-white/10 px-3 py-2">
        <div className="flex items-center gap-2">
          <span className="rounded bg-indigo-500/25 px-1.5 py-0.5 text-[11px] text-indigo-100">[{index}]</span>
          <div className="text-xs text-white/80">r/{citation.subreddit ?? 'unknown'}</div>
          <div className="text-xs text-white/45">{dateLabel}</div>
        </div>
        {isHighEngagement && <div className="text-xs text-emerald-300">↑ {Math.round(citation.score ?? 0)}</div>}
      </div>
      <div className="px-3 py-2 text-xs whitespace-pre-wrap text-white/80">{displayText}</div>
      <div className="flex items-center gap-3 px-3 pb-3">
        <button
          className="rounded bg-white/10 px-2 py-1 text-[11px] text-white hover:bg-white/15 disabled:opacity-50"
          disabled={!citation.permalink}
          onClick={() => {
            if (!citation.permalink) return
            void window.digitalTwin.openExternal(citation.permalink)
          }}
        >
          Open
        </button>
      </div>
    </div>
  )
}

