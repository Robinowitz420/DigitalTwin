import { useEffect, useState } from 'react'

const KEY = 'digitaltwin:firstRunBannerDismissed:v1'

export default function FirstRunBanner() {
  const [dismissed, setDismissed] = useState(true)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const latest = await window.digitalTwin.loadLatestRedditDataset()
        if (cancelled) return
        if (latest) {
          setDismissed(true)
          return
        }
      } catch {
        // ignore
      }
      try {
        const v = window.localStorage.getItem(KEY)
        if (!cancelled) setDismissed(v === '1')
      } catch {
        if (!cancelled) setDismissed(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  if (dismissed) return null

  return (
    <div className="rounded-xl border border-indigo-400/20 bg-indigo-500/10 p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-sm font-medium text-white">Welcome</div>
          <div className="mt-1 text-xs text-white/70">
            Start by importing your Reddit export. Then explore:
            <span className="text-white/90"> Who Am I</span>,
            <span className="text-white/90"> Time Machine</span>, and
            <span className="text-white/90"> Write Like Me</span>.
          </div>
        </div>
        <button
          className="rounded-lg bg-white/10 px-2 py-1 text-xs text-white hover:bg-white/15 transition-colors"
          onClick={() => {
            try {
              window.localStorage.setItem(KEY, '1')
            } catch {
              // ignore
            }
            setDismissed(true)
          }}
        >
          Dismiss
        </button>
      </div>
    </div>
  )
}
