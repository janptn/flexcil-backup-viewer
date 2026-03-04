const fs = require('fs')
const path = require('path')
const sharp = require('sharp')
const pngToIco = require('png-to-ico')

async function run() {
  const projectRoot = path.join(__dirname, '..')
  const publicDir = path.join(projectRoot, 'public')
  const launcherDir = path.join(projectRoot, 'launcher')

  const logoPath = path.join(publicDir, 'logo.svg')
  if (!fs.existsSync(logoPath)) {
    throw new Error(`Missing logo file at ${logoPath}`)
  }

  const pngBuffer = await sharp(logoPath)
    .resize(256, 256, { fit: 'contain', background: { r: 15, g: 23, b: 42, alpha: 1 } })
    .png()
    .toBuffer()

  const icoBuffer = await pngToIco([pngBuffer])

  fs.writeFileSync(path.join(publicDir, 'favicon.ico'), icoBuffer)
  fs.writeFileSync(path.join(launcherDir, 'logo.ico'), icoBuffer)

  console.log('Icons prepared: public/favicon.ico and launcher/logo.ico')
}

run().catch((error) => {
  console.error(error)
  process.exit(1)
})
