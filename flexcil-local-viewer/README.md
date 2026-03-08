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

## Electron Launcher (Windows)

The app UI stays a normal browser app on `http://127.0.0.1:41731`.
Electron is only used as a small native launcher that:

1. Starts the local server
2. Shows launcher controls (`Open Interface`, `Copy Address`, `Quit`)
3. Opens the URL in the default external browser
4. Stops the server when the launcher exits

### Local launcher run

```bash
npm run electron:dev
```

### Build Windows installer

```bash
npm run dist:win
```

Artifacts are written to:

- `release/electron/*.exe`

### Data Persistence

- The launcher now uses a fixed local URL (`http://127.0.0.1:41731`) so IndexedDB stays on the same origin.
- The launcher can auto-open your default browser after server startup.
- Use `Open Interface` in the launcher window to open the URL again in your default browser.
- You can always copy/open the shown URL manually from the launcher window if needed.
- Launcher and installer icon use `launcher/logo.ico`.
- Result: imported library data remains available after closing/reopening the launcher.

## Usage

1. Open app
2. Import backup files (`.zip`, `.flx`, `.list`) via top-bar import or drag & drop
3. Browse library, use folder tree, and open documents
4. Search globally or inside a document

## Notes

- Everything runs locally on the user's machine.
- No cloud, no login, no external backend.
- Data remains in local IndexedDB.
