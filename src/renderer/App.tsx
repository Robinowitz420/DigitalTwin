import { Navigate, Route, Routes } from 'react-router-dom'
import Sidebar from './components/Sidebar'
import Archive from './pages/Archive'
import DigitalTwin from './pages/DigitalTwin'
import Export from './pages/Export'
import Recommendations from './pages/Recommendations'
import WhoAmI from './pages/WhoAmI'

export default function App() {
  return (
    <div className="min-h-screen bg-gradient-to-b from-[#070A12] via-[#070A12] to-[#0A1020] text-white">
      <div className="flex min-h-screen">
        <Sidebar />
        <main className="flex-1 p-6">
          <Routes>
            <Route path="/" element={<WhoAmI />} />
            <Route path="/twin" element={<DigitalTwin />} />
            <Route path="/recommendations" element={<Recommendations />} />
            <Route path="/archive" element={<Archive />} />
            <Route path="/export" element={<Export />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </main>
      </div>
    </div>
  )
}
