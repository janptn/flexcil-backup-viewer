const urlBox = document.getElementById('urlBox')
const statusText = document.getElementById('statusText')
const updateStatusText = document.getElementById('updateStatusText')
const openBtn = document.getElementById('openBtn')
const copyBtn = document.getElementById('copyBtn')
const quitBtn = document.getElementById('quitBtn')
const checkUpdateBtn = document.getElementById('checkUpdateBtn')
const installUpdateBtn = document.getElementById('installUpdateBtn')

let currentUrl = 'http://127.0.0.1:41731'

function setStatus(message) {
  statusText.textContent = message
}

function setUpdateStatus(message) {
  updateStatusText.textContent = `Updater: ${message}`
}

function flashButton(button, text) {
  const original = button.textContent
  button.textContent = text
  setTimeout(() => {
    button.textContent = original
  }, 1000)
}

async function init() {
  const state = await window.launcherApi.getState()
  currentUrl = state.url || currentUrl
  urlBox.textContent = currentUrl

  openBtn.addEventListener('click', async () => {
    await window.launcherApi.openInterface()
    flashButton(openBtn, 'Opened')
  })

  copyBtn.addEventListener('click', async () => {
    await window.launcherApi.copyAddress()
    flashButton(copyBtn, 'Copied')
  })

  quitBtn.addEventListener('click', async () => {
    await window.launcherApi.quit()
  })

  checkUpdateBtn.addEventListener('click', async () => {
    checkUpdateBtn.disabled = true
    setUpdateStatus('checking…')
    await window.launcherApi.checkUpdates()
    setTimeout(() => {
      checkUpdateBtn.disabled = false
    }, 800)
  })

  installUpdateBtn.addEventListener('click', async () => {
    installUpdateBtn.disabled = true
    setUpdateStatus('installing and restarting…')
    await window.launcherApi.installUpdate()
  })

  window.launcherApi.onStatus((payload) => {
    if (payload && payload.url) {
      currentUrl = payload.url
      urlBox.textContent = currentUrl
    }

    if (payload && payload.message) {
      setStatus(payload.message)
    }
  })

  window.launcherApi.onUpdate((payload) => {
    if (!payload || typeof payload.message !== 'string') {
      return
    }

    setUpdateStatus(payload.message)

    if (payload.state === 'downloaded' || payload.canInstall) {
      installUpdateBtn.disabled = false
      installUpdateBtn.textContent = 'Install Update'
      return
    }

    if (payload.state === 'downloading') {
      installUpdateBtn.disabled = true
      installUpdateBtn.textContent = 'Downloading…'
      return
    }

    installUpdateBtn.disabled = true
    installUpdateBtn.textContent = 'Install Update'
  })
}

init().catch((error) => {
  setStatus(`Launcher error: ${error instanceof Error ? error.message : String(error)}`)
})
