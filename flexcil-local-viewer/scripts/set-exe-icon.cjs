const path = require('path')
const fs = require('fs')
const os = require('os')
const { execFile } = require('child_process')
const rcedit = require('rcedit')

function cleanupDirectory(dirPath) {
  if (fs.existsSync(dirPath)) {
    fs.rmSync(dirPath, { recursive: true, force: true })
  }
}

function resolveResourceHackerPath(projectRoot) {
  const resourceHackerPath = path.join(projectRoot, 'node_modules', 'node-resourcehacker', 'ResourceHacker.exe')
  if (!fs.existsSync(resourceHackerPath)) {
    throw new Error(`ResourceHacker.exe not found at ${resourceHackerPath}. Please run npm install first.`)
  }
  return resourceHackerPath
}

function runResourceHacker(resourceHackerPath, exePath, iconPath, resourceName) {
  return new Promise((resolve, reject) => {
    const args = [
      '-open',
      exePath,
      '-save',
      exePath,
      '-action',
      'addoverwrite',
      '-res',
      iconPath,
      '-mask',
      `ICONGROUP,${resourceName},`,
    ]
    execFile(resourceHackerPath, args, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr || stdout || error.message))
        return
      }
      resolve()
    })
  })
}

async function run() {
  const projectRoot = path.join(__dirname, '..')
  const exeCandidates = [
    path.join(projectRoot, 'release', 'Flexcil-Local-Viewer.exe'),
    path.join(projectRoot, 'release', 'Flexcil-Local-Viewer-Browser-Launcher.exe'),
  ]
  const iconPath = path.join(projectRoot, 'launcher', 'logo.ico')

  if (!fs.existsSync(iconPath)) {
    throw new Error(`Icon not found: ${iconPath}`)
  }

  const existingExePaths = exeCandidates.filter((candidate) => fs.existsSync(candidate))
  if (existingExePaths.length === 0) {
    throw new Error(`No EXE found in release folder. Checked: ${exeCandidates.join(', ')}`)
  }

  for (const exePath of existingExePaths) {
    await setIconForExe(projectRoot, exePath, iconPath)
  }
}

async function setIconForExe(projectRoot, exePath, iconPath) {
  console.log(`Stamping icon for ${path.basename(exePath)}...`)

  const tempDir = path.join(os.tmpdir(), 'flexcil-rh')
  const tempExePath = path.join(tempDir, 'launcher.exe')
  const tempIconPath = path.join(tempDir, 'logo.ico')
  const tempResourceHackerPath = path.join(tempDir, 'ResourceHacker.exe')

  cleanupDirectory(tempDir)
  fs.mkdirSync(tempDir, { recursive: true })
  fs.copyFileSync(exePath, tempExePath)
  fs.copyFileSync(iconPath, tempIconPath)
  fs.copyFileSync(resolveResourceHackerPath(projectRoot), tempResourceHackerPath)

  try {
    await rcedit(exePath, { icon: iconPath })
    console.log(`EXE icon updated using rcedit: ${path.basename(exePath)}`)
    return
  } catch (rceditError) {
    console.warn(`rcedit icon update failed, trying ResourceHacker fallback: ${rceditError.message}`)
  }

  const candidates = ['1', 'MAINICON', 'IDR_MAINFRAME']
  let selectedResourceName = null
  let lastError = null

  try {
    for (const candidate of candidates) {
      try {
        await runResourceHacker(tempResourceHackerPath, tempExePath, tempIconPath, candidate)
        selectedResourceName = candidate
        break
      } catch (error) {
        lastError = error
      }
    }

    if (!selectedResourceName) {
      throw lastError || new Error('Failed to update EXE icon.')
    }

    fs.copyFileSync(tempExePath, exePath)
    console.log(`EXE icon updated using ResourceHacker (${selectedResourceName}): ${path.basename(exePath)}`)
  } finally {
    cleanupDirectory(tempDir)
  }
}

run().catch((error) => {
  console.error(error)
  process.exit(1)
})
