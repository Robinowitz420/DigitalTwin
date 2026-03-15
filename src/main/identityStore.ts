import * as path from 'node:path'
import { app } from 'electron'
import { readFile, writeFile } from 'node:fs/promises'
import type { IdentityEvent, IdentitySource, IdentitySourceCount, IdentityTimeline } from '../types/identity.types.js'

function getTimelinePath() {
  return path.join(app.getPath('userData'), 'identity.timeline.json')
}

export async function loadIdentityTimeline(): Promise<IdentityTimeline | null> {
  try {
    const raw = await readFile(getTimelinePath(), 'utf8')
    const parsed = JSON.parse(raw) as IdentityTimeline
    if (!Array.isArray(parsed.events)) return null
    return parsed
  } catch {
    return null
  }
}

export async function saveIdentityTimeline(events: IdentityEvent[]): Promise<IdentityTimeline> {
  const timeline: IdentityTimeline = {
    source: 'identity_timeline',
    importedAt: new Date().toISOString(),
    events,
  }
  await writeFile(getTimelinePath(), JSON.stringify(timeline, null, 2), 'utf8')
  return timeline
}

function dedupeKey(e: IdentityEvent) {
  const textKey = (e.text ?? '').toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 180)
  const ext = e.externalId ?? ''
  const date = e.createdAt ?? ''
  return `${e.source}|${e.kind}|${ext}|${date}|${textKey}`
}

export async function upsertIdentityEvents(incoming: IdentityEvent[]) {
  const current = await loadIdentityTimeline()
  const existing = current?.events ?? []

  const seen = new Set(existing.map(dedupeKey))
  const toAdd: IdentityEvent[] = []
  for (const item of incoming) {
    const key = dedupeKey(item)
    if (seen.has(key)) continue
    seen.add(key)
    toAdd.push(item)
  }

  const merged = [...existing, ...toAdd].sort((a, b) => {
    const am = a.createdAt ? Date.parse(a.createdAt) : 0
    const bm = b.createdAt ? Date.parse(b.createdAt) : 0
    return bm - am
  })

  await saveIdentityTimeline(merged)
  return { imported: toAdd.length, totalAfterImport: merged.length }
}

export async function getIdentitySourceCounts(): Promise<IdentitySourceCount[]> {
  const timeline = await loadIdentityTimeline()
  const counts = new Map<IdentitySource, number>()
  for (const e of timeline?.events ?? []) {
    counts.set(e.source, (counts.get(e.source) ?? 0) + 1)
  }
  return Array.from(counts.entries()).map(([source, count]) => ({
    source,
    count,
  }))
}
