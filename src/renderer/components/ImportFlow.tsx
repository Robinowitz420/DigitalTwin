import { useEffect, useMemo, useState } from 'react'
import type { RedditDataset, RedditImportProgress } from '../../types/reddit.types'

type Props = {
  onImported: (dataset: RedditDataset) => void
}

function formatPercent(p: number) {
  return `${Math.max(0, Math.min(100, Math.round(p)))}%`
}

export default function ImportFlow({ onImported }: Props) {
  const [hover, setHover] = useState(false)
  const [folderPath, setFolderPath] = useState<string | null>(null)
  const [progress, setProgress] = useState<RedditImportProgress | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const off = window.digitalTwin?.onRedditImportProgress((p) => setProgress(p))
    return () => off?.()
  }, [])

  const progressText = useMemo(() => {
    if (!progress) return null
    const msg = progress.message ? ` — ${progress.message}` : ''
    return `${formatPercent(progress.percent)}${msg}`
  }, [progress])

  async function chooseFolder() {
    setError(null)
    const selected = await window.digitalTwin.selectRedditExportFolder()
    setFolderPath(selected)
  }

  async function runImport() {
    if (!folderPath) return
    setBusy(true)
    setError(null)
    try {
      const dataset = await window.digitalTwin.importRedditExportFromFolder(folderPath)
      onImported(dataset)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Import failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className={
        'rounded-2xl border border-dashed p-6 transition-colors ' +
        (hover ? 'border-white/30 bg-white/5' : 'border-white/15 bg-white/0')
      }
      onDragEnter={(e) => {
        e.preventDefault()
        setHover(true)
      }}
      onDragOver={(e) => {
        e.preventDefault()
        setHover(true)
      }}
      onDragLeave={(e) => {
        e.preventDefault()
        setHover(false)
      }}
      onDrop={(e) => {
        e.preventDefault()
        setHover(false)
        const maybePath = (e.dataTransfer.files?.[0] as unknown as { path?: string })?.path
        if (maybePath) setFolderPath(maybePath)
      }}
    >
      <div className="flex items-start justify-between gap-6">
        <div>
          <div className="text-sm font-semibold text-white">Import Reddit Export</div>
          <div className="mt-1 text-sm text-white/60">
            Drag & drop your export folder, or choose it manually.
          </div>

          <div className="mt-3 rounded-lg border border-white/10 bg-black/30 px-3 py-2">
            <div className="text-xs text-white/50">Selected folder</div>
            <div className="mt-1 truncate text-sm text-white">
              {folderPath ?? 'None'}
            </div>
          </div>

          {progressText && (
            <div className="mt-3 text-xs text-white/70">Progress: {progressText}</div>
          )}
          {error && <div className="mt-3 text-xs text-red-300">{error}</div>}
        </div>

        <div className="flex flex-col gap-2">
          <button
            className="rounded-lg bg-white/10 px-3 py-2 text-sm text-white hover:bg-white/15 transition-colors"
            onClick={chooseFolder}
            disabled={busy}
          >
            Choose folder
          </button>
          <button
            className="rounded-lg bg-indigo-500/90 px-3 py-2 text-sm font-medium text-white hover:bg-indigo-500 transition-colors disabled:opacity-50"
            onClick={runImport}
            disabled={busy || !folderPath}
          >
            {busy ? 'Importing…' : 'Import'}
          </button>
        </div>
      </div>
    </div>
  )
}
