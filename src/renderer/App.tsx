import { Navigate, NavLink, Route, Routes } from 'react-router-dom'
import WhoAmI from './pages/WhoAmI'
import DigitalTwin from './pages/DigitalTwin'
import WriteLikeMe from './pages/WriteLikeMe.tsx'

export default function App() {
  const tabBase =
    'rounded-lg px-3 py-2 text-sm transition-colors '
  const tabInactive = 'text-white/70 hover:text-white hover:bg-white/5'
  const tabActive = 'text-white bg-white/10'

  return (
    <div className="min-h-screen bg-gradient-to-b from-[#070A12] via-[#070A12] to-[#0A1020] text-white">
      <div className="mx-auto flex min-h-screen w-full max-w-6xl flex-col p-6">
        <header className="flex items-center justify-between">
          <div>
            <div className="text-sm font-semibold text-white">Digital Twin</div>
            <div className="text-xs text-white/50">Local-first identity map</div>
          </div>

          <nav className="flex items-center gap-2 rounded-xl border border-white/10 bg-black/20 p-1">
            <NavLink
              to="/"
              end
              className={({ isActive }) => tabBase + (isActive ? tabActive : tabInactive)}
            >
              Who Am I
            </NavLink>
            <NavLink
              to="/time"
              className={({ isActive }) => tabBase + (isActive ? tabActive : tabInactive)}
            >
              Time Machine
            </NavLink>
            <NavLink
              to="/write"
              className={({ isActive }) => tabBase + (isActive ? tabActive : tabInactive)}
            >
              Write Like Me
            </NavLink>
          </nav>
        </header>

        <main className="mt-6 flex-1">
          <Routes>
            <Route path="/" element={<WhoAmI />} />
            <Route path="/time" element={<DigitalTwin />} />
            <Route path="/write" element={<WriteLikeMe />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </main>

        <footer className="mt-6 rounded-xl border border-white/10 bg-white/5 p-3">
          <div className="text-xs font-medium text-white/80">Privacy</div>
          <div className="mt-1 text-xs text-white/60">Your data stays on this machine.</div>
        </footer>
      </div>
    </div>
  )
}
