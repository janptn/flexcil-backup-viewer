const http = require('http')
const fs = require('fs')
const path = require('path')
const { exec } = require('child_process')

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
  const packaged = path.join(__dirname, '..', 'dist')
  const local = path.join(process.cwd(), 'dist')

  if (fs.existsSync(path.join(packaged, 'index.html'))) {
    return packaged
  }

  if (fs.existsSync(path.join(local, 'index.html'))) {
    return local
  }

  throw new Error('Could not find dist/index.html. Please run build:exe from project root.')
}

function openBrowser(url) {
  if (process.platform === 'win32') {
    exec(`start "" "${url}"`)
    return
  }
  if (process.platform === 'darwin') {
    exec(`open "${url}"`)
    return
  }
  exec(`xdg-open "${url}"`)
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
  const distDir = resolveDistPath()
  const server = createServer(distDir)

  server.listen(0, '127.0.0.1', () => {
    const address = server.address()
    const port = typeof address === 'object' && address ? address.port : 4173
    const url = `http://127.0.0.1:${port}`

    console.log(`Flexcil Local Viewer is running at ${url}`)
    console.log('Press Ctrl+C to stop the launcher.')
    openBrowser(url)
  })

  const shutdown = () => {
    server.close(() => process.exit(0))
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

start()
