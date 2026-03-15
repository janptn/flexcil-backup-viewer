# Changelog

## 1.2.6 - 2026-03-15

### Added
- Import flow now asks for backup type: Google Drive Backup or Manual Backup.
- Library view options now include Default, A4 Preview, and Original thumbnail mode.
- Library grid size control added (Compact, Comfortable, Large) with persisted preference.

### Changed
- Manual backup import now reads folder structure directly from `Documents/...` archive paths and keeps document-name based titles.
- Ink rendering improved with additional trail cleanup for pen-start artifacts and ghost connector segments.
- Stroke-size mapping improved by deriving per-stroke width from Flexcil metadata values instead of flattening to one thickness.
- Arrow and symbol rendering refined to better match Flexcil visual style.

### Fixed
- Corrected accidental fill behavior where some box-like symbols were rendered as solid black.
- Updated default stroke size setting to 100% for first-time startup.

### Notes
- Shape/form rendering quality is significantly improved and still being iterated with real-world Flexcil files.
