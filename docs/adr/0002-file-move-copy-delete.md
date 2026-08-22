# ADR-0002: File move/copy/delete in the MP3 browse view

- Status: Accepted
- Date: 2026-08-22
- Deciders: maintainer, via grilling

## Context

The MP3 browse view reveals a per-row action strip on a left swipe. Today it
offers Download (Drive rows) or Upload (local rows). We are adding move, copy,
and delete so users can reorganise their library.

## Decision

- **Sources:** Google Drive and native Android local files. The web
  (File System Access) source is deferred to a follow-up ticket.
- **Scope:** operations apply to files **and** folders.
- **Move:** within-Drive uses the Drive API parent change (cheap). Within-local
  uses a SAF move. Any cross-source move (Drive↔local) and every copy is
  implemented as copy-to-destination then delete-source — there is no atomic
  cross-volume move.
- **Copy:** copy to a chosen destination folder. On a duplicate name, auto-rename
  (`name (1).mp3`); never overwrite silently.
- **Delete:** Drive deletes move the file to Drive trash. Local deletes are
  permanent (SAF/FS Access have no trash). Both require a confirmation.
- **Drive scope:** widen the Drive auth scope to full `drive`. This is required
  for move/copy/delete on Drive files the app did not create (the current
  `drive.file` scope only permits writes to app-owned files). Tradeoff: broader
  read/write access to the user's Drive. The new scope must be added in the
  Google Cloud OAuth consent screen and the Android OAuth bridge.
- **UI:** the reveal widens to a horizontal strip (Download, Move, Copy, Delete,
  + Folder when filtered). Folder rows get the same reveal; tap still navigates
  into the folder.
- **Destination:** one combined destination picker with a Drive ↔ local toggle,
  reusing the existing Drive and local folder pickers under the hood.

## Consequences

- New Drive API functions (copy, move/update-parents, delete/trash) in
  `google-drive.ts`.
- New native SAF methods for move/copy/delete in the Android plugin.
- A combined destination-picker UI and a widened browse-row action strip.
- The widened Drive scope is a privacy-relevant change and must be reflected in
  the Google Cloud consent configuration.
