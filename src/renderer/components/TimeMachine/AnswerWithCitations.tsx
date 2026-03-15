import { useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { RedditSearchResult } from '../../../types/reddit.types'
import CitationCard from './CitationCard'

type Props = {
  answer: string
  citations: RedditSearchResult[]
}

function parseCitationIndexes(chunk: string) {
  return (chunk.match(/\d+/g) ?? []).map((n) => Number(n)).filter((n) => Number.isFinite(n) && n >= 1)
}

export default function AnswerWithCitations({ answer, citations }: Props) {
  const [selectedCitation, setSelectedCitation] = useState<number | null>(null)

  const renderedAnswer = useMemo(() => {
    const citationRegex = /\[(\d+(?:,\d+)*)\]|\[(\d+)\]\[(\d+)\]/g
    const parts: ReactNode[] = []
    let last = 0
    let m: RegExpExecArray | null
    let idx = 0
    while ((m = citationRegex.exec(answer)) !== null) {
      if (m.index > last) {
        parts.push(<span key={`t-${idx++}`}>{answer.slice(last, m.index)}</span>)
      }
      const token = m[0]
      const nums = parseCitationIndexes(token)
      parts.push(
        <button
          key={`c-${idx++}`}
          className="mx-0.5 inline-flex items-center rounded bg-indigo-500/30 px-1 text-[11px] text-indigo-100 hover:bg-indigo-500/45"
          onClick={() => setSelectedCitation(nums[0] ?? null)}
        >
          {nums.join(',')}
        </button>,
      )
      last = m.index + token.length
    }
    if (last < answer.length) parts.push(<span key={`t-${idx++}`}>{answer.slice(last)}</span>)
    return parts
  }, [answer])

  return (
    <div className="space-y-3">
      <div className="rounded-lg border border-white/10 bg-black/20 p-3 text-sm whitespace-pre-wrap text-white/85">
        {renderedAnswer}
      </div>
      {citations.length > 0 && (
        <div className="space-y-2">
          <div className="text-xs font-medium text-white/60">Sources ({citations.length})</div>
          {citations.map((c, i) => (
            <div key={`${c.kind}:${c.id}:${i}`} id={`citation-${i + 1}`}>
              <CitationCard citation={c} index={i + 1} highlighted={selectedCitation === i + 1} />
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
