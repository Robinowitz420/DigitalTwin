import { app, BrowserWindow, ipcMain, dialog } from 'electron'
import * as path from 'node:path'
import { importRedditExportFromFolder } from './dataProcessor.js'

const projectRoot = process.cwd()

const isDev = process.env.VITE_DEV_SERVER_URL != null

let mainWindow: BrowserWindow | null = null

function getPreloadPath() {
  return path.join(projectRoot, 'dist-electron', 'preload.js')
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    backgroundColor: '#0b0f19',
    title: 'Digital Twin',
    webPreferences: {
      preload: getPreloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
    show: false,
  })

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show()
  })

  if (isDev) {
    await mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL as string)
    mainWindow.webContents.openDevTools({ mode: 'detach' })
  } else {
    await mainWindow.loadFile(path.join(projectRoot, 'dist', 'index.html'))
  }
}

function registerIpcHandlers() {
  ipcMain.handle('reddit:selectFolder', async () => {
    if (!mainWindow) return null

    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Select your Reddit data export folder',
      properties: ['openDirectory'],
    })

    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  ipcMain.handle('reddit:importFromFolder', async (_event, folderPath: string) => {
    if (!mainWindow) throw new Error('Main window not ready')

    const dataset = await importRedditExportFromFolder(folderPath, (p) => {
      mainWindow?.webContents.send('reddit:importProgress', p)
    })

    return dataset
  })
}

app.whenReady().then(async () => {
  registerIpcHandlers()
  await createWindow()

  app.on('activate', async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      await createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
