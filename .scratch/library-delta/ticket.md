# Faster library indexing: reuse what the last scan already knows

- **Slug**: library-delta
- **Requested by**: the human, one line: "the indexing of the library should be faster and more clever using for instance only the delta"

## The problem

The music library index (`allFiles`, built by the SAF scan and persisted in IndexedDB) is rebuilt from scratch whenever it is (re)built:

- `startLibraryScan` clears `allFiles` and appends batch by batch (`src/lib/device/deviceLibrary.svelte.ts:161-199`).
- Each batch calls `bumpBrowseVersion()`, and the view effect rebuilds the whole browse list with `buildBrowseEntries(allFiles, path)` over the growing array (`src/lib/components/views/Mp3PlayerView.svelte:778-783`, `src/lib/models/browse.ts:23-38`). On a large library that is quadratic work per scan.
- `rescanCurrentLibraryIndex` deletes the cache key and rescans the whole tree, then rebuilds the queue (`src/lib/device/deviceLibrary.svelte.ts:211-228`).
- The cache holds per-file `modifiedAt` but no directory tree and no file size (`src/lib/models/music.ts:57-68`), so nothing can answer "which subtree changed since the last scan".

The native walk itself is already cheap per directory: one `DocumentsContract` child-cursor query per directory, with name, mime, mtime in the same query (`android/app/src/main/java/com/maverock24/mobilemediaapp/DirectoryReaderPlugin.java:30-56, 174-200`).

## Settled decisions (from the Design round)

- **D1 Scope**: the local SAF library only. The Drive library keeps its current paged `files.list` path (`src/lib/google-drive.ts:498-570` has no `changes` API).
- **D2 Strategy**: SAF subtree pruning. Cache the directory tree with each directory's mtime; on a rescan, skip descending into directories whose mtime is unchanged since the last scan, and re-map only changed files. Add `COLUMN_SIZE` to the existing child cursor for an (mtime, size) fingerprint.
- **D3 Removals**: a completed delta walk is authoritative. A cached file absent from the walk is pruned from the index and the cache. An incomplete or cancelled walk must not prune.
- **D4 Workspace**: implementation in a fresh git worktree on branch `qrspi/library-delta`, so the main checkout keeps another session's uncommitted work untouched.

## Constraints

- No new Android permissions. `READ_MEDIA_AUDIO` is declared (`android/app/src/main/AndroidManifest.xml:87`) but MediaStore is out of scope.
- Existing behaviour to preserve: the cache shape is read by `restoreLocalLibrary`/`openFolder` (`deviceLibrary.svelte.ts:236-360`); an old cache without a directory tree must still load and simply fall back to a full scan.
- No data loss: a delta must never drop a file because a directory was unreadable (`DirectoryReaderPlugin` skips unreadable dirs, see the `catch` at `:196-199`).
- Critical: no.
