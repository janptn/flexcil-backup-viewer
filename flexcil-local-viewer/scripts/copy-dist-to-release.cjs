const fs = require('fs')
const path = require('path')

function copyRecursive(source, target) {
  const stat = fs.statSync(source)

  if (stat.isDirectory()) {
    fs.mkdirSync(target, { recursive: true })
    const entries = fs.readdirSync(source)
    for (const entry of entries) {
      copyRecursive(path.join(source, entry), path.join(target, entry))
    }
    return
  }

  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.copyFileSync(source, target)
}

function run() {
  const projectRoot = path.join(__dirname, '..')
  const sourceDist = path.join(projectRoot, 'dist')
  const targetDist = path.join(projectRoot, 'release', 'dist')

  if (!fs.existsSync(sourceDist)) {
    throw new Error('dist folder not found. Run npm run build first.')
  }

  if (fs.existsSync(targetDist)) {
    fs.rmSync(targetDist, { recursive: true, force: true })
  }

  copyRecursive(sourceDist, targetDist)
  console.log(`Copied dist to ${targetDist}`)
}

run()
