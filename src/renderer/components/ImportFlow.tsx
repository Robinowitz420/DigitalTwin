import { useEffect, useMemo, useState } from 'react'
import type { RedditDataset, RedditImportProgress } from '../../types/reddit.types'
import type { IdentitySourceCount, SocialCsvMapping } from '../../types/identity.types'

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
  const [training, setTraining] = useState(false)
  const [trainProgress, setTrainProgress] = useState<RedditImportProgress | null>(null)
  const [trainLog, setTrainLog] = useState<string[]>([])
  const [learnBusy, setLearnBusy] = useState(false)
  const [learnProgress, setLearnProgress] = useState<RedditImportProgress | null>(null)
  const [learnLog, setLearnLog] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [hasDataset, setHasDataset] = useState(false)
  const [hasVoiceProfile, setHasVoiceProfile] = useState(false)
  const [showImportTools, setShowImportTools] = useState(false)
  const [gmailFilePath, setGmailFilePath] = useState<string | null>(null)
  const [socialCsvFilePath, setSocialCsvFilePath] = useState<string | null>(null)
  const [takeoutFolderPath, setTakeoutFolderPath] = useState<string | null>(null)
  const [igMessagesFolderPath, setIgMessagesFolderPath] = useState<string | null>(null)
  const [igCommentsFolderPath, setIgCommentsFolderPath] = useState<string | null>(null)
  const [llmChatFolderPath, setLlmChatFolderPath] = useState<string | null>(null)
  const [portalBusy, setPortalBusy] = useState<null | 'gmail' | 'social_csv' | 'takeout_all' | 'ig_messages' | 'ig_comments' | 'llm_chat'>(null)
  const [sourceCounts, setSourceCounts] = useState<Record<string, number>>({})
  const [guide, setGuide] = useState<'reddit' | 'gmail' | 'social' | 'takeout' | 'sms'>('gmail')
  const [socialHeaders, setSocialHeaders] = useState<string[]>([])
  const [socialSampleRows, setSocialSampleRows] = useState<Array<Record<string, string>>>([])
  const [socialMapping, setSocialMapping] = useState<SocialCsvMapping>({
    textColumn: '',
  })
  const [hasIdentityProfile, setHasIdentityProfile] = useState(false)
  const [voiceProfileData, setVoiceProfileData] = useState<{ 
    trainedAt?: string
    trainingSources?: { redditComments: number; redditPosts: number; smsMessages: number }
  } | null>(null)

  useEffect(() => {
    const off = window.digitalTwin?.onRedditImportProgress((p) => setProgress(p))
    return () => off?.()
  }, [])

  useEffect(() => {
    const off = window.digitalTwin?.onIdentityLearnProgress?.((p) => {
      setLearnProgress(p)
      const msg = typeof p.message === 'string' ? p.message : null
      if (msg) {
        setLearnLog((lines) => {
          const next = [...lines, msg]
          return next.length > 200 ? next.slice(next.length - 200) : next
        })
      }
    })
    return () => off?.()
  }, [])

  useEffect(() => {
    const off = window.digitalTwin?.onVoiceTrainProgress?.((p) => {
      setTrainProgress(p)
      const msg = typeof p.message === 'string' ? p.message : null
      if (msg) {
        setTrainLog((lines) => {
          const next = [...lines, msg]
          return next.length > 200 ? next.slice(next.length - 200) : next
        })
      }
    })
    return () => off?.()
  }, [])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const [latest, voiceProfile] = await Promise.all([
          window.digitalTwin.loadLatestRedditDataset(),
          window.digitalTwin.loadVoiceProfile(),
        ])
        if (cancelled) return
        if (latest) {
          setHasDataset(true)
          onImported(latest)
        }
        setHasVoiceProfile(voiceProfile != null)
        if (voiceProfile && typeof voiceProfile === 'object') {
          const vp = voiceProfile as { trainedAt?: string; trainingSources?: { redditComments: number; redditPosts: number; smsMessages: number } }
          setVoiceProfileData({
            trainedAt: vp.trainedAt,
            trainingSources: vp.trainingSources,
          })
        }
        const identityProfile = await window.digitalTwin.loadIdentityProfile()
        if (!cancelled) setHasIdentityProfile(identityProfile != null)
        const counts = await window.digitalTwin.loadIdentitySourceCounts()
        if (!cancelled) {
          const map: Record<string, number> = {}
          for (const c of counts) map[c.source] = c.count
          setSourceCounts(map)
        }
      } catch {
        // ignore startup state checks
      }
    })()
    return () => {
      cancelled = true
    }
  }, [onImported])

  async function refreshSourceCounts() {
    try {
      const counts = await window.digitalTwin.loadIdentitySourceCounts()
      const map: Record<string, number> = {}
      for (const c of counts as IdentitySourceCount[]) map[c.source] = c.count
      setSourceCounts(map)
    } catch {
      // ignore
    }
  }

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

  async function runTraining() {
    setError(null)
    setTraining(true)
    setTrainProgress({ stage: 'training', percent: 0, message: 'Starting…' })
    setTrainLog([])
    try {
      await window.digitalTwin.trainVoiceProfile()
      setHasVoiceProfile(true)
      // Reload voice profile to get training metadata
      const vp = await window.digitalTwin.loadVoiceProfile()
      if (vp && typeof vp === 'object') {
        const vpData = vp as { trainedAt?: string; trainingSources?: { redditComments: number; redditPosts: number; smsMessages: number } }
        setVoiceProfileData({
          trainedAt: vpData.trainedAt,
          trainingSources: vpData.trainingSources,
        })
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Training failed')
    } finally {
      setTraining(false)
    }
  }

  async function runIdentityLearning() {
    setError(null)
    setLearnBusy(true)
    setLearnProgress({ stage: 'analyzing', percent: 0, message: 'Starting…' })
    setLearnLog([])
    try {
      await window.digitalTwin.learnIdentityProfile()
      setHasIdentityProfile(true)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Identity learning failed')
    } finally {
      setLearnBusy(false)
    }
  }

  async function runImport() {
    if (!folderPath) return
    setBusy(true)
    setError(null)
    try {
      const dataset = await window.digitalTwin.importRedditExportFromFolder(folderPath)
      setHasDataset(true)
      onImported(dataset)
      if (!hasVoiceProfile) {
        await runTraining()
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Import failed')
    } finally {
      setBusy(false)
    }
  }

  async function chooseGmailFile() {
    setError(null)
    const selected = await window.digitalTwin.selectGmailExportFile()
    setGmailFilePath(selected)
  }

  async function chooseSocialCsvFile() {
    setError(null)
    const selected = await window.digitalTwin.selectSocialCsvFile()
    setSocialCsvFilePath(selected)
    setSocialHeaders([])
    setSocialSampleRows([])
    setSocialMapping({ textColumn: '' })
    if (!selected) return
    try {
      const preview = await window.digitalTwin.previewSocialCsvFile(selected)
      setSocialHeaders(preview.headers)
      setSocialSampleRows(preview.sampleRows)
      const norm = (s: string) => s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '')
      const headers = preview.headers
      const headerNorm = new Map<string, string>()
      for (const h of headers) headerNorm.set(h, norm(h))
      const sampleRows = preview.sampleRows

      const valuesFor = (header: string) => sampleRows.map((r) => (r?.[header] ?? '').toString())
      const nonEmptyValuesFor = (header: string) => valuesFor(header).map((v) => v.trim()).filter(Boolean)

      const parseDateScore = (header: string) => {
        const vals = nonEmptyValuesFor(header)
        if (vals.length === 0) return 0
        let ok = 0
        for (const v of vals) {
          const d = new Date(v)
          if (Number.isFinite(d.getTime())) ok++
        }
        return ok / vals.length
      }

      const avgLenScore = (header: string) => {
        const vals = nonEmptyValuesFor(header)
        if (vals.length === 0) return 0
        const total = vals.reduce((acc, v) => acc + v.length, 0)
        return total / vals.length
      }

      const isMostlyNumeric = (header: string) => {
        const vals = nonEmptyValuesFor(header)
        if (vals.length === 0) return false
        let ok = 0
        for (const v of vals) {
          const t = v.replace(/\s+/g, '')
          if (t && /^[0-9]+$/.test(t)) ok++
        }
        return ok / vals.length >= 0.7
      }

      const hasUrlLike = (header: string) => {
        const vals = nonEmptyValuesFor(header)
        if (vals.length === 0) return false
        return vals.some((v) => /^https?:\/\//i.test(v) || /^www\./i.test(v))
      }

      const bestHeaderBy = (scoreFn: (h: string) => number, allow: (h: string) => boolean = () => true) => {
        let best = ''
        let bestScore = -Infinity
        for (const h of headers) {
          if (!allow(h)) continue
          const score = scoreFn(h)
          if (score > bestScore) {
            bestScore = score
            best = h
          }
        }
        return best
      }

      const pickByHeaderHints = (hints: string[]) => {
        const hintNorms = hints.map(norm)
        const scored = headers
          .map((h) => {
            const hn = headerNorm.get(h) ?? ''
            let score = 0
            for (const k of hintNorms) {
              if (!k) continue
              if (hn === k) score += 6
              if (hn.includes(k)) score += 4
              if (k.includes(hn)) score += 1
            }
            return { h, score }
          })
          .sort((a, b) => b.score - a.score)
        return scored[0]?.score ? scored[0].h : ''
      }

      const textHint = pickByHeaderHints(['text', 'message', 'body', 'content', 'caption', 'post', 'comment', 'title', 'msg'])
      const dateHint = pickByHeaderHints(['created_at', 'createdat', 'timestamp', 'time', 'date', 'sent_at', 'sentat', 'datetime'])
      const authorHint = pickByHeaderHints(['author', 'user', 'from', 'sender', 'username', 'handle', 'name'])
      const recipientHint = pickByHeaderHints(['to', 'recipient', 'target', 'receiver', 'thread', 'contact'])
      const channelHint = pickByHeaderHints(['platform', 'source', 'channel', 'app', 'subreddit', 'service'])
      const idHint = pickByHeaderHints(['id', 'message_id', 'msg_id', 'post_id', 'comment_id', 'uuid', 'guid'])

      const textColumn =
        textHint ||
        bestHeaderBy(
          (h) => {
            const avg = avgLenScore(h)
            const dateScore = parseDateScore(h)
            const bad = (isMostlyNumeric(h) ? 25 : 0) + (dateScore >= 0.7 ? 25 : 0) + (hasUrlLike(h) ? 10 : 0)
            return avg - bad
          },
          (h) => nonEmptyValuesFor(h).length > 0,
        )

      const dateColumn =
        dateHint ||
        bestHeaderBy(
          (h) => {
            const s = parseDateScore(h)
            const hn = headerNorm.get(h) ?? ''
            const headerBonus = /date|time|timestamp|created|sent/.test(hn) ? 0.25 : 0
            return s + headerBonus
          },
          (h) => nonEmptyValuesFor(h).length > 0,
        )

      const idColumn = idHint || bestHeaderBy((h) => (isMostlyNumeric(h) ? 1 : 0) + (/(^|_)(id|uuid|guid)($|_)/.test(headerNorm.get(h) ?? '') ? 0.5 : 0))

      setSocialMapping({
        textColumn: textColumn || '',
        dateColumn: dateColumn && parseDateScore(dateColumn) >= 0.6 ? dateColumn : undefined,
        authorColumn: authorHint || undefined,
        recipientColumn: recipientHint || undefined,
        channelColumn: channelHint || undefined,
        idColumn: idColumn || undefined,
      })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to parse CSV preview')
    }
  }

  async function runGmailImport() {
    if (!gmailFilePath) return
    setPortalBusy('gmail')
    setError(null)
    try {
      await window.digitalTwin.importGmailExportFromFile(gmailFilePath)
      await refreshSourceCounts()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Gmail import failed')
    } finally {
      setPortalBusy(null)
    }
  }

  async function runSocialCsvImport() {
    if (!socialCsvFilePath) return
    if (!socialMapping.textColumn) {
      setError('Please map the CSV text/content column before importing.')
      return
    }
    setPortalBusy('social_csv')
    setError(null)
    try {
      await window.digitalTwin.importSocialCsvWithMapping(socialCsvFilePath, socialMapping)
      await refreshSourceCounts()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Social CSV import failed')
    } finally {
      setPortalBusy(null)
    }
  }

  async function chooseTakeoutFolder() {
    setError(null)
    const selected = await window.digitalTwin.selectGoogleTakeoutFolder()
    setTakeoutFolderPath(selected)
  }

  async function runTakeoutImport() {
    if (!takeoutFolderPath) return
    setPortalBusy('takeout_all')
    setError(null)
    try {
      await window.digitalTwin.importGoogleTakeoutFromFolder(takeoutFolderPath)
      await refreshSourceCounts()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Google Takeout import failed')
    } finally {
      setPortalBusy(null)
    }
  }

  async function chooseIgMessagesFolder() {
    setError(null)
    const selected = await window.digitalTwin.selectInstagramMessagesFolder()
    setIgMessagesFolderPath(selected)
  }

  async function chooseIgCommentsFolder() {
    setError(null)
    const selected = await window.digitalTwin.selectInstagramCommentsFolder()
    setIgCommentsFolderPath(selected)
  }

  async function runIgMessagesImport() {
    if (!igMessagesFolderPath) return
    setPortalBusy('ig_messages')
    setError(null)
    try {
      await window.digitalTwin.importInstagramMessagesFromFolder(igMessagesFolderPath)
      await refreshSourceCounts()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Instagram messages import failed')
    } finally {
      setPortalBusy(null)
    }
  }

  async function runIgCommentsImport() {
    if (!igCommentsFolderPath) return
    setPortalBusy('ig_comments')
    setError(null)
    try {
      await window.digitalTwin.importInstagramCommentsFromFolder(igCommentsFolderPath)
      await refreshSourceCounts()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Instagram comments import failed')
    } finally {
      setPortalBusy(null)
    }
  }

  async function chooseLLMChatFolder() {
    setError(null)
    const selected = await window.digitalTwin.selectLLMChatFolder()
    setLlmChatFolderPath(selected)
  }

  async function runLLMChatImport() {
    if (!llmChatFolderPath) return
    setPortalBusy('llm_chat')
    setError(null)
    try {
      await window.digitalTwin.importLLMChatFolder(llmChatFolderPath)
      await refreshSourceCounts()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'LLM chat import failed')
    } finally {
      setPortalBusy(null)
    }
  }

  return (
    <div
      className={`mt-5 rounded-lg border border-dashed p-5 text-sm transition-colors ${
        hover
          ? 'border-indigo-400/60 bg-indigo-500/10'
          : 'border-white/15 bg-white/0'
      }`}
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
      <div className="rounded-xl border border-white/10 bg-white/5 p-6">
        <h2 className="text-lg font-semibold text-white">Import Reddit Export</h2>
        <p className="mt-2 text-sm text-white/70">
          {hasDataset
            ? 'Local Reddit data is already saved. You only need to re-import if you want to refresh it.'
            : 'Drag & drop your export folder, or choose it manually.'}
        </p>

        {(hasDataset || hasVoiceProfile) && (
          <div className="mt-4 rounded-lg border border-emerald-400/20 bg-emerald-500/10 p-3 text-xs text-emerald-100/90">
            <div className="font-medium text-white mb-2">Data Status</div>
            <div className="grid gap-1">
              <div className="flex justify-between">
                <span>Reddit dataset:</span>
                <span className="text-white">{hasDataset ? 'imported' : 'missing'}</span>
              </div>
              <div className="flex justify-between">
                <span>Voice profile:</span>
                <span className="text-white">{hasVoiceProfile ? 'trained' : 'not built'}</span>
              </div>
              {voiceProfileData?.trainedAt && (
                <div className="flex justify-between text-white/60">
                  <span>Last trained:</span>
                  <span>{new Date(voiceProfileData.trainedAt).toLocaleDateString()}</span>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Data Assimilation Visualization */}
        {(Object.keys(sourceCounts).length > 0 || voiceProfileData) && (
          <div className="mt-4 rounded-lg border border-white/10 bg-black/20 p-3">
            <div className="text-xs font-medium text-white/80 mb-2">Data Assimilation</div>
            
            {/* Imported Data */}
            <div className="mb-3">
              <div className="text-[10px] text-white/50 uppercase tracking-wide mb-1">Imported to Timeline</div>
              <div className="flex flex-wrap gap-1">
                {Object.entries(sourceCounts).map(([source, count]) => (
                  <span 
                    key={source} 
                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-white/10 text-[11px] text-white/80"
                  >
                    <span className="text-white/50">{source.replace('_', ' ')}:</span>
                    <span className="text-white font-medium">{count.toLocaleString()}</span>
                  </span>
                ))}
              </div>
            </div>

            {/* Trained into Voice */}
            {voiceProfileData?.trainingSources && (
              <div>
                <div className="text-[10px] text-white/50 uppercase tracking-wide mb-1">Trained into Voice</div>
                <div className="flex flex-wrap gap-1">
                  {voiceProfileData.trainingSources.redditComments > 0 && (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-purple-500/20 text-[11px] text-purple-200">
                      <span className="text-purple-300/70">Reddit comments:</span>
                      <span className="font-medium">{voiceProfileData.trainingSources.redditComments.toLocaleString()}</span>
                    </span>
                  )}
                  {voiceProfileData.trainingSources.redditPosts > 0 && (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-purple-500/20 text-[11px] text-purple-200">
                      <span className="text-purple-300/70">Reddit posts:</span>
                      <span className="font-medium">{voiceProfileData.trainingSources.redditPosts.toLocaleString()}</span>
                    </span>
                  )}
                  {voiceProfileData.trainingSources.smsMessages > 0 && (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-blue-500/20 text-[11px] text-blue-200">
                      <span className="text-blue-300/70">SMS messages:</span>
                      <span className="font-medium">{voiceProfileData.trainingSources.smsMessages.toLocaleString()}</span>
                    </span>
                  )}
                </div>
                {voiceProfileData.trainingSources.smsMessages === 0 && sourceCounts.sms > 0 && (
                  <div className="mt-2 text-[10px] text-amber-300/80">
                    ⚠️ SMS imported but not trained — rebuild voice profile to include
                  </div>
                )}
              </div>
            )}

            {/* Not trained warning */}
            {!voiceProfileData?.trainingSources && Object.keys(sourceCounts).length > 0 && (
              <div className="text-[10px] text-amber-300/80">
                ⚠️ Data imported but voice not trained — click "Build a copy of me" to assimilate
              </div>
            )}
          </div>
        )}

        <div className="mt-4 rounded-lg border border-white/10 bg-black/20 p-3">
          <div className="text-xs font-medium text-white/80">Quick start</div>
          <div className="mt-1 text-xs text-white/60">
            1) Export your Reddit data.
            2) Import the folder here.
            3) Explore Who Am I, Time Machine, and Write Like Me.
          </div>

          {progressText && (
            <div className="mt-3">
              <div className="text-xs text-white/70">Progress: {progressText}</div>
              <div className="mt-2 h-2 w-full overflow-hidden rounded bg-white/10">
                <div
                  className="h-full bg-indigo-500/80 transition-[width] duration-300"
                  style={{ width: `${Math.max(0, Math.min(100, progress?.percent ?? 0))}%` }}
                />
              </div>
            </div>
          )}
          {error && <div className="mt-3 text-xs text-red-300">{error}</div>}
        </div>

        <div className="mt-4">
          {!hasDataset && (
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
          )}
          {hasDataset && (
            <button
              className="rounded-lg bg-white/10 px-3 py-2 text-sm text-white hover:bg-white/15 transition-colors"
              onClick={() => setShowImportTools((v) => !v)}
              disabled={busy || training}
            >
              {showImportTools ? 'Hide re-import tools' : 'Re-import from a new folder'}
            </button>
          )}
          {hasDataset && showImportTools && (
            <div className="mt-2 flex flex-col gap-2">
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
                {busy ? 'Importing…' : 'Import and rebuild profile'}
              </button>
            </div>
          )}
        </div>

        <div className="mt-6 rounded-xl border border-white/10 bg-black/20 p-4">
          <div className="text-sm font-medium text-white">Build a Copy of Me</div>
          <div className="mt-1 text-xs text-white/60">
            This runs a deep LLM training pass over your imported Reddit comments + posts.
          </div>
          <div className="mt-1 text-xs text-white/50">
            This is stored locally and persists across app restarts.
          </div>

          <div className="mt-3 flex items-center gap-2">
            <button
              className="rounded-lg bg-purple-500/90 px-3 py-2 text-sm font-medium text-white hover:bg-purple-500 transition-colors disabled:opacity-50"
              onClick={runTraining}
              disabled={training || busy || !hasDataset}
            >
              {training ? 'Building…' : hasVoiceProfile ? 'Rebuild my copy' : 'Build a copy of me'}
            </button>
            {trainProgress?.message && <div className="text-xs text-white/60 truncate">{trainProgress.message}</div>}
          </div>

          <div className="mt-3 text-xs text-white/50">
            Uses all available imported comments and posts for maximum fidelity.
          </div>

          {trainProgress && (
            <div className="mt-3">
              <div className="text-xs text-white/70">
                Training: {formatPercent(trainProgress.percent)}
                {trainProgress.message ? ` — ${trainProgress.message}` : ''}
              </div>
              <div className="mt-2 h-2 w-full overflow-hidden rounded bg-white/10">
                <div
                  className="h-full bg-purple-500/80 transition-[width] duration-300"
                  style={{ width: `${Math.max(0, Math.min(100, trainProgress?.percent ?? 0))}%` }}
                />
              </div>
            </div>
          )}

          {trainLog.length > 0 && (
            <div className="mt-3 max-h-40 overflow-auto rounded-lg border border-white/10 bg-black/30 p-2 text-[11px] text-white/70">
              {trainLog.map((line, idx) => (
                <div key={idx} className="whitespace-pre-wrap">{line}</div>
              ))}
            </div>
          )}
        </div>

        <div className="mt-6 rounded-xl border border-white/10 bg-black/20 p-4">
          <div className="text-sm font-medium text-white">Learn Who I Am</div>
          <div className="mt-1 text-xs text-white/60">
            Runs a separate deep identity analysis over your upvotes, likes, comments, and connected portal history.
          </div>
          <div className="mt-1 text-xs text-white/50">
            This can take a really long time depending on your data size.
          </div>

          <div className="mt-3 flex items-center gap-2">
            <button
              className="rounded-lg bg-emerald-500/90 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-500 transition-colors disabled:opacity-50"
              onClick={runIdentityLearning}
              disabled={learnBusy || busy || training || (!hasDataset && Object.keys(sourceCounts).length === 0)}
            >
              {learnBusy ? 'Learning…' : hasIdentityProfile ? 'Re-learn who I am' : 'Learn Who I Am'}
            </button>
            {learnProgress?.message && <div className="text-xs text-white/60 truncate">{learnProgress.message}</div>}
          </div>

          {learnProgress && (
            <div className="mt-3">
              <div className="text-xs text-white/70">
                Learning: {formatPercent(learnProgress.percent)}
                {learnProgress.message ? ` — ${learnProgress.message}` : ''}
              </div>
              <div className="mt-2 h-2 w-full overflow-hidden rounded bg-white/10">
                <div
                  className="h-full bg-emerald-500/80 transition-[width] duration-300"
                  style={{ width: `${Math.max(0, Math.min(100, learnProgress?.percent ?? 0))}%` }}
                />
              </div>
            </div>
          )}

          {learnLog.length > 0 && (
            <div className="mt-3 max-h-40 overflow-auto rounded-lg border border-white/10 bg-black/30 p-2 text-[11px] text-white/70">
              {learnLog.map((line, idx) => (
                <div key={idx} className="whitespace-pre-wrap">{line}</div>
              ))}
            </div>
          )}
        </div>

        <div className="mt-6 rounded-xl border border-white/10 bg-black/20 p-4">
          <div className="text-sm font-medium text-white">Import Assistant</div>
          <div className="mt-1 text-xs text-white/60">
            Follow these steps exactly while importing.
          </div>

          <div className="mt-3 flex flex-wrap gap-2">
            <button
              className={`rounded-lg px-2 py-1 text-xs transition-colors ${guide === 'reddit' ? 'bg-indigo-500/90 text-white' : 'bg-white/10 text-white/80 hover:bg-white/15'}`}
              onClick={() => setGuide('reddit')}
            >
              Reddit
            </button>
            <button
              className={`rounded-lg px-2 py-1 text-xs transition-colors ${guide === 'gmail' ? 'bg-indigo-500/90 text-white' : 'bg-white/10 text-white/80 hover:bg-white/15'}`}
              onClick={() => setGuide('gmail')}
            >
              Gmail
            </button>
            <button
              className={`rounded-lg px-2 py-1 text-xs transition-colors ${guide === 'social' ? 'bg-indigo-500/90 text-white' : 'bg-white/10 text-white/80 hover:bg-white/15'}`}
              onClick={() => setGuide('social')}
            >
              Social CSV
            </button>
            <button
              className={`rounded-lg px-2 py-1 text-xs transition-colors ${guide === 'takeout' ? 'bg-indigo-500/90 text-white' : 'bg-white/10 text-white/80 hover:bg-white/15'}`}
              onClick={() => setGuide('takeout')}
            >
              Takeout Portals
            </button>
            <button
              className={`rounded-lg px-2 py-1 text-xs transition-colors ${guide === 'sms' ? 'bg-indigo-500/90 text-white' : 'bg-white/10 text-white/80 hover:bg-white/15'}`}
              onClick={() => setGuide('sms')}
            >
              SMS/iMessage
            </button>
          </div>

          <div className="mt-3 rounded-lg border border-white/10 bg-black/30 p-3 text-xs text-white/75">
            {guide === 'reddit' && (
              <div className="space-y-1">
                <div>1. Export your Reddit data from Reddit account settings.</div>
                <div>2. Unzip it locally.</div>
                <div>3. Click <span className="text-white">Choose folder</span> in the Reddit section.</div>
                <div>4. Select the unzipped export folder.</div>
                <div>5. Click <span className="text-white">Import</span>.</div>
                <div>6. Click <span className="text-white">Build a copy of me</span> after import finishes.</div>
              </div>
            )}
            {guide === 'gmail' && (
              <div className="space-y-1">
                <div>1. Go to <span className="text-white">takeout.google.com</span>.</div>
                <div>2. Deselect all, enable only <span className="text-white">Mail</span>.</div>
                <div>3. Create and download export, then unzip locally.</div>
                <div>4. In Data Portals, click <span className="text-white">Choose Gmail JSON</span>.</div>
                <div>5. Pick the Gmail JSON file, then click <span className="text-white">Import Gmail</span>.</div>
                <div>6. Confirm imported record count increased.</div>
              </div>
            )}
            {guide === 'social' && (
              <div className="space-y-1">
                <div>1. Export your social platform data and unzip if needed.</div>
                <div>2. Find a CSV with a text column like: <span className="text-white">text/message/body/content/caption</span>.</div>
                <div>3. Optional columns: <span className="text-white">created_at, author, id, platform</span>.</div>
                <div>4. In Data Portals, click <span className="text-white">Choose CSV</span>.</div>
                <div>5. Click <span className="text-white">Import Social CSV</span>.</div>
                <div>6. Confirm imported record count increased.</div>
              </div>
            )}
            {guide === 'sms' && (
              <div className="space-y-1">
                <div>SMS/iMessage importer is next.</div>
                <div>For now, export to CSV/JSON from your backup tool, then import via <span className="text-white">Social CSV</span> if possible.</div>
                <div>Recommended fields: message text, timestamp, sender, recipient/thread.</div>
              </div>
            )}
            {guide === 'takeout' && (
              <div className="space-y-1">
                <div>1. Go to <span className="text-white">takeout.google.com</span> and export Chrome, Discover, Google Voice, and YouTube/YouTube Music.</div>
                <div>2. Download and unzip the archive locally (if split into multiple zips, unzip all into one parent folder).</div>
                <div>3. In Data Portals, click <span className="text-white">Choose Takeout folder</span>.</div>
                <div>4. Select the unzipped Takeout root folder.</div>
                <div>5. Click <span className="text-white">Import Takeout (All)</span> once.</div>
              </div>
            )}
          </div>
        </div>

        <div className="mt-6 rounded-xl border border-white/10 bg-black/20 p-4">
          <div className="text-sm font-medium text-white">Data Portals</div>
          <div className="mt-1 text-xs text-white/60">
            Import additional personal data sources into your local timeline.
          </div>

          <div className="mt-4 grid gap-3 md:grid-cols-2">
            <div className="rounded-lg border border-white/10 bg-black/30 p-3">
              <div className="flex items-center gap-2">
                <div className="text-sm text-white">Gmail (JSON)</div>
                {(sourceCounts.gmail ?? 0) > 0 && (
                  <span className="text-emerald-400 text-sm">✓</span>
                )}
              </div>
              <div className="mt-1 text-xs text-white/50">Imported records: {sourceCounts.gmail ?? 0}</div>
              <div className="mt-3 flex flex-col gap-2">
                <button
                  className="rounded-lg bg-white/10 px-3 py-2 text-sm text-white hover:bg-white/15 transition-colors"
                  onClick={chooseGmailFile}
                  disabled={portalBusy != null}
                >
                  Choose Gmail JSON
                </button>
                <button
                  className="rounded-lg bg-blue-500/90 px-3 py-2 text-sm font-medium text-white hover:bg-blue-500 transition-colors disabled:opacity-50"
                  onClick={runGmailImport}
                  disabled={!gmailFilePath || portalBusy != null}
                >
                  {portalBusy === 'gmail' ? 'Importing…' : 'Import Gmail'}
                </button>
              </div>
            </div>

            <div className="rounded-lg border border-white/10 bg-black/30 p-3">
              <div className="flex items-center gap-2">
                <div className="text-sm text-white">Social CSV</div>
                {(sourceCounts.social_csv ?? 0) > 0 && (
                  <span className="text-emerald-400 text-sm">✓</span>
                )}
              </div>
              <div className="mt-1 text-xs text-white/50">Imported records: {sourceCounts.social_csv ?? 0}</div>
              <div className="mt-3 flex flex-col gap-2">
                <button
                  className="rounded-lg bg-white/10 px-3 py-2 text-sm text-white hover:bg-white/15 transition-colors"
                  onClick={chooseSocialCsvFile}
                  disabled={portalBusy != null}
                >
                  Choose CSV
                </button>
                <button
                  className="rounded-lg bg-blue-500/90 px-3 py-2 text-sm font-medium text-white hover:bg-blue-500 transition-colors disabled:opacity-50"
                  onClick={runSocialCsvImport}
                  disabled={!socialCsvFilePath || portalBusy != null || !socialMapping.textColumn}
                >
                  {portalBusy === 'social_csv' ? 'Importing…' : 'Import Social CSV'}
                </button>
              </div>
              {socialHeaders.length > 0 && (
                <div className="mt-3 rounded border border-white/10 bg-black/20 p-2">
                  <div className="text-xs text-white/60">CSV Column Mapper</div>
                  <div className="mt-2 grid gap-2">
                    {[
                      ['textColumn', 'Text/Content (Required)'],
                      ['dateColumn', 'Date/Time'],
                      ['authorColumn', 'Author/Sender'],
                      ['recipientColumn', 'Recipient/Target'],
                      ['channelColumn', 'Channel/Platform'],
                      ['idColumn', 'External ID'],
                    ].map(([key, label]) => (
                      <label key={key} className="grid grid-cols-[150px_1fr] items-center gap-2 text-xs text-white/70">
                        <span>{label}</span>
                        <select
                          className="rounded border border-white/10 bg-black/40 px-2 py-1 text-xs text-white"
                          value={(socialMapping as Record<string, string | undefined>)[key] ?? ''}
                          onChange={(e) =>
                            setSocialMapping((prev) => ({
                              ...prev,
                              [key]: e.target.value || undefined,
                              ...(key === 'textColumn' && !e.target.value ? { textColumn: '' } : {}),
                            }))
                          }
                        >
                          <option value="">(none)</option>
                          {socialHeaders.map((h) => (
                            <option key={h} value={h}>
                              {h}
                            </option>
                          ))}
                        </select>
                      </label>
                    ))}
                  </div>
                  {socialSampleRows.length > 0 && (
                    <div className="mt-3 overflow-auto rounded border border-white/10">
                      <table className="min-w-full text-[11px]">
                        <thead className="bg-white/5 text-white/60">
                          <tr>
                            {socialHeaders.slice(0, 6).map((h) => (
                              <th key={h} className="px-2 py-1 text-left font-medium">
                                {h}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {socialSampleRows.map((row, idx) => (
                            <tr key={idx} className="border-t border-white/10 text-white/70">
                              {socialHeaders.slice(0, 6).map((h) => (
                                <td key={h} className="max-w-[180px] truncate px-2 py-1">
                                  {row[h] ?? ''}
                                </td>
                              ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )}
            </div>

            <div className="rounded-lg border border-white/10 bg-black/30 p-3">
              <div className="flex items-center gap-2">
                <div className="text-sm text-white">Google Takeout (All-in-one)</div>
                {((sourceCounts.chrome ?? 0) + (sourceCounts.discover ?? 0) + (sourceCounts.google_voice ?? 0) + (sourceCounts.youtube ?? 0)) > 0 && (
                  <span className="text-emerald-400 text-sm">✓</span>
                )}
              </div>
              <div className="mt-1 text-xs text-white/50">
                Imported records: Gmail {sourceCounts.gmail ?? 0} · Chrome {sourceCounts.chrome ?? 0} · Discover {sourceCounts.discover ?? 0} · Voice {sourceCounts.google_voice ?? 0} · YouTube {sourceCounts.youtube ?? 0}
              </div>
              <div className="mt-3 flex flex-col gap-2">
                <button
                  className="rounded-lg bg-white/10 px-3 py-2 text-sm text-white hover:bg-white/15 transition-colors"
                  onClick={chooseTakeoutFolder}
                  disabled={portalBusy != null}
                >
                  Choose Takeout folder
                </button>
                <button
                  className="rounded-lg bg-blue-500/90 px-3 py-2 text-sm font-medium text-white hover:bg-blue-500 transition-colors disabled:opacity-50"
                  onClick={runTakeoutImport}
                  disabled={!takeoutFolderPath || portalBusy != null}
                >
                  {portalBusy === 'takeout_all' ? 'Importing…' : 'Import Takeout (All)'}
                </button>
              </div>
            </div>

            <div className="rounded-lg border border-white/10 bg-black/30 p-3">
              <div className="flex items-center gap-2">
                <div className="text-sm text-white">Instagram Messages</div>
                {(sourceCounts.instagram ?? 0) > 0 && (
                  <span className="text-emerald-400 text-sm">✓</span>
                )}
              </div>
              <div className="mt-1 text-xs text-white/50">
                Imported records: {sourceCounts.instagram ?? 0}
              </div>
              <div className="mt-1 text-xs text-white/40">
                Folder: your_instagram_activity/messages/inbox
              </div>
              <div className="mt-3 flex flex-col gap-2">
                <button
                  className="rounded-lg bg-white/10 px-3 py-2 text-sm text-white hover:bg-white/15 transition-colors"
                  onClick={chooseIgMessagesFolder}
                  disabled={portalBusy != null}
                >
                  Choose Messages folder
                </button>
                <button
                  className="rounded-lg bg-pink-500/90 px-3 py-2 text-sm font-medium text-white hover:bg-pink-500 transition-colors disabled:opacity-50"
                  onClick={runIgMessagesImport}
                  disabled={!igMessagesFolderPath || portalBusy != null}
                >
                  {portalBusy === 'ig_messages' ? 'Importing…' : 'Import Instagram Messages'}
                </button>
              </div>
            </div>

            <div className="rounded-lg border border-white/10 bg-black/30 p-3">
              <div className="flex items-center gap-2">
                <div className="text-sm text-white">Instagram Comments</div>
                {(sourceCounts.instagram ?? 0) > 0 && (
                  <span className="text-emerald-400 text-sm">✓</span>
                )}
              </div>
              <div className="mt-1 text-xs text-white/50">
                Imported records: {sourceCounts.instagram ?? 0}
              </div>
              <div className="mt-1 text-xs text-white/40">
                Folder: your_instagram_activity/comments
              </div>
              <div className="mt-3 flex flex-col gap-2">
                <button
                  className="rounded-lg bg-white/10 px-3 py-2 text-sm text-white hover:bg-white/15 transition-colors"
                  onClick={chooseIgCommentsFolder}
                  disabled={portalBusy != null}
                >
                  Choose Comments folder
                </button>
                <button
                  className="rounded-lg bg-pink-500/90 px-3 py-2 text-sm font-medium text-white hover:bg-pink-500 transition-colors disabled:opacity-50"
                  onClick={runIgCommentsImport}
                  disabled={!igCommentsFolderPath || portalBusy != null}
                >
                  {portalBusy === 'ig_comments' ? 'Importing…' : 'Import Instagram Comments'}
                </button>
              </div>
            </div>

            <div className="rounded-lg border border-white/10 bg-black/30 p-3">
              <div className="flex items-center gap-2">
                <div className="text-sm text-white">LLM Chats (ChatGPT, Claude, etc.)</div>
                {(sourceCounts.llm_chat ?? 0) > 0 && (
                  <span className="text-emerald-400 text-sm">✓</span>
                )}
              </div>
              <div className="mt-1 text-xs text-white/50">
                Imported records: {sourceCounts.llm_chat ?? 0}
              </div>
              <div className="mt-1 text-xs text-white/40">
                Your prompts from ChatGPT, Claude, and other LLM conversations
              </div>
              <div className="mt-3 flex flex-col gap-2">
                <button
                  className="rounded-lg bg-white/10 px-3 py-2 text-sm text-white hover:bg-white/15 transition-colors"
                  onClick={chooseLLMChatFolder}
                  disabled={portalBusy != null}
                >
                  Choose LLM Export folder
                </button>
                <button
                  className="rounded-lg bg-violet-500/90 px-3 py-2 text-sm font-medium text-white hover:bg-violet-500 transition-colors disabled:opacity-50"
                  onClick={runLLMChatImport}
                  disabled={!llmChatFolderPath || portalBusy != null}
                >
                  {portalBusy === 'llm_chat' ? 'Importing…' : 'Import LLM Chats'}
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
