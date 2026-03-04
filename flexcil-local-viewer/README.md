# Flexcil Local Viewer

A fully local web app for importing Flexcil/Flexel backups and viewing embedded PDFs with a custom PDF.js viewer.

## Features

- Import `.flx`, `.list`, or full backup `.zip`
- Automatic ZIP extraction in-browser
- Folder structure reconstruction from backup metadata
- Duplicate detection using document ID and SHA-256 hash
- IndexedDB local persistence (offline, no backend)
- Global full-text search across imported PDFs
- In-document search with highlight + match list + jump to page
- Responsive UI, dark mode, and custom PDF viewer controls

## Quick Start (Development)

```bash
npm install
npm run dev
```

Open the local URL shown by Vite (usually `http://localhost:5173`).

## Build Web App

```bash
npm run build
npm run preview
```

## Build Windows EXE (Browser Launcher, no Electron)

The Windows build now creates a dedicated GUI wrapper app (no console window) plus an internal server executable.

The GUI wrapper:

1. Starts the local server executable in the background
2. Shows a centered launcher window with URL + button (`Oberfläche öffnen`)
3. Uses a persistent local data folder so imported documents survive restart

```bash
npm run build:exe
```

Output file:

- Start this file: `release/Flexcil-Local-Viewer.exe`
- Keep together in the same folder: `release/Flexcil-Local-Viewer-Server.exe`

Users can simply double-click the EXE. No dev setup required.

### EXE Data Persistence (Portable)

- The launcher now uses a fixed local URL (`http://127.0.0.1:41731`) so IndexedDB stays on the same origin.
- On Windows, it tries to launch Edge/Chrome with a dedicated profile at `flexcil-data/browser-profile` next to the EXE.
- The launcher does not auto-open the browser.
- Use `Oberfläche öffnen` in the launcher window to open the URL in your default browser.
- You can always copy/open the shown URL manually from the launcher window if needed.
- Launcher window and EXE icon use `public/logo.svg` -> `launcher/logo.ico` during `npm run build:exe` (with `rcedit` + fallback).
- Result: imported library data remains available after closing/reopening the EXE.
- Update workflow: replace `Flexcil-Local-Viewer.exe` and `Flexcil-Local-Viewer-Server.exe`; keep the `flexcil-data` folder.

## Usage

1. Open app
2. Import backup files (`.zip`, `.flx`, `.list`) via top-bar import or drag & drop
3. Browse library, use folder tree, and open documents
4. Search globally or inside a document

## Notes

- Everything runs locally on the user's machine.
- No cloud, no login, no external backend.
- Data remains in local IndexedDB.
