import * as path from 'node:path'
import { readFile, writeFile, unlink } from 'node:fs/promises'
import { app } from 'electron'
import type { VoiceTrainingCheckpoint } from '../types/voiceTraining.types.js'

function getCheckpointPath() {
  return path.join(app.getPath('userData'), 'voice_training_checkpoint.json')
}

export async function loadVoiceCheckpoint(): Promise<VoiceTrainingCheckpoint | null> {
  try {
    const raw = await readFile(getCheckpointPath(), 'utf8')
    const checkpoint = JSON.parse(raw) as VoiceTrainingCheckpoint
    // Only return if it's a valid in-progress or paused checkpoint
    if (checkpoint.status === 'in_progress' || checkpoint.status === 'paused') {
      return checkpoint
    }
    return null
  } catch {
    return null
  }
}

export async function saveVoiceCheckpoint(checkpoint: VoiceTrainingCheckpoint): Promise<void> {
  const p = getCheckpointPath()
  await writeFile(p, JSON.stringify(checkpoint, null, 2), 'utf8')
}

export async function clearVoiceCheckpoint(): Promise<void> {
  try {
    await unlink(getCheckpointPath())
  } catch {
    // ignore
  }
}

export function createInitialCheckpoint(totalChunks: number, datasetStats: VoiceTrainingCheckpoint['datasetStats']): VoiceTrainingCheckpoint {
  return {
    version: 1,
    startedAt: new Date().toISOString(),
    lastCheckpointAt: new Date().toISOString(),
    totalChunks,
    processedChunks: 0,
    chunkSummaries: [],
    skippedChunks: 0,
    status: 'in_progress',
    datasetStats,
  }
}
