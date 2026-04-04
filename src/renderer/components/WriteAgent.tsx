import { useState } from 'react'
import type { WriteAgentSourceLocks, WriteAgentVoiceMode } from '../../types/writeAgent.types'

type Props = {
  lockedDate?: Date | null
}

export default function WriteAgent({ lockedDate = null }: Props) {
  const [topic, setTopic] = useState('')
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const [voiceMode, setVoiceMode] = useState<WriteAgentVoiceMode>('personal_text')
  const [blendFactor, setBlendFactor] = useState(0) // 0..1 (texting -> posting)
  const [sourceLocks, setSourceLocks] = useState<WriteAgentSourceLocks>({
    includeSms: true,
    includeReddit: true,
    includeGmail: true,
  })

  async function generate() {
    const base = topic.trim()
    const text =
      lockedDate != null
        ? `Write in my voice from around ${lockedDate.toLocaleDateString('en-US', {
            year: 'numeric',
            month: 'short',
            day: 'numeric',
          })}.\n\n${base}`
        : base
    if (text.length < 2) return

    setBusy(true)
    setError(null)
    setDraft('')
    try {
      const result = await window.digitalTwin.writeLikeMeStream(
        {
          topic: text,
          voiceMode,
          blendFactor,
          sourceLocks,
        },
        (_chunk, fullText) => {
          setDraft(fullText)
        },
      )
      setDraft(result.text)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to generate draft')
    } finally {
      setBusy(false)
    }

  }

  return (
    <div className="grid gap-6 xl:grid-cols-2">
      <div className="rounded-xl border border-white/10 bg-white/5 p-6">
        <h1 className="text-xl font-semibold text-white">Write Like Me</h1>
        <p className="mt-2 text-sm text-white/70">
          Draft in your voice using your writing history + Gemini.
        </p>
        {lockedDate && (
          <div className="mt-3 rounded border border-emerald-300/20 bg-emerald-500/10 px-2 py-1 text-xs text-emerald-100/90">
            Era mode: writing with context around {lockedDate.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })}.
          </div>
        )}

        <div className="mt-4 space-y-4">
          <div>
            <div className="mb-2 text-xs text-white/50">What do you want to say?</div>
            <textarea
              className="min-h-[120px] w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm text-white placeholder:text-white/40 outline-none focus:border-indigo-400/60"
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              placeholder="Example: Write a letter to Kevin about my new job"
            />
          </div>

          <div className="rounded-lg border border-white/10 bg-black/20 p-3 space-y-4">
            <div>
              <div className="mb-2 text-xs text-white/50">Voice mode</div>
              <select
                className="w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm text-white outline-none focus:border-indigo-400/60"
                value={voiceMode}
                onChange={(e) => setVoiceMode(e.target.value as WriteAgentVoiceMode)}
              >
                <option value="personal_text">Write like I text</option>
                <option value="close_friend">Close friend</option>
                <option value="public_post">Write like I post</option>
                <option value="professional">Professional</option>
                <option value="unfiltered_me">Unfiltered me</option>
              </select>
            </div>

            <div>
              <div className="mb-2 flex items-center justify-between">
                <div className="text-xs text-white/50">Blend (texting → posting)</div>
                <div className="text-xs tabular-nums text-white/60">{Math.round(blendFactor * 100)}%</div>
              </div>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={blendFactor}
                onChange={(e) => setBlendFactor(Number(e.target.value))}
              />
              <div className="mt-1 flex items-center justify-between text-[11px] text-white/45">
                <div>More like texting</div>
                <div>More like posting</div>
              </div>
            </div>

            <div>
              <div className="mb-2 text-xs text-white/50">Sources (constraints)</div>
              <div className="flex flex-wrap gap-3 text-sm text-white/80">
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={sourceLocks.includeSms !== false}
                    onChange={(e) =>
                      setSourceLocks((prev) => ({ ...prev, includeSms: e.target.checked }))
                    }
                  />
                  SMS
                </label>
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={sourceLocks.includeReddit !== false}
                    onChange={(e) =>
                      setSourceLocks((prev) => ({ ...prev, includeReddit: e.target.checked }))
                    }
                  />
                  Reddit
                </label>
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={sourceLocks.includeGmail !== false}
                    onChange={(e) =>
                      setSourceLocks((prev) => ({ ...prev, includeGmail: e.target.checked }))
                    }
                  />
                  Gmail
                </label>
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              className="rounded-lg bg-indigo-500/90 px-3 py-2 text-sm font-medium text-white hover:bg-indigo-500 transition-colors disabled:opacity-50"
              onClick={generate}
              disabled={busy || topic.trim().length < 2}
            >
              {busy ? 'Generating…' : 'Generate'}
            </button>
          </div>

          {error && <div className="text-xs text-red-300">{error}</div>}

        </div>
      </div>

      <div className="rounded-xl border border-white/10 bg-white/5 p-6">
        <h2 className="text-lg font-semibold text-white">Draft</h2>
        <p className="mt-2 text-sm text-white/70">Mode: {voiceMode.replace('_', ' ')}</p>

        <div className="mt-4">
          <textarea
            className="min-h-[420px] w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm text-white placeholder:text-white/40 outline-none focus:border-indigo-400/60"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="(generated text appears here)"
          />
        </div>

        <div className="mt-3 flex items-center gap-2">
          <button
            className="rounded-lg bg-green-600/90 px-3 py-2 text-sm font-medium text-white hover:bg-green-600 transition-colors disabled:opacity-50"
            onClick={() => {
              if (!draft) return
              void navigator.clipboard.writeText(draft)
            }}
            disabled={!draft}
          >
            Copy
          </button>
          <button
            className="rounded-lg bg-white/10 px-3 py-2 text-sm font-medium text-white hover:bg-white/15 transition-colors disabled:opacity-50"
            onClick={() => setDraft('')}
            disabled={busy}
          >
            Clear
          </button>
        </div>
      </div>

    </div>
  )
}
