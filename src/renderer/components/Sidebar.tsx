import { NavLink } from 'react-router-dom'
import { useEffect, useState } from 'react'

const linkBase =
  'flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors '

const linkInactive = 'text-white/70 hover:text-white hover:bg-white/5'
const linkActive = 'text-white bg-white/10'

export default function Sidebar() {
  const [hasDataset, setHasDataset] = useState(false)
  const [hasVoiceProfile, setHasVoiceProfile] = useState(false)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const [latest, profile] = await Promise.all([
          window.digitalTwin.loadLatestRedditDataset(),
          window.digitalTwin.loadVoiceProfile(),
        ])
        if (cancelled) return
        setHasDataset(latest != null)
        setHasVoiceProfile(profile != null)
      } catch {
        if (cancelled) return
        setHasDataset(false)
        setHasVoiceProfile(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const setupComplete = hasDataset && hasVoiceProfile

  return (
    <aside className="w-64 shrink-0 border-r border-white/10 bg-black/30 p-4">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-sm font-semibold text-white">Digital Twin</div>
          <div className="text-xs text-white/50">Local-first identity map</div>
          <div
            className={`mt-2 inline-flex items-center gap-2 rounded-full px-2 py-1 text-[11px] ${
              setupComplete
                ? 'border border-emerald-400/30 bg-emerald-500/15 text-emerald-100'
                : 'border border-amber-300/30 bg-amber-400/10 text-amber-100'
            }`}
          >
            <span className="font-medium">{setupComplete ? 'Setup complete' : 'Setup needed'}</span>
          </div>
          <div className="mt-1 text-[11px] text-white/50">
            Data: {hasDataset ? 'ready' : 'missing'} · Voice: {hasVoiceProfile ? 'ready' : 'missing'}
          </div>
        </div>
      </div>

      <nav className="mt-6 space-y-1">
        <NavLink
          to="/"
          end
          className={({ isActive }) =>
            linkBase + (isActive ? linkActive : linkInactive)
          }
        >
          Who Am I
        </NavLink>
        <NavLink
          to="/twin"
          className={({ isActive }) =>
            linkBase + (isActive ? linkActive : linkInactive)
          }
        >
          Digital Twin
        </NavLink>
        <NavLink
          to="/recommendations"
          className={({ isActive }) =>
            linkBase + (isActive ? linkActive : linkInactive)
          }
        >
          Recommendations
        </NavLink>
        <NavLink
          to="/archive"
          className={({ isActive }) =>
            linkBase + (isActive ? linkActive : linkInactive)
          }
        >
          Archive
        </NavLink>
        <NavLink
          to="/export"
          className={({ isActive }) =>
            linkBase + (isActive ? linkActive : linkInactive)
          }
        >
          Export
        </NavLink>
      </nav>

      <div className="mt-6 rounded-xl border border-white/10 bg-white/5 p-3">
        <div className="text-xs font-medium text-white/80">Privacy</div>
        <div className="mt-1 text-xs text-white/60">
          Your data stays on this machine.
        </div>
      </div>
    </aside>
  )
}
