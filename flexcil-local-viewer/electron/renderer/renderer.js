const urlBox = document.getElementById('urlBox')
const statusText = document.getElementById('statusText')
const updateStatusText = document.getElementById('updateStatusText')
const whatsNewTitle = document.getElementById('whatsNewTitle')
const whatsNewBox = document.getElementById('whatsNewBox')
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

function sanitizeNotesHtml(rawHtml) {
  const template = document.createElement('template')
  template.innerHTML = rawHtml

  const blockedTags = ['script', 'style', 'iframe', 'object', 'embed', 'link', 'meta']
  blockedTags.forEach((tagName) => {
    template.content.querySelectorAll(tagName).forEach((node) => node.remove())
  })

  template.content.querySelectorAll('*').forEach((element) => {
    Array.from(element.attributes).forEach((attribute) => {
      const name = attribute.name.toLowerCase()
      const value = attribute.value

      if (name.startsWith('on')) {
        element.removeAttribute(attribute.name)
        return
      }

      if ((name === 'href' || name === 'src') && /^\s*javascript:/i.test(value)) {
        element.removeAttribute(attribute.name)
      }
    })
  })

  return template.innerHTML
}

function looksLikeHtml(text) {
  return /<\/?[a-z][\s\S]*>/i.test(text)
}

function renderNotes(title, notesText, options = {}) {
  const { asHtml = false } = options
  whatsNewTitle.textContent = title

  if (!notesText || notesText.trim().length === 0) {
    whatsNewBox.textContent = 'No notes yet.'
    return
  }

  if (asHtml) {
    whatsNewBox.innerHTML = sanitizeNotesHtml(notesText)
    return
  }

  whatsNewBox.textContent = notesText
}

function linesToNotes(lines) {
  if (!Array.isArray(lines)) {
    return ''
  }

  return lines
    .filter((line) => typeof line === 'string' && line.trim().length > 0)
    .map((line) => `• ${line.trim()}`)
    .join('\n')
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
  setUpdateStatus(`ready (v${state.appVersion ?? 'unknown'})`)

  const localNotes = state.whatsNew
  if (localNotes && Array.isArray(localNotes.items) && localNotes.items.length > 0) {
    const localTitle = `${localNotes.title || "What's new"} (v${localNotes.version || state.appVersion || ''})`
      .replace(/\s+\(v\)$/, '')
    renderNotes(localTitle, linesToNotes(localNotes.items), { asHtml: false })
  }

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

    if (typeof payload.releaseNotes === 'string' && payload.releaseNotes.trim().length > 0) {
      const version = typeof payload.version === 'string' ? payload.version : 'new'
      renderNotes(`Update notes (v${version})`, payload.releaseNotes, {
        asHtml: looksLikeHtml(payload.releaseNotes)
      })
    }

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
