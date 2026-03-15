import { useMemo } from 'react'
import { useLocation } from 'react-router-dom'
import WriteAgent from '../components/WriteAgent'

export default function WriteLikeMePage() {
  const location = useLocation()
  const lockedDateIso = (location.state as { lockedDate?: string } | null)?.lockedDate ?? null
  const lockedDate = useMemo(() => {
    if (!lockedDateIso) return null
    const d = new Date(lockedDateIso)
    return Number.isFinite(d.getTime()) ? d : null
  }, [lockedDateIso])

  return <WriteAgent lockedDate={lockedDate} />
}
