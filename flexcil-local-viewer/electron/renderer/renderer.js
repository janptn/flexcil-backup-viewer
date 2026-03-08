const urlBox = document.getElementById('urlBox')
const statusText = document.getElementById('statusText')
const openBtn = document.getElementById('openBtn')
const copyBtn = document.getElementById('copyBtn')
const quitBtn = document.getElementById('quitBtn')

let currentUrl = 'http://127.0.0.1:41731'

function setStatus(message) {
  statusText.textContent = message
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

  window.launcherApi.onStatus((payload) => {
    if (payload && payload.url) {
      currentUrl = payload.url
      urlBox.textContent = currentUrl
    }

    if (payload && payload.message) {
      setStatus(payload.message)
    }
  })
}

init().catch((error) => {
  setStatus(`Launcher error: ${error instanceof Error ? error.message : String(error)}`)
})
