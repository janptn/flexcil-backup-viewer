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

This EXE is a lightweight launcher that:

1. Starts a local static server
2. Opens the app automatically in your default browser

```bash
npm run build:exe
```

Output file:

- `release/Flexcil-Local-Viewer-Browser-Launcher.exe`

Users can simply double-click the EXE. No dev setup required.

## Usage

1. Open app
2. Import backup files (`.zip`, `.flx`, `.list`) via top-bar import or drag & drop
3. Browse library, use folder tree, and open documents
4. Search globally or inside a document

## Notes

- Everything runs locally on the user's machine.
- No cloud, no login, no external backend.
- Data remains in local IndexedDB.
