const http = require('http')
const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')

const HOST = '127.0.0.1'
const PORT = 41731
const NO_WINDOW_FLAG = '--no-window'

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
}

function resolveDistPath() {
  const packagedSnapshot = path.join(__dirname, '..', 'dist')
  const local = path.join(process.cwd(), 'dist')

  if (process.pkg) {
    if (fs.existsSync(path.join(packagedSnapshot, 'index.html'))) {
      return packagedSnapshot
    }

    throw new Error('Could not find bundled dist/index.html inside executable. Please rebuild the launcher with npm run build:exe.')
  }

  if (fs.existsSync(path.join(local, 'index.html'))) {
    return local
  }

  if (fs.existsSync(path.join(packagedSnapshot, 'index.html'))) {
    return packagedSnapshot
  }

  throw new Error('Could not find dist/index.html. Please run npm run build first.')
}

function resolveDataRoot() {
  if (process.pkg) {
    return path.join(path.dirname(process.execPath), 'flexcil-data')
  }
  return path.join(process.cwd(), 'flexcil-data')
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true })
  }
}

function ensureLauncherIconFile(dataRoot) {
  const sourceCandidates = [
    path.join(__dirname, 'logo.ico'),
    path.join(process.cwd(), 'launcher', 'logo.ico'),
  ]

  const sourcePath = sourceCandidates.find((candidate) => fs.existsSync(candidate))
  if (!sourcePath) {
    return ''
  }

  const targetPath = path.join(dataRoot, 'launcher-logo.ico')
  try {
    fs.copyFileSync(sourcePath, targetPath)
    return targetPath
  } catch {
    return ''
  }
}

