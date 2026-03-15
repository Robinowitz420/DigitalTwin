import * as path from 'node:path'
import { readFile, writeFile, unlink } from 'node:fs/promises'
import { app } from 'electron'
import type { VoiceProfile } from '../analysis/voiceAnalyzer.js'

function getProfilePath() {
  return path.join(app.getPath('userData'), 'voice.profile.json')
}

export async function loadVoiceProfile(): Promise<VoiceProfile | null> {
  const p = getProfilePath()
  try {
    const raw = await readFile(p, 'utf8')
    return JSON.parse(raw) as VoiceProfile
  } catch {
    return null
  }
}

export async function saveVoiceProfile(profile: VoiceProfile): Promise<string> {
  const p = getProfilePath()
  await writeFile(p, JSON.stringify(profile, null, 2), 'utf8')
  return p
}

export async function clearVoiceProfile(): Promise<boolean> {
  const p = getProfilePath()
  try {
    await unlink(p)
    return true
  } catch {
    return false
  }
}
