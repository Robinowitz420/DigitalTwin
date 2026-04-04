import { contextBridge, ipcRenderer } from 'electron'
import type { RedditDataset, RedditImportProgress, RedditSearchResult } from '../types/reddit.types.js'
import type { WriteAgentRequest, WriteAgentResult } from '../types/writeAgent.types.js'
import type {
  GoogleTakeoutImportResult,
  IdentityImportResult,
  IdentitySourceCount,
  IdentityTimeline,
  SocialCsvMapping,
  SocialCsvPreview,
} from '../types/identity.types.js'
import type { PerContactVoiceProfile } from '../analysis/voiceAnalyzer.js'

export type DigitalTwinApi = {
  selectRedditExportFolder: () => Promise<string | null>
  selectGmailExportFile: () => Promise<string | null>
  selectSocialCsvFile: () => Promise<string | null>
  selectChromeTakeoutFolder: () => Promise<string | null>
  selectDiscoverTakeoutFolder: () => Promise<string | null>
  selectGoogleVoiceTakeoutFolder: () => Promise<string | null>
  selectYouTubeTakeoutFolder: () => Promise<string | null>
  selectGoogleTakeoutFolder: () => Promise<string | null>
  selectInstagramMessagesFolder: () => Promise<string | null>
  selectInstagramCommentsFolder: () => Promise<string | null>
  selectLLMChatFolder: () => Promise<string | null>
  importRedditExportFromFolder: (folderPath: string) => Promise<RedditDataset>
  importGmailExportFromFile: (filePath: string) => Promise<IdentityImportResult>
  importSocialCsvFromFile: (filePath: string) => Promise<IdentityImportResult>
  importChromeTakeoutFromFolder: (folderPath: string) => Promise<IdentityImportResult>
  importDiscoverTakeoutFromFolder: (folderPath: string) => Promise<IdentityImportResult>
  importGoogleVoiceTakeoutFromFolder: (folderPath: string) => Promise<IdentityImportResult>
  importYouTubeTakeoutFromFolder: (folderPath: string) => Promise<IdentityImportResult>
  importGoogleTakeoutFromFolder: (folderPath: string) => Promise<GoogleTakeoutImportResult>
  importInstagramMessagesFromFolder: (folderPath: string) => Promise<IdentityImportResult>
  importInstagramCommentsFromFolder: (folderPath: string) => Promise<IdentityImportResult>
  importLLMChatFolder: (folderPath: string) => Promise<IdentityImportResult>
  previewSocialCsvFile: (filePath: string) => Promise<SocialCsvPreview>
  importSocialCsvWithMapping: (filePath: string, mapping: SocialCsvMapping) => Promise<IdentityImportResult>
  loadLatestRedditDataset: () => Promise<RedditDataset | null>
  clearLatestRedditDataset: () => Promise<boolean>
  loadIdentityTimeline: () => Promise<IdentityTimeline | null>
  loadIdentitySourceCounts: () => Promise<IdentitySourceCount[]>
  debugMemoryInspector: () => Promise<unknown>
  loadVoiceProfile: () => Promise<unknown | null>
  loadIdentityProfile: () => Promise<unknown | null>
  clearVoiceProfile: () => Promise<boolean>
  trainVoiceProfile: (resumeFromCheckpoint?: boolean) => Promise<unknown>
  pauseVoiceTraining: () => Promise<boolean>
  resumeVoiceTraining: () => Promise<boolean>
  abortVoiceTraining: () => Promise<boolean>
  hasVoiceTrainingCheckpoint: () => Promise<boolean>
  learnIdentityProfile: () => Promise<unknown>
  onVoiceTrainProgress: (cb: (progress: RedditImportProgress) => void) => () => void
  onIdentityLearnProgress: (cb: (progress: RedditImportProgress) => void) => () => void
  searchReddit: (
    query: string,
    opts?: {
      limit?: number
      include?: Array<'comments' | 'posts' | 'saved' | 'upvoted'>
    },
  ) => Promise<RedditSearchResult[]>
  openExternal: (url: string) => Promise<boolean>
  askGemini: (
    input: string | { question: string; timeWindowDays?: number; styleLine?: string; cutoffDateIso?: string },
  ) => Promise<{ answer: string; sources: RedditSearchResult[] }>
  chatClone: (input: {
    message: string
    lockedDateIso?: string
    history?: Array<{ role: 'user' | 'assistant'; text: string }>
  }) => Promise<{ answer: string; model: string }>
  checkGeminiHealth: () => Promise<{ ok: boolean; message?: string; models?: string[] }>
  writeLikeMeStream: (input: WriteAgentRequest, onChunk: (chunk: string, text: string) => void) => Promise<WriteAgentResult>
  onRedditImportProgress: (cb: (progress: RedditImportProgress) => void) => () => void
  getAllContacts: () => Promise<PerContactVoiceProfile[]>
  getAllKnowledge: () => Promise<import('./knowledgeStore.js').KnowledgeEntity[]>
  getKnowledgeByType: (type: string) => Promise<import('./knowledgeStore.js').KnowledgeEntity[]>
  deleteKnowledge: (entityId: string) => Promise<{ success: boolean }>
  clearKnowledge: () => Promise<{ success: boolean }>
}

