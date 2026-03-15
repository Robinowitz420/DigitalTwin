import * as path from 'node:path'
import { readFile, writeFile, unlink } from 'node:fs/promises'
import { app } from 'electron'
import type { IdentityLearningProfile } from '../types/identityLearning.types.js'

function getIdentityProfilePath() {
  return path.join(app.getPath('userData'), 'identity.profile.json')
}

export async function loadIdentityLearningProfile(): Promise<IdentityLearningProfile | null> {
  try {
    const raw = await readFile(getIdentityProfilePath(), 'utf8')
    return JSON.parse(raw) as IdentityLearningProfile
  } catch {
    return null
  }
}

export async function saveIdentityLearningProfile(profile: IdentityLearningProfile): Promise<string> {
  const p = getIdentityProfilePath()
  await writeFile(p, JSON.stringify(profile, null, 2), 'utf8')
  return p
}

export async function clearIdentityLearningProfile(): Promise<boolean> {
  try {
    await unlink(getIdentityProfilePath())
    return true
  } catch {
    return false
  }
}