function showWindowsStatusWindow(url, dataRoot) {
  ensureDir(dataRoot)
  const htaPath = path.join(dataRoot, 'launcher-status.hta')
  const safeUrl = String(url).replace(/'/g, "\\'")
  const iconPath = ensureLauncherIconFile(dataRoot)
  const safeIconPath = String(iconPath).replace(/&/g, '&amp;').replace(/"/g, '&quot;')

  const htaContent = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="x-ua-compatible" content="IE=9" />
    <title>Flexcil Local Viewer</title>
    <hta:application
      id="flexcilLauncher"
      applicationname="FlexcilLocalViewerLauncher"
      border="thin"
      caption="yes"
      icon="${safeIconPath}"
      maximizebutton="no"
      minimizebutton="yes"
      showintaskbar="yes"
      singleinstance="yes"
      sysmenu="yes"
      windowstate="normal"
    />
    <style>
      body {
        margin: 0;
        font-family: 'Segoe UI', Arial, sans-serif;
        background: #0f172a;
        color: #e2e8f0;
      }
      .wrap {
        margin: 16px;
        padding: 16px;
        border: 1px solid #334155;
        border-radius: 12px;
        background: #111827;
      }
      .title {
        margin: 0 0 6px 0;
        font-size: 18px;
        font-weight: 600;
        color: #f8fafc;
      }
      .msg {
        margin: 0 0 12px 0;
        font-size: 13px;
        color: #cbd5e1;
        line-height: 1.45;
      }
      .url {
        width: 100%;
        box-sizing: border-box;
        padding: 10px 12px;
        border: 1px solid #334155;
        border-radius: 8px;
        background: #020617;
        color: #93c5fd;
        margin-bottom: 14px;
      }
      .row {
        display: flex;
        gap: 10px;
      }
      .btn {
        border: 1px solid #334155;
        border-radius: 8px;
        background: #1e293b;
        color: #e2e8f0;
        font-size: 13px;
        font-weight: 600;
        padding: 9px 12px;
        cursor: pointer;
      }
      .btn:hover { background: #334155; }
      .btn-primary {
        border-color: #2563eb;
        background: #2563eb;
        color: #ffffff;
      }
      .btn-primary:hover { background: #1d4ed8; }
    </style>
    <script>
      var appUrl = '${safeUrl}';
      function openUi() {
        try {
          var shell = new ActiveXObject('WScript.Shell');
          shell.Run('cmd /c start "" "' + appUrl + '"', 0, false);
        } catch (e) {
          alert('Konnte Browser nicht öffnen. Bitte URL manuell kopieren.');
        }
      }
      function copyUrl() {
        try {
          window.clipboardData.setData('Text', appUrl);
        } catch (e) {
          alert('Kopieren fehlgeschlagen. Bitte URL manuell markieren.');
        }
      }
      function init() {
        document.getElementById('url').value = appUrl;
        try {
          var width = 620;
          var height = 290;
          window.resizeTo(width, height);
          var left = Math.max(0, Math.floor((screen.availWidth - width) / 2));
          var top = Math.max(0, Math.floor((screen.availHeight - height) / 2));
          window.moveTo(left, top);
        } catch (e) {}
      }
    </script>
  </head>
  <body onload="init()">
    <div class="wrap">
      <h1 class="title">Flexcil Local Viewer</h1>
      <p class="msg">Server läuft. Nutze die Adresse im Browser, falls der Button nicht geht:</p>
      <input id="url" class="url" readonly />
      <div class="row">
        <button class="btn btn-primary" onclick="openUi()">Oberfläche öffnen</button>
        <button class="btn" onclick="copyUrl()">Adresse kopieren</button>
        <button class="btn" onclick="window.close()">Schließen</button>
      </div>
    </div>
  </body>
</html>`

  const bom = Buffer.from([0xff, 0xfe])
  const utf16Content = Buffer.from(htaContent, 'utf16le')
  fs.writeFileSync(htaPath, Buffer.concat([bom, utf16Content]))
  return spawn('mshta.exe', [htaPath], { windowsHide: true, stdio: 'ignore' })
}

function safeFilePath(baseDir, reqPath) {
  const clean = decodeURIComponent(reqPath.split('?')[0])
  const relative = clean === '/' ? '/index.html' : clean
  const candidate = path.normalize(path.join(baseDir, relative))

  if (!candidate.startsWith(baseDir)) {
    return null
  }
  return candidate
}

function createServer(distDir) {
  return http.createServer((req, res) => {
    const requestPath = req.url || '/'
    let filePath = safeFilePath(distDir, requestPath)

    if (!filePath) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('Forbidden')
      return
    }

    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      filePath = path.join(distDir, 'index.html')
    }

    fs.readFile(filePath, (error, data) => {
      if (error) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end('Internal Server Error')
        return
      }

      const ext = path.extname(filePath).toLowerCase()
      const contentType = MIME_TYPES[ext] || 'application/octet-stream'
      res.writeHead(200, {
        'Content-Type': contentType,
        'Cache-Control': 'no-cache',
      })
      res.end(data)
    })
  })
}

function start() {
  const noWindowMode = process.argv.includes(NO_WINDOW_FLAG)
  const distDir = resolveDistPath()
  const dataRoot = resolveDataRoot()
  ensureDir(dataRoot)
  const server = createServer(distDir)
  const url = `http://${HOST}:${PORT}`

  server.on('error', (error) => {
    if (error && error.code === 'EADDRINUSE') {
      console.log(`Port ${PORT} is already in use.`)
      console.log(`Use this URL in your browser: ${url}`)
      if (process.platform === 'win32' && !noWindowMode) {
        const statusWindow = showWindowsStatusWindow(url, dataRoot)
        statusWindow.on('error', () => {
          console.warn('Could not open status window. Please open the URL manually in your browser.')
          process.exit(0)
        })
        statusWindow.on('exit', () => {
          process.exit(0)
        })
        return
      }
      process.exit(0)
      return
    }
    console.error('Failed to start launcher server:', error)
    process.exit(1)
  })

  server.listen(PORT, HOST, () => {
    console.log(`Flexcil Local Viewer is running at ${url}`)
    console.log(`Persistent data folder: ${dataRoot}`)
    console.log('Press Ctrl+C to stop the launcher.')
    if (process.platform === 'win32' && !noWindowMode) {
      const statusWindow = showWindowsStatusWindow(url, dataRoot)

      statusWindow.on('error', () => {
        console.warn('Could not open status window. Please open the URL manually in your browser.')
      })

      statusWindow.on('exit', (code) => {
        if (typeof code === 'number' && code !== 0) {
          console.warn('Status window exited unexpectedly. Server stays active in this console.')
          return
        }
        server.close(() => process.exit(0))
      })

      return
    }

    console.log(`Use this URL in your browser: ${url}`)
  })

  const shutdown = () => {
    server.close(() => process.exit(0))
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

start()
