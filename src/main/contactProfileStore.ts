import * as path from 'node:path'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { app } from 'electron'
import type { PerContactVoiceProfile } from '../analysis/voiceAnalyzer.js'

let cache: Map<string, PerContactVoiceProfile> | null = null

function getContactsDir(): string {
  return path.join(app.getPath('userData'), 'contact-profiles')
}

function getProfilePath(contactName: string): string {
  // Sanitize filename
  const safe = contactName.replace(/[^a-z0-9_-]/gi, '_').slice(0, 64)
  return path.join(getContactsDir(), `${safe}.json`)
}

export async function loadContactProfiles(): Promise<Map<string, PerContactVoiceProfile>> {
  if (cache) return cache
  
  cache = new Map()
  const dir = getContactsDir()
  
  try {
    const { readdir } = await import('node:fs/promises')
    const files = await readdir(dir)
    
    for (const file of files) {
      if (!file.endsWith('.json')) continue
      try {
        const raw = await readFile(path.join(dir, file), 'utf8')
        const profile = JSON.parse(raw) as PerContactVoiceProfile
        if (profile.contactName) {
          cache.set(profile.contactName, profile)
        }
      } catch {
        // ignore malformed files
      }
    }
  } catch {
    // directory doesn't exist yet
  }
  
  return cache
}

export async function saveContactProfile(profile: PerContactVoiceProfile): Promise<void> {
  const profiles = await loadContactProfiles()
  profiles.set(profile.contactName, profile)
  
  const dir = getContactsDir()
  await mkdir(dir, { recursive: true })
  
  const filePath = getProfilePath(profile.contactName)
  await writeFile(filePath, JSON.stringify(profile, null, 2), 'utf8')
}

export async function getContactProfile(contactName: string): Promise<PerContactVoiceProfile | null> {
  const profiles = await loadContactProfiles()
  return profiles.get(contactName) ?? null
}

export async function getAllContactProfiles(): Promise<PerContactVoiceProfile[]> {
  const profiles = await loadContactProfiles()
  return Array.from(profiles.values())
}

export function clearContactProfileCache(): void {
  cache = null
}
