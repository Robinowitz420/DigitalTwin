import * as path from 'node:path'
import { writeFile } from 'node:fs/promises'
import { parseRedditExportFolder } from '../utils/redditParser.js'
import type { RedditDataset, RedditImportProgress } from '../types/reddit.types.js'

export async function importRedditExportFromFolder(
  folderPath: string,
  onProgress?: (p: RedditImportProgress) => void,
): Promise<RedditDataset> {
  onProgress?.({ stage: 'reading', percent: 5 })

  const dataset = await parseRedditExportFolder(folderPath, (p) => {
    onProgress?.(p)
  })

  onProgress?.({ stage: 'writing', percent: 95 })

  const outPath = path.join(folderPath, 'digital-twin.reddit.normalized.json')
  await writeFile(outPath, JSON.stringify(dataset, null, 2), 'utf8')

  onProgress?.({ stage: 'done', percent: 100, outputPath: outPath })

  return dataset
}
