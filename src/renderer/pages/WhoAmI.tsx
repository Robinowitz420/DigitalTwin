import Dashboard from '../components/Dashboard'
import FirstRunBanner from '../components/FirstRunBanner'

export default function WhoAmI() {
  return (
    <div className="space-y-4">
      <FirstRunBanner />
      <Dashboard />
    </div>
  )
}
