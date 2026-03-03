# Flexcil Local Viewer

A modern, fully local web app for importing Flexcil/Flexel backups and viewing embedded PDFs with a custom PDF.js viewer.

## Features

- Import `.flx`, `.list`, or full backup `.zip` via drag & drop or file picker
- Extract `attachment/PDF/<id>` entries using JSZip
- Duplicate detection using document ID and SHA-256 hash
- Local persistence in IndexedDB (offline, no backend)
- Library UI with sidebar, search, and folder collections
- Custom PDF viewer on `/doc/:id` (PDF.js, not browser default viewer)
- PDF toolbar: page navigation, zoom, Fit Width/Fit Page, download
- In-document search with highlights, hit list, and jump-to-page
- Global full-text indexing for imported PDFs
- Dark/Light Mode

## Tech Stack

- Vite + React + TypeScript
- TailwindCSS
- JSZip
- pdfjs-dist
- idb (IndexedDB)

## Setup

```bash
npm install
npm run dev
```

Then open the local Vite URL in your browser (usually `http://localhost:5173`).

## Build

```bash
npm run build
npm run preview
```

## Using It With This Workspace

Your backup files are in the `flexcil sync` folder in this workspace. In the app:

1. Click `Import` (or drop files)
2. Select `.flx`, `.list`, or backup `.zip` files from `flexcil sync`
3. Documents appear in the library and remain stored locally

## Project Structure

```text
src/
  components/
    PdfViewer.tsx
    Topbar.tsx
    Sidebar.tsx
    LibraryGrid.tsx
    DocumentCard.tsx
    DropzoneOverlay.tsx
  context/
    LibraryContext.tsx
  hooks/
    useLibraryStore.ts
    useFlexelImport.ts
  lib/
    db.ts
    documentsList.ts
    flexelImport.ts
    hash.ts
    pdfText.ts
    format.ts
  pages/
    LibraryPage.tsx
    DocumentPage.tsx
  types.ts
```

## Notes

- The app is fully local (no cloud, no login, no server DB).
- Metadata files (`info`, `pages.index`, `template.info`, `.itemInfo`, `documents.list`) are parsed when available and used for titles/folder paths.
- If no meaningful folder structure is available, library browsing and search still work.
