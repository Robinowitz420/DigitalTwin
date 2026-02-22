import { contextBridge, ipcRenderer } from 'electron'
import type { RedditDataset, RedditImportProgress } from '../types/reddit.types.js'

export type DigitalTwinApi = {
  selectRedditExportFolder: () => Promise<string | null>
  importRedditExportFromFolder: (folderPath: string) => Promise<RedditDataset>
  onRedditImportProgress: (cb: (progress: RedditImportProgress) => void) => () => void
}

const api: DigitalTwinApi = {
  selectRedditExportFolder: () => ipcRenderer.invoke('reddit:selectFolder'),
  importRedditExportFromFolder: (folderPath) => ipcRenderer.invoke('reddit:importFromFolder', folderPath),
  onRedditImportProgress: (cb) => {
    const handler = (_event: Electron.IpcRendererEvent, progress: RedditImportProgress) => cb(progress)
    ipcRenderer.on('reddit:importProgress', handler)
    return () => ipcRenderer.removeListener('reddit:importProgress', handler)
  },
}

contextBridge.exposeInMainWorld('digitalTwin', api)
