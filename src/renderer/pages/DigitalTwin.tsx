import { useEffect, useMemo, useState } from 'react'
import { useLocation } from 'react-router-dom'
import type { RedditDataset, RedditSearchResult } from '../../types/reddit.types'
import IdentityTimeline from '../components/IdentityTimeline'
import QueryResponse from '../components/TimeMachine/QueryResponse'

type ChatMessage = {
  role: 'user' | 'assistant'
  text: string
  sources?: RedditSearchResult[]
}

export default function DigitalTwin() {
  const location = useLocation()
  const locationLockedDateIso = (location.state as { lockedDate?: string } | null)?.lockedDate ?? null
  const [lockedDateIso, setLockedDateIso] = useState<string | null>(locationLockedDateIso)
  const [dataset, setDataset] = useState<RedditDataset | null>(null)

  const lockedDateLabel = useMemo(() => {
    if (!lockedDateIso) return null
    const d = new Date(lockedDateIso)
    return Number.isFinite(d.getTime())
      ? d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
      : null
  }, [lockedDateIso])

  const [queryInput, setQueryInput] = useState('')
  const [queryBusy, setQueryBusy] = useState(false)
  const [queryError, setQueryError] = useState<string | null>(null)
  const [queryMessages, setQueryMessages] = useState<ChatMessage[]>([])

  const [cloneInput, setCloneInput] = useState('')
  const [cloneBusy, setCloneBusy] = useState(false)
  const [cloneError, setCloneError] = useState<string | null>(null)
  const [cloneMessages, setCloneMessages] = useState<ChatMessage[]>([])

  useEffect(() => {
    setLockedDateIso(locationLockedDateIso)
  }, [locationLockedDateIso])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const latest = await window.digitalTwin.loadLatestRedditDataset()
        if (!cancelled) setDataset(latest)
      } catch {
        if (!cancelled) setDataset(null)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    setQueryMessages([
      {
        role: 'assistant',
        text: lockedDateLabel
          ? `Query mode is locked to ${lockedDateLabel}. Ask anything naturally; I’ll use your data up to that date when relevant.`
          : 'Query mode: AI chat first, with your imported data as memory/context.',
      },
    ])
    setCloneMessages([
      {
        role: 'assistant',
        text: lockedDateLabel
          ? `Clone mode is locked to ${lockedDateLabel}. Talk to your past self directly.`
          : 'Clone mode: talk to your digital clone directly.',
      },
    ])
  }, [lockedDateLabel])

  const canSendQuery = useMemo(() => queryInput.trim().length >= 2, [queryInput])
  const canSendClone = useMemo(() => cloneInput.trim().length >= 2, [cloneInput])

  async function sendQuery() {
    const question = queryInput.trim()
    if (question.length < 2 || queryBusy) return

    setQueryInput('')
    setQueryBusy(true)
    setQueryError(null)
    setQueryMessages((prev) => [...prev, { role: 'user', text: question }])

    try {
      const result = await window.digitalTwin.askGemini({
        question,
        cutoffDateIso: lockedDateIso ?? undefined,
      })
      setQueryMessages((prev) => [
        ...prev,
        {
          role: 'assistant',
          text: result.answer,
          sources: result.sources,
        },
      ])
    } catch (e) {
      setQueryError(e instanceof Error ? e.message : 'Query chat failed')
    } finally {
      setQueryBusy(false)
    }
  }

  async function sendClone() {
    const message = cloneInput.trim()
    if (message.length < 2 || cloneBusy) return

    const nextHistory = [...cloneMessages, { role: 'user' as const, text: message }]
      .slice(-10)
      .map((m) => ({ role: m.role, text: m.text }))

    setCloneInput('')
    setCloneBusy(true)
    setCloneError(null)
    setCloneMessages((prev) => [...prev, { role: 'user', text: message }])

    try {
      const result = await window.digitalTwin.chatClone({
        message,
        lockedDateIso: lockedDateIso ?? undefined,
        history: nextHistory,
      })
      setCloneMessages((prev) => [...prev, { role: 'assistant', text: result.answer }])
    } catch (e) {
      setCloneError(e instanceof Error ? e.message : 'Clone chat failed')
    } finally {
      setCloneBusy(false)
    }
  }

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-cyan-300/15 bg-gradient-to-br from-cyan-900/25 via-indigo-900/20 to-slate-900/30 p-6">
        <h1 className="text-xl font-semibold text-white">Time Machine</h1>
        <p className="mt-2 text-sm text-white/75">
          {lockedDateLabel
            ? `Era locked to ${lockedDateLabel}. Query and Clone chats are now both in past-self mode.`
            : 'Use Query chat for factual retrieval and Clone chat for direct conversation with your digital self.'}
        </p>
        {lockedDateLabel && (
          <button
            className="mt-3 rounded-lg border border-white/20 bg-white/10 px-3 py-1.5 text-xs text-white/90 transition-colors hover:bg-white/15"
            onClick={() => setLockedDateIso(null)}
          >
            Clear Era Lock
          </button>
        )}
      </div>

      <IdentityTimeline
        dataset={dataset}
        mode="time-machine"
        onSelectEra={(date) => setLockedDateIso(date.toISOString())}
      />

      <div className="grid gap-4 xl:grid-cols-2">
        <div className="rounded-xl border border-indigo-300/15 bg-white/5 p-6">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-base font-semibold text-white">Query Chat</h2>
            <div className="rounded bg-indigo-500/20 px-2 py-1 text-[11px] text-indigo-100">Chat + memory</div>
          </div>
          <div className="h-[52vh] overflow-auto rounded-lg border border-white/10 bg-black/20 p-3">
            <div className="space-y-3">
              {queryMessages.map((m, idx) => (
                <div key={idx} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                  <div
                    className={`max-w-[92%] rounded-lg px-3 py-2 text-sm whitespace-pre-wrap ${
                      m.role === 'user' ? 'bg-indigo-500/90 text-white' : 'border border-white/10 bg-black/30 text-white/85'
                    }`}
                  >
                    {m.role === 'assistant' ? (
                      <QueryResponse
                        question={queryMessages.slice(0, idx).reverse().find((x) => x.role === 'user')?.text ?? ''}
                        answer={m.text}
                        citations={m.sources ?? []}
                        eraLockedIso={lockedDateIso}
                      />
                    ) : (
                      m.text
                    )}
                  </div>
                </div>
              ))}
              {queryBusy && (
                <div className="flex justify-start">
                  <div className="max-w-[92%] rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm text-white/70">
                    Thinking...
                  </div>
                </div>
              )}
            </div>
          </div>
          {queryError && <div className="mt-3 text-xs text-red-300">{queryError}</div>}
          <div className="mt-4 flex items-center gap-2">
            <input
              className="w-full flex-1 rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm text-white placeholder:text-white/40 outline-none focus:border-indigo-400/60"
              value={queryInput}
              placeholder="Ask about your history..."
              onChange={(e) => setQueryInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  void sendQuery()
                }
              }}
            />
            <button
              className="rounded-lg bg-indigo-600/90 px-3 py-2 text-sm font-medium text-white hover:bg-indigo-600 transition-colors disabled:opacity-50"
              onClick={() => void sendQuery()}
              disabled={!canSendQuery || queryBusy}
            >
              Ask
            </button>
          </div>
        </div>

        <div className="rounded-xl border border-emerald-300/15 bg-white/5 p-6">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-base font-semibold text-white">Digital Clone Chat</h2>
            <div className="rounded bg-emerald-500/20 px-2 py-1 text-[11px] text-emerald-100">Speak as you</div>
          </div>
          <div className="h-[52vh] overflow-auto rounded-lg border border-white/10 bg-black/20 p-3">
            <div className="space-y-3">
              {cloneMessages.map((m, idx) => (
                <div key={idx} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                  <div
                    className={`max-w-[92%] rounded-lg px-3 py-2 text-sm whitespace-pre-wrap ${
                      m.role === 'user' ? 'bg-emerald-500/90 text-white' : 'border border-white/10 bg-black/30 text-white/90'
                    }`}
                  >
                    {m.text}
                  </div>
                </div>
              ))}
              {cloneBusy && (
                <div className="flex justify-start">
                  <div className="max-w-[92%] rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm text-white/70">
                    Thinking...
                  </div>
                </div>
              )}
            </div>
          </div>
          {cloneError && <div className="mt-3 text-xs text-red-300">{cloneError}</div>}
          <div className="mt-4 flex items-center gap-2">
            <input
              className="w-full flex-1 rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm text-white placeholder:text-white/40 outline-none focus:border-emerald-400/60"
              value={cloneInput}
              placeholder={lockedDateLabel ? `Talk to ${lockedDateLabel} you...` : 'Talk to your digital clone...'}
              onChange={(e) => setCloneInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  void sendClone()
                }
              }}
            />
            <button
              className="rounded-lg bg-emerald-600/90 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-600 transition-colors disabled:opacity-50"
              onClick={() => void sendClone()}
              disabled={!canSendClone || cloneBusy}
            >
              Chat
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