const api: DigitalTwinApi = {
  selectRedditExportFolder: () => ipcRenderer.invoke('reddit:selectFolder'),
  selectGmailExportFile: () => ipcRenderer.invoke('data:selectGmailFile'),
  selectSocialCsvFile: () => ipcRenderer.invoke('data:selectSocialCsvFile'),
  selectChromeTakeoutFolder: () => ipcRenderer.invoke('data:selectChromeFolder'),
  selectDiscoverTakeoutFolder: () => ipcRenderer.invoke('data:selectDiscoverFolder'),
  selectGoogleVoiceTakeoutFolder: () => ipcRenderer.invoke('data:selectGoogleVoiceFolder'),
  selectYouTubeTakeoutFolder: () => ipcRenderer.invoke('data:selectYouTubeFolder'),
  selectGoogleTakeoutFolder: () => ipcRenderer.invoke('data:selectGoogleTakeoutFolder'),
  selectInstagramMessagesFolder: () => ipcRenderer.invoke('data:selectInstagramMessagesFolder'),
  selectInstagramCommentsFolder: () => ipcRenderer.invoke('data:selectInstagramCommentsFolder'),
  selectLLMChatFolder: () => ipcRenderer.invoke('data:selectLLMChatFolder'),
  importRedditExportFromFolder: (folderPath) => ipcRenderer.invoke('reddit:importFromFolder', folderPath),
  importGmailExportFromFile: (filePath) => ipcRenderer.invoke('data:importGmailFile', filePath),
  importSocialCsvFromFile: (filePath) => ipcRenderer.invoke('data:importSocialCsvFile', filePath),
  importChromeTakeoutFromFolder: (folderPath) => ipcRenderer.invoke('data:importChromeFolder', folderPath),
  importDiscoverTakeoutFromFolder: (folderPath) => ipcRenderer.invoke('data:importDiscoverFolder', folderPath),
  importGoogleVoiceTakeoutFromFolder: (folderPath) => ipcRenderer.invoke('data:importGoogleVoiceFolder', folderPath),
  importYouTubeTakeoutFromFolder: (folderPath) => ipcRenderer.invoke('data:importYouTubeFolder', folderPath),
  importGoogleTakeoutFromFolder: (folderPath) => ipcRenderer.invoke('data:importGoogleTakeoutFolder', folderPath),
  importInstagramMessagesFromFolder: (folderPath) => ipcRenderer.invoke('data:importInstagramMessagesFolder', folderPath),
  importInstagramCommentsFromFolder: (folderPath) => ipcRenderer.invoke('data:importInstagramCommentsFolder', folderPath),
  importLLMChatFolder: (folderPath) => ipcRenderer.invoke('data:importLLMChatFolder', folderPath),
  previewSocialCsvFile: (filePath) => ipcRenderer.invoke('data:previewSocialCsvFile', filePath),
  importSocialCsvWithMapping: (filePath, mapping) => ipcRenderer.invoke('data:importSocialCsvFileWithMapping', filePath, mapping),
  loadLatestRedditDataset: () => ipcRenderer.invoke('reddit:loadLatest'),
  clearLatestRedditDataset: () => ipcRenderer.invoke('reddit:clearLatest'),
  loadIdentityTimeline: () => ipcRenderer.invoke('data:loadTimeline'),
  loadIdentitySourceCounts: () => ipcRenderer.invoke('data:sourceCounts'),
  debugMemoryInspector: () => ipcRenderer.invoke('data:debugMemoryInspector'),
  loadVoiceProfile: () => ipcRenderer.invoke('voice:loadProfile'),
  loadIdentityProfile: () => ipcRenderer.invoke('identity:loadProfile'),
  clearVoiceProfile: () => ipcRenderer.invoke('voice:clearProfile'),
  trainVoiceProfile: (resumeFromCheckpoint = false) => ipcRenderer.invoke('voice:trainProfile', resumeFromCheckpoint),
  pauseVoiceTraining: () => ipcRenderer.invoke('voice:pauseTraining'),
  resumeVoiceTraining: () => ipcRenderer.invoke('voice:resumeTraining'),
  abortVoiceTraining: () => ipcRenderer.invoke('voice:abortTraining'),
  hasVoiceTrainingCheckpoint: () => ipcRenderer.invoke('voice:hasCheckpoint'),
  learnIdentityProfile: () => ipcRenderer.invoke('identity:learnProfile'),
  onVoiceTrainProgress: (cb) => {
    const handler = (_event: Electron.IpcRendererEvent, progress: RedditImportProgress) => cb(progress)
    ipcRenderer.on('voice:trainProgress', handler)
    return () => ipcRenderer.removeListener('voice:trainProgress', handler)
  },
  onIdentityLearnProgress: (cb) => {
    const handler = (_event: Electron.IpcRendererEvent, progress: RedditImportProgress) => cb(progress)
    ipcRenderer.on('identity:learnProgress', handler)
    return () => ipcRenderer.removeListener('identity:learnProgress', handler)
  },
  searchReddit: (query, opts) => ipcRenderer.invoke('reddit:search', query, opts),
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  askGemini: (input) => ipcRenderer.invoke('twin:askGemini', input),
  chatClone: (input) => ipcRenderer.invoke('twin:chatClone', input),
  checkGeminiHealth: () => ipcRenderer.invoke('writeAgent:health'),
  writeLikeMeStream: async (input, onChunk) => {
    const requestId = `wa-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    return new Promise<WriteAgentResult>((resolve, reject) => {
      const onChunkEvent = (
        _event: Electron.IpcRendererEvent,
        payload: { requestId: string; chunk: string; text: string },
      ) => {
        if (payload.requestId !== requestId) return
        onChunk(payload.chunk, payload.text)
      }
      const onDoneEvent = (
        _event: Electron.IpcRendererEvent,
        payload: { requestId: string; text: string; model: string },
      ) => {
        if (payload.requestId !== requestId) return
        cleanup()
        resolve({ text: payload.text, model: payload.model })
      }
      const onErrorEvent = (
        _event: Electron.IpcRendererEvent,
        payload: { requestId: string; error: string },
      ) => {
        if (payload.requestId !== requestId) return
        cleanup()
        reject(new Error(payload.error || 'Write Like Me failed'))
      }

      const cleanup = () => {
        ipcRenderer.removeListener('writeAgent:chunk', onChunkEvent)
        ipcRenderer.removeListener('writeAgent:done', onDoneEvent)
        ipcRenderer.removeListener('writeAgent:error', onErrorEvent)
      }

      ipcRenderer.on('writeAgent:chunk', onChunkEvent)
      ipcRenderer.on('writeAgent:done', onDoneEvent)
      ipcRenderer.on('writeAgent:error', onErrorEvent)

      ipcRenderer
        .invoke('writeAgent:generate', { requestId, ...input })
        .catch((e: unknown) => {
          cleanup()
          reject(e instanceof Error ? e : new Error(String(e)))
        })
    })
  },
  onRedditImportProgress: (cb) => {
    const handler = (_event: Electron.IpcRendererEvent, progress: RedditImportProgress) => cb(progress)
    ipcRenderer.on('reddit:importProgress', handler)
    return () => ipcRenderer.removeListener('reddit:importProgress', handler)
  },
  getAllContacts: () => ipcRenderer.invoke('contact:getAll'),
  getAllKnowledge: () => ipcRenderer.invoke('knowledge:getAll'),
  getKnowledgeByType: (type: string) => ipcRenderer.invoke('knowledge:getByType', type),
  deleteKnowledge: (entityId: string) => ipcRenderer.invoke('knowledge:delete', entityId),
  clearKnowledge: () => ipcRenderer.invoke('knowledge:clear'),
}

contextBridge.exposeInMainWorld('digitalTwin', api)
