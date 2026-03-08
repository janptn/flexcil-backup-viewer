const { app, BrowserWindow, ipcMain, shell, clipboard } = require('electron')
const path = require('path')
const http = require('http')
const { spawn } = require('child_process')

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

function serverScriptPath() {
  return path.join(app.getAppPath(), 'launcher', 'server.cjs')
}

function createMainWindow() {
  const window = new BrowserWindow({
    title: 'Flexcil Local Viewer',
    width: 460,
    height: 330,
    minWidth: 440,
    minHeight: 320,
    resizable: false,
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

function openInterface() {
  return shell.openExternal(APP_URL)
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
  const scriptPath = serverScriptPath()
  const child = spawn(process.execPath, [scriptPath, '--no-window'], {
    cwd: app.getAppPath(),
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
    },
    windowsHide: true,
    stdio: 'pipe',
  })

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
}

async function bootstrap() {
  mainWindow = createMainWindow()

  sendStatusToRenderer({
    state: 'starting',
    message: 'Starting local server…',
    url: APP_URL,
  })

  startServerProcess()
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
}

ipcMain.handle('launcher:get-state', () => {
  return {
    url: APP_URL,
    autoOpen: AUTO_OPEN_BROWSER,
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
