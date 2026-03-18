import { useMemo, useState } from 'react'
import type { RedditSearchResult } from '../../types/reddit.types'

type ChatMessage = {
  role: 'user' | 'assistant'
  text: string
  sources?: RedditSearchResult[]
}

type Tab = 'chat' | 'inspector'

export default function ToolsPage() {
  const [tab, setTab] = useState<Tab>('chat')

  const [chatInput, setChatInput] = useState('')
  const [chatBusy, setChatBusy] = useState(false)
  const [chatError, setChatError] = useState<string | null>(null)
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([
    {
      role: 'assistant',
      text: 'Model chat: ask the SaaS model what it knows, verify context, or query your imported data.',
    },
  ])

  const [debugBusy, setDebugBusy] = useState(false)
  const [debugError, setDebugError] = useState<string | null>(null)
  const [debugData, setDebugData] = useState<any>(null)

  const canSendChat = useMemo(() => chatInput.trim().length >= 2, [chatInput])

  async function sendChat() {
    const question = chatInput.trim()
    if (question.length < 2 || chatBusy) return

    setChatInput('')
    setChatBusy(true)
    setChatError(null)
    setChatMessages((prev) => [...prev, { role: 'user', text: question }])

    try {
      const result = await window.digitalTwin.askGemini({
        question,
      })
      setChatMessages((prev) => [
        ...prev,
        {
          role: 'assistant',
          text: result.answer,
          sources: result.sources,
        },
      ])
    } catch (e) {
      setChatError(e instanceof Error ? e.message : 'Model chat failed')
    } finally {
      setChatBusy(false)
    }
  }

  async function runDebugMemoryInspector() {
    setDebugError(null)
    setDebugBusy(true)
    try {
      const result = await window.digitalTwin.debugMemoryInspector()
      setDebugData(result)
    } catch (e) {
      setDebugError(e instanceof Error ? e.message : 'Debug inspector failed')
    } finally {
      setDebugBusy(false)
    }
  }

  const tabBase = 'rounded-lg px-3 py-1.5 text-sm transition-colors '
  const tabInactive = 'text-white/70 hover:text-white hover:bg-white/5'
  const tabActive = 'text-white bg-white/10'

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-white/10 bg-white/5 p-6">
        <h1 className="text-xl font-semibold text-white">Tools</h1>
        <p className="mt-2 text-sm text-white/70">Model chat + local debugging utilities.</p>

        <div className="mt-4 flex items-center gap-2 rounded-xl border border-white/10 bg-black/20 p-1">
          <button
            className={tabBase + (tab === 'chat' ? tabActive : tabInactive)}
            onClick={() => setTab('chat')}
          >
            Chat
          </button>
          <button
            className={tabBase + (tab === 'inspector' ? tabActive : tabInactive)}
            onClick={() => setTab('inspector')}
          >
            Debug Memory Inspector
          </button>
        </div>
      </div>

      {tab === 'chat' && (
        <div className="rounded-xl border border-white/10 bg-white/5 p-6">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold text-white">Model Chat</h2>
            <div className="rounded bg-indigo-500/20 px-2 py-1 text-[11px] text-indigo-100">Chat + memory</div>
          </div>
          <p className="mt-2 text-sm text-white/70">Talk directly to the SaaS model to verify what it knows.</p>

          <div className="mt-4 h-[60vh] overflow-auto rounded-lg border border-white/10 bg-black/20 p-3">
            <div className="space-y-3">
              {chatMessages.map((m, idx) => (
                <div key={idx} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                  <div
                    className={`max-w-[92%] rounded-lg px-3 py-2 text-sm whitespace-pre-wrap ${
                      m.role === 'user'
                        ? 'bg-indigo-500/90 text-white'
                        : 'border border-white/10 bg-black/30 text-white/85'
                    }`}
                  >
                    {m.text}
                  </div>
                </div>
              ))}
              {chatBusy && (
                <div className="flex justify-start">
                  <div className="max-w-[92%] rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm text-white/70">
                    Thinking...
                  </div>
                </div>
              )}
            </div>
          </div>

          {chatError && <div className="mt-3 text-xs text-red-300">{chatError}</div>}

          <div className="mt-4 flex items-center gap-2">
            <input
              className="w-full flex-1 rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm text-white placeholder:text-white/40 outline-none focus:border-indigo-400/60"
              value={chatInput}
              placeholder="Ask what the model knows..."
              onChange={(e) => setChatInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  void sendChat()
                }
              }}
              disabled={chatBusy}
            />
            <button
              className="rounded-lg bg-indigo-600/90 px-3 py-2 text-sm font-medium text-white hover:bg-indigo-600 transition-colors disabled:opacity-50"
              onClick={() => void sendChat()}
              disabled={!canSendChat || chatBusy}
            >
              Ask
            </button>
          </div>
        </div>
      )}

      {tab === 'inspector' && (
        <div className="rounded-xl border border-white/10 bg-white/5 p-6">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold text-white">Debug Memory Inspector</h2>
            <button
              className="rounded bg-white/10 px-3 py-2 text-sm text-white hover:bg-white/15 transition-colors disabled:opacity-50"
              onClick={() => void runDebugMemoryInspector()}
              disabled={debugBusy}
            >
              {debugBusy ? 'Loading…' : 'Inspect'}
            </button>
          </div>

          <div className="mt-2 text-sm text-white/70">
            Shows what is actually stored locally (Identity Timeline + Reddit dataset).
          </div>

          {debugError && <div className="mt-3 text-xs text-red-300">{debugError}</div>}

          {debugData && (
            <div className="mt-4 space-y-4 text-sm text-white/80">
              <div className="rounded border border-white/10 bg-black/30 p-3">
                <div className="text-sm font-semibold text-white/90">Identity Timeline</div>
                <div className="mt-1 text-white/70">Has timeline: {String(debugData.identityTimeline?.hasTimeline)}</div>
                <div className="text-white/70">Total events: {String(debugData.identityTimeline?.totalEvents ?? 0)}</div>
                <div className="text-white/70">
                  Date range: {debugData.identityTimeline?.dateRange?.minIso?.slice?.(0, 10) ?? 'n/a'} →{' '}
                  {debugData.identityTimeline?.dateRange?.maxIso?.slice?.(0, 10) ?? 'n/a'}
                </div>
                <div className="mt-2 text-white/70">Counts by source:</div>
                <pre className="mt-1 overflow-auto rounded bg-black/40 p-2 text-[11px] text-white/80">
                  {JSON.stringify(debugData.identityTimeline?.bySource ?? {}, null, 2)}
                </pre>
                <div className="mt-2 text-white/70">Samples:</div>
                <pre className="mt-1 overflow-auto rounded bg-black/40 p-2 text-[11px] text-white/80">
                  {JSON.stringify(debugData.identityTimeline?.samples ?? {}, null, 2)}
                </pre>
              </div>

              <div className="rounded border border-white/10 bg-black/30 p-3">
                <div className="text-sm font-semibold text-white/90">Reddit Dataset</div>
                <div className="mt-1 text-white/70">Has dataset: {String(debugData.redditDataset?.hasDataset)}</div>
                <div className="text-white/70">Counts: {JSON.stringify(debugData.redditDataset?.counts ?? {})}</div>
                <div className="text-white/70">
                  Date range: {debugData.redditDataset?.dateRange?.minIso?.slice?.(0, 10) ?? 'n/a'} →{' '}
                  {debugData.redditDataset?.dateRange?.maxIso?.slice?.(0, 10) ?? 'n/a'}
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
