import { useMemo, useState } from 'react'
import type { WriteAgentSliders } from '../../types/writeAgent.types'

type SliderKey = keyof WriteAgentSliders

const sliderDefs: Array<{ key: SliderKey; label: string; hint: string }> = [
  { key: 'formality', label: 'Formality', hint: 'casual ←→ professional' },
  { key: 'assertiveness', label: 'Assertiveness', hint: 'diplomatic ←→ direct' },
  { key: 'verbosity', label: 'Verbosity', hint: 'concise ←→ detailed' },
  { key: 'emotion', label: 'Emotion', hint: 'neutral ←→ expressive' },
  { key: 'spicy', label: 'Spicy', hint: 'safe ←→ controversial' },
  { key: 'optimism', label: 'Optimism', hint: 'critical ←→ supportive' },
]

const defaultSliders: WriteAgentSliders = {
  formality: 5,
  assertiveness: 5,
  verbosity: 5,
  emotion: 5,
  spicy: 5,
  optimism: 5,
}

type Props = {
  lockedDate?: Date | null
}

export default function WriteAgent({ lockedDate = null }: Props) {
  const [topic, setTopic] = useState('')
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [sliders, setSliders] = useState<WriteAgentSliders>(defaultSliders)

  const sliderLine = useMemo(
    () =>
      sliderDefs
        .map((s) => `${s.label} ${sliders[s.key]}/10`)
        .join(' · '),
    [sliders],
  )

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
          sliders,
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

  async function refreshVoiceProfile() {
    setError(null)
    setBusy(true)
    try {
      await window.digitalTwin.trainVoiceProfile()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Voice profile refresh failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <div className="rounded-xl border border-white/10 bg-white/5 p-6">
        <h1 className="text-xl font-semibold text-white">Write Like Me</h1>
        <p className="mt-2 text-sm text-white/70">
          Draft in your voice using your Reddit profile + Gemini.
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
              placeholder="Example: reply to a client who asked for a project timeline"
            />
          </div>

          <div className="rounded-lg border border-white/10 bg-black/20 p-3">
            <div className="mb-3 text-xs text-white/50">Personality sliders</div>
            <div className="space-y-3">
              {sliderDefs.map(({ key, label, hint }) => (
                <div key={key} className="grid grid-cols-[130px_1fr_44px] items-center gap-3">
                  <div className="text-sm text-white/80">
                    {label}
                    <div className="text-xs text-white/40">{hint}</div>
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={10}
                    step={1}
                    value={sliders[key]}
                    onChange={(e) =>
                      setSliders((prev) => ({
                        ...prev,
                        [key]: Number(e.target.value),
                      }))
                    }
                  />
                  <div className="text-xs tabular-nums text-right text-white/70">{sliders[key]}</div>
                </div>
              ))}
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
            <button
              className="rounded-lg bg-white/10 px-3 py-2 text-sm font-medium text-white hover:bg-white/15 transition-colors disabled:opacity-50"
              onClick={refreshVoiceProfile}
              disabled={busy}
            >
              Refresh voice profile
            </button>
          </div>

          {error && <div className="text-xs text-red-300">{error}</div>}
        </div>
      </div>

      <div className="rounded-xl border border-white/10 bg-white/5 p-6">
        <h2 className="text-lg font-semibold text-white">Draft</h2>
        <p className="mt-2 text-sm text-white/70">{sliderLine}</p>

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
