# ADR-0002: File move/copy/delete in the MP3 browse view

- Status: Accepted
- Date: 2026-08-22
- Deciders: maintainer, via grilling

## Context

The MP3 browse view reveals a per-row action strip on a left swipe. Today it
offers Download (Drive rows) or Upload (local rows). We are adding move, copy,
and delete so users can reorganise their library.

## Decision (revised — Drive file ops removed)

The per-row action strip provides Download (Drive rows) or Upload (local rows),
plus Move, Copy, and Delete. Revision: only native (SAF) local files support
move/copy/delete; Drive file management and the Drive scope widening were
removed. Drive files are download-only.

- **Sources:** native Android local files only for move/copy/delete. Drive is
  download-only (its browse/download stays). The web source is deferred.
- **Scope:** operations apply to files **and** folders.
- **Move/Copy:** within-local, implemented via the SAF plugin (`moveEntry` /
  `copyEntry`) — copy to a destination chosen in the local picker, then delete
  the source for a move. No cross-source (Drive) destinations.
- **Delete:** local deletes are permanent (SAF has no trash), with confirmation.
- **Drive scope:** NOT widened — the auth scope stays at `drive.readonly` +
  `drive.file` (reverted from full `drive`). No Drive API copy/move/trash.
- **UI:** the reveal shows Download (Drive) / Upload + Move/Copy/Delete (local
  rows only). Folder rows get the reveal; tap still navigates in.
- **Destination:** the local (SAF) destination picker only; the Drive ↔ local
  toggle was removed.

## Consequences

- New native SAF methods for move/copy/delete in the Android plugin.
- A local destination picker and a widened browse-row action strip.
- The Google Drive settings/podcast config sync (`driveConfigSync`) and its
  modules were removed; podcasts/settings persist only on-device.
