import { NavLink } from 'react-router-dom'

const linkBase =
  'flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors '

const linkInactive = 'text-white/70 hover:text-white hover:bg-white/5'
const linkActive = 'text-white bg-white/10'

export default function Sidebar() {
  return (
    <aside className="w-64 shrink-0 border-r border-white/10 bg-black/30 p-4">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-sm font-semibold text-white">Digital Twin</div>
          <div className="text-xs text-white/50">Local-first identity map</div>
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
