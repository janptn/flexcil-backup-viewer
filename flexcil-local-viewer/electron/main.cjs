const { app, BrowserWindow, ipcMain, shell, clipboard } = require('electron')
const path = require('path')
const http = require('http')
const fs = require('fs')
const { spawn } = require('child_process')
const { autoUpdater } = require('electron-updater')

const HOST = '127.0.0.1'
const PORT = 41731
const APP_URL = `http://${HOST}:${PORT}`
const AUTO_OPEN_BROWSER = true
const HEALTH_TIMEOUT_MS = 30000
const HEALTH_INTERVAL_MS = 400

/** @type {import('child_process').ChildProcessWithoutNullStreams | null} */
let serverProcess = null
let mainWindow = null
let isShuttingDown = false
let didAutoOpen = false
let isUpdateDownloaded = false

function loadLocalWhatsNew() {
  const filePath = path.join(__dirname, 'whats-new.json')

  try {
    const raw = fs.readFileSync(filePath, 'utf8')
    const parsed = JSON.parse(raw)

    if (!parsed || typeof parsed !== 'object') {
      return null
    }

    const title = typeof parsed.title === 'string' && parsed.title.trim().length > 0
      ? parsed.title.trim()
      : 'What\'s new'
    const version = typeof parsed.version === 'string' ? parsed.version : app.getVersion()
    const items = Array.isArray(parsed.items)
      ? parsed.items.filter((item) => typeof item === 'string' && item.trim().length > 0)
      : []

    return {
      title,
      version,
      items,
    }
  } catch {
    return null
  }
}

function normalizeReleaseNotes(releaseNotes) {
  if (typeof releaseNotes === 'string' && releaseNotes.trim().length > 0) {
    return releaseNotes.trim()
  }

  if (!Array.isArray(releaseNotes)) {
    return ''
  }

  return releaseNotes
    .map((entry) => {
      if (typeof entry === 'string') {
        return entry
      }

      if (entry && typeof entry === 'object' && typeof entry.note === 'string') {
        return entry.note
      }

      return ''
    })
    .filter((entry) => entry.trim().length > 0)
    .join('\n\n')
    .trim()
}

function serverScriptPath() {
  return path.join(app.getAppPath(), 'launcher', 'server.cjs')
}

function resolveServerRuntimePaths() {
  const packagedServerPath = path.join(process.resourcesPath, 'launcher', 'server.cjs')
  if (fs.existsSync(packagedServerPath)) {
    return {
      scriptPath: packagedServerPath,
      workingDirectory: process.resourcesPath,
    }
  }

  const fallbackScriptPath = serverScriptPath()
  const appPath = app.getAppPath()
  const workingDirectory = fs.existsSync(appPath) && fs.statSync(appPath).isDirectory()
    ? appPath
    : path.dirname(appPath)

  return {
    scriptPath: fallbackScriptPath,
    workingDirectory,
  }
}

function createMainWindow() {
  const window = new BrowserWindow({
    title: 'Flexcil Local Viewer',
    width: 760,
    height: 640,
    minWidth: 680,
    minHeight: 560,
    resizable: true,
    center: true,
    autoHideMenuBar: true,
    backgroundColor: '#0f172a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  window.loadFile(path.join(__dirname, 'renderer', 'index.html'))
  return window
}

function checkUrlReachable(url) {
  return new Promise((resolve) => {
    const request = http.get(url, (res) => {
      res.resume()
      resolve(res.statusCode >= 200 && res.statusCode < 500)
    })

    request.setTimeout(1500, () => {
      request.destroy()
      resolve(false)
    })

    request.on('error', () => {
      resolve(false)
    })
  })
}

async function waitForServerReady(url, timeoutMs) {
  const startAt = Date.now()

  while (Date.now() - startAt < timeoutMs) {
    const reachable = await checkUrlReachable(url)
    if (reachable) {
      return true
    }

    await new Promise((resolve) => setTimeout(resolve, HEALTH_INTERVAL_MS))
  }

  return false
}

function sendStatusToRenderer(payload) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return
  }
  mainWindow.webContents.send('launcher:status', payload)
}

function sendUpdateToRenderer(payload) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return
  }
  mainWindow.webContents.send('launcher:update', payload)
}

function openInterface() {
  return shell.openExternal(APP_URL)
}

function configureAutoUpdater() {
  if (!app.isPackaged) {
    sendUpdateToRenderer({
      state: 'disabled',
      message: 'Auto update is available in installed builds.',
    })
    return
  }

  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('checking-for-update', () => {
    sendUpdateToRenderer({ state: 'checking', message: 'Checking for updates…' })
  })

  autoUpdater.on('update-available', (info) => {
    const releaseNotes = normalizeReleaseNotes(info.releaseNotes)
    sendUpdateToRenderer({
      state: 'available',
      message: `Update ${info.version} found. Downloading…`,
      version: info.version,
      releaseNotes,
    })
  })

  autoUpdater.on('download-progress', (progress) => {
    sendUpdateToRenderer({
      state: 'downloading',
      message: `Downloading update… ${Math.round(progress.percent)}%`,
      percent: progress.percent,
    })
  })

  autoUpdater.on('update-downloaded', (info) => {
    isUpdateDownloaded = true
    const releaseNotes = normalizeReleaseNotes(info.releaseNotes)
    sendUpdateToRenderer({
      state: 'downloaded',
      message: `Update ${info.version} ready. Click Install Update.`,
      version: info.version,
      canInstall: true,
      releaseNotes,
    })
  })

  autoUpdater.on('update-not-available', () => {
    sendUpdateToRenderer({ state: 'none', message: 'No updates available.' })
  })

  autoUpdater.on('error', (error) => {
    const message = error instanceof Error ? error.message : String(error)
    sendUpdateToRenderer({
      state: 'error',
      message: `Update check failed: ${message}`,
    })
  })
}

