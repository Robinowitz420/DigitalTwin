import { useMemo, useState } from 'react'
import type { RedditSearchResult } from '../../../types/reddit.types'
import AnswerWithCitations from './AnswerWithCitations'
import CitationTimeline from './CitationTimeline'

type Props = {
  question: string
  answer: string
  citations: RedditSearchResult[]
  eraLockedIso?: string | null
}

export default function QueryResponse({ question, answer, citations, eraLockedIso }: Props) {
  const [view, setView] = useState<'answer' | 'timeline'>('answer')
  const stats = useMemo(() => {
    const high = citations.filter((c) => (c.score ?? 0) > 5).length
    const communities = new Set(citations.map((c) => c.subreddit ?? 'unknown')).size
    return { high, communities }
  }, [citations])

  return (
    <div className="space-y-3">
      <div className="rounded-lg border-l-4 border-indigo-500 bg-black/20 p-3">
        <div className="text-sm text-white">{question}</div>
        {eraLockedIso && <div className="mt-1 text-xs text-white/50">Using data up to {new Date(eraLockedIso).toLocaleDateString('en-US')}</div>}
      </div>

      {citations.length > 0 && (
        <div className="flex gap-2">
          <button
            onClick={() => setView('answer')}
            className={`rounded px-2 py-1 text-xs ${view === 'answer' ? 'bg-indigo-600 text-white' : 'bg-white/10 text-white/70 hover:bg-white/15'}`}
          >
            Answer
          </button>
          <button
            onClick={() => setView('timeline')}
            className={`rounded px-2 py-1 text-xs ${view === 'timeline' ? 'bg-indigo-600 text-white' : 'bg-white/10 text-white/70 hover:bg-white/15'}`}
          >
            Timeline
          </button>
        </div>
      )}

      {view === 'answer' ? <AnswerWithCitations answer={answer} citations={citations} /> : <CitationTimeline citations={citations} />}

      {citations.length > 0 && (
        <div className="grid grid-cols-3 gap-2 rounded-lg border border-white/10 bg-black/20 p-2 text-center text-xs text-white/75">
          <div>
            <div className="text-base font-semibold text-indigo-300">{citations.length}</div>
            <div>Sources</div>
          </div>
          <div>
            <div className="text-base font-semibold text-emerald-300">{stats.high}</div>
            <div>High Engagement</div>
          </div>
          <div>
            <div className="text-base font-semibold text-cyan-300">{stats.communities}</div>
            <div>Communities</div>
          </div>
        </div>
      )}
    </div>
  )
}