async function checkForLauncherUpdates() {
  if (!app.isPackaged) {
    sendUpdateToRenderer({
      state: 'disabled',
      message: 'Auto update is available in installed builds.',
    })
    return { ok: false, reason: 'not-packaged' }
  }

  try {
    await autoUpdater.checkForUpdates()
    return { ok: true }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    sendUpdateToRenderer({
      state: 'error',
      message: `Update check failed: ${message}`,
    })
    return { ok: false, reason: message }
  }
}

async function stopServer() {
  if (!serverProcess) {
    return
  }

  const processToStop = serverProcess
  serverProcess = null

  if (processToStop.killed) {
    return
  }

  await new Promise((resolve) => {
    const done = () => resolve()
    processToStop.once('exit', done)

    try {
      processToStop.kill('SIGTERM')
    } catch {
      resolve()
      return
    }

    setTimeout(() => {
      if (!processToStop.killed) {
        try {
          processToStop.kill('SIGKILL')
        } catch {
        }
      }
      resolve()
    }, 4000)
  })
}

function startServerProcess() {
  const { scriptPath, workingDirectory } = resolveServerRuntimePaths()
  let child

  try {
    child = spawn(process.execPath, [scriptPath, '--no-window'], {
      cwd: workingDirectory,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
      },
      windowsHide: true,
      stdio: 'pipe',
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    sendStatusToRenderer({
      state: 'error',
      message: `Failed to start server process: ${message}`,
      url: APP_URL,
    })
    return false
  }

  child.stdout.on('data', (chunk) => {
    const message = String(chunk).trim()
    if (message.length > 0) {
      sendStatusToRenderer({
        state: 'starting',
        message,
        url: APP_URL,
      })
    }
  })

  child.stderr.on('data', (chunk) => {
    const message = String(chunk).trim()
    if (message.length > 0) {
      sendStatusToRenderer({
        state: 'starting',
        message: `Server: ${message}`,
        url: APP_URL,
      })
    }
  })

  child.once('exit', (code) => {
    if (isShuttingDown) {
      return
    }

    sendStatusToRenderer({
      state: 'error',
      message: `Server process exited (${code ?? 'unknown'})`,
      url: APP_URL,
    })
  })

  serverProcess = child
  return true
}

async function bootstrap() {
  mainWindow = createMainWindow()
  configureAutoUpdater()

  sendStatusToRenderer({
    state: 'starting',
    message: 'Starting local server…',
    url: APP_URL,
  })

  const didStart = startServerProcess()
  if (!didStart) {
    return
  }
  const isReady = await waitForServerReady(APP_URL, HEALTH_TIMEOUT_MS)

  if (!isReady) {
    sendStatusToRenderer({
      state: 'error',
      message: 'Server did not become ready in time.',
      url: APP_URL,
    })
    return
  }

  sendStatusToRenderer({
    state: 'running',
    message: 'Server is running.',
    url: APP_URL,
  })

  if (AUTO_OPEN_BROWSER && !didAutoOpen) {
    didAutoOpen = true
    await openInterface()
  }

  void checkForLauncherUpdates()
}

ipcMain.handle('launcher:get-state', () => {
  return {
    url: APP_URL,
    autoOpen: AUTO_OPEN_BROWSER,
    appVersion: app.getVersion(),
    whatsNew: loadLocalWhatsNew(),
  }
})

ipcMain.handle('launcher:open-interface', async () => {
  await openInterface()
  return { ok: true }
})

ipcMain.handle('launcher:copy-address', () => {
  clipboard.writeText(APP_URL)
  return { ok: true }
})

ipcMain.handle('launcher:quit', async () => {
  isShuttingDown = true
  await stopServer()
  app.quit()
  return { ok: true }
})

ipcMain.handle('launcher:check-updates', async () => {
  return checkForLauncherUpdates()
})

ipcMain.handle('launcher:install-update', async () => {
  if (!isUpdateDownloaded) {
    return { ok: false, reason: 'not-downloaded' }
  }

  isShuttingDown = true
  await stopServer()
  setImmediate(() => {
    autoUpdater.quitAndInstall(false, true)
  })
  return { ok: true }
})

app.whenReady().then(bootstrap)

app.on('before-quit', async () => {
  isShuttingDown = true
  await stopServer()
})

app.on('window-all-closed', () => {
  app.quit()
})

app.on('second-instance', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) {
      mainWindow.restore()
    }
    mainWindow.focus()
  }
})

const singleLock = app.requestSingleInstanceLock()
if (!singleLock) {
  app.quit()
}
