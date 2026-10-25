# Design tree: library-delta

- **Slug**: library-delta
- **Stage**: Design
- **Critical**: no
- **Done**: Questions, Research

## End state

A warm library start runs a background delta: it walks only directories whose mtime is new or unknown, merges an (mtime, size) diff into the cached index, publishes the index once instead of once per batch, and writes the cache only when a walk completes. An explicit Rescan from Settings is always a full walk, as the human chose; the delta therefore gets its own trigger on start, which is what keeps the index fresh today, where a warm start does no walk at all. The full walk is also the fallback for a cold cache, an old-format cache, a tree over the size cap, a cached walk older than the verification window, a provider that reports no mtimes, and any walk that could not read a directory.

## Out of scope

- Drive delta (no `changes` API in `src/lib/google-drive.ts`; separate effort per decision D1 in the ticket).
- MediaStore as a fast path (`READ_MEDIA_AUDIO` is declared but unused; identity and playback paths would move).
- Treating a rename as the same file (`relativePath` is the identity key, `src/lib/models/music.ts:114-117`).
- A per-track removal API on the player (`src/lib/audio/player.svelte.ts:529-543`).
- Any change to what the Rescan button means to the user.

## Blocked-by map

- D1 blocks D3 and D9.
- D2 blocks D3.
- D3 blocks nothing.
- D4 to D8 are independent.
- D9 needs D1 (payload shape) settled.

## Decisions

### D1. How much to trust a directory's mtime when deciding to skip a subtree

- **Status**: settled by the human
- **Blocked by**: none
- **Decision**: conservative, with periodic verification. Skip a subtree only when the directory's mtime is known (non-zero) and no newer than the previous completed walk. Treat `0`/absent as unknown and descend. Run one full walk when the cached walk is older than the verification window, and always on an explicit Rescan. Rationale: Android documents `COLUMN_LAST_MODIFIED` as nullable and only optionally updated (`developer.android.com/reference/android/provider/DocumentsContract.Document#COLUMN_LAST_MODIFIED`), no Android page promises it tracks children, so an unconditional skip would silently miss changes.
- **Amendment (Structure/Plan stage)**: "always full on Rescan" and "a rescan walks only new or unknown directories" cannot both hold while Rescan is the only trigger, which the outline caught. The answer is a second trigger rather than a weaker rule: a warm start with a usable tree inside the window runs a **background delta**, and the Settings Rescan stays a **full walk**. The delta is what makes a warm start notice new files, which today it cannot do at all; Rescan stays the manual "verify everything" affordance the human chose.

### D2. What to do with a walk that could not read a directory

- **Status**: settled by the human
- **Blocked by**: none
- **Decision**: skip pruning for the whole walk. Today a failed directory is indistinguishable from an empty one (`DirectoryReaderPlugin.java:172`, `:196-198`), so the native batch gains an `unreadableDirs` counter; a walk ending with a non-zero count publishes the additions and updates it did observe and prunes nothing.
- **Amendment (Structure stage)**: the same rule covers skipped subtrees. A file that lives under a directory the walk did not descend into is absent from the walk output but not missing from the device, so the prune pass excludes every path under a skipped directory and carries those files over unchanged. Without this, the first delta on a clean provider would delete the contents of every unchanged folder.

### D3. Whether the delta has an opt-out other than "no mtimes"

- **Status**: settled
- **Blocked by**: D1, D2
- **Decision**: three fallbacks to a full walk: cold cache, cache without a directory tree or with a different `schemaVersion`, and a cached tree handed to the native walker in excess of a size cap (2 MB of encoded rows). No user preference flag: a fourth switch would be untestable configuration.

### D4. Where the skip decision is made, and what it needs

- **Status**: settled
- **Blocked by**: none
- **Decision**: in the native walker. The queue that decides what to descend into lives in `DirectoryReaderPlugin.java:170-199`, so skipping can only happen there; `startAudioScan` therefore accepts the previous directory tree as `path` + `mtime` rows and reports which directories it skipped. Rejected: driving the walk from JS level by level (`listEntries` per directory), which is one bridge round trip per directory instead of one cursor query, and rejected persisting the tree natively, which splits cache ownership across two runtimes.
- **Amendment (Structure stage)**: the walk also has to hand back the tree it just walked, or the cache can never be refreshed and every rescan stays a full walk. Each batch therefore carries the directory rows it visited (`path`, `mtime`) alongside the files, and a directory the walk skipped keeps its previous row. The persisted tree is the union of walked rows with the skipped rows from the previous tree.

### D5. File change fingerprint

- **Status**: settled
- **Blocked by**: none
- **Decision**: (mtime, size). `COLUMN_SIZE` joins the existing single cursor projection (`DirectoryReaderPlugin.java:54-59`) so it costs no extra query; `NativeDirectoryFile`, `StoredAudioFile['native']` and `CachedNativeLibraryFile` gain `sizeBytes?: number`. A file is unchanged when both match, which distinguishes a rewrite that keeps the mtime from a real no-op.

### D6. Cache payload

- **Status**: settled
- **Blocked by**: none
- **Decision**: additive and versioned: `schemaVersion: 1`, `dirs: Array<{ path: string; mtime: number }>`, `completedAt: number`, and `sizeBytes` on each file. A payload without `schemaVersion` is read as "no directory tree" and triggers one full walk; nothing is migrated, because the only thing a migration could save is a single full walk once per device.
- **Amendment (Structure stage)**: an empty index is a legitimate payload. `saveCachedLibrary` returns early on an empty list (`src/lib/browse/libraryCache.ts:83`), which is how a stale cache survives a folder the user emptied, so the new writer must persist a completed empty walk with its `completedAt` rather than skip the write.

### D7. Cache write timing, and the rescan data-loss window

- **Status**: settled
- **Blocked by**: none
- **Decision**: write once, on completion, and stop deleting the cache before the walk. Today `rescanCurrentLibraryIndex` deletes both keys and then scans (`src/lib/device/deviceLibrary.svelte.ts:213-221`), so a cancelled or failed rescan leaves no cache at all; with a completion-only write the old payload survives a failed walk.

### D8. Publishing the index

- **Status**: settled
- **Blocked by**: none
- **Decision**: a delta publishes once. A full walk keeps its current streaming behaviour for the first scan (the user is watching an empty library fill), but stops bumping `browseVersion` on every batch: the view reloads the browse list on a coalesced boundary (one bump per animation frame at most) so `buildBrowseEntries` no longer runs over the whole array per batch (`deviceLibrary.svelte.ts:178-179`, `Mp3PlayerView.svelte:784-792`).

### D9. Search index correctness when the index is replaced

- **Status**: settled
- **Blocked by**: none
- **Decision**: key the incremental search index on an explicit revision counter, not on `allFiles.length` (`Mp3PlayerView.svelte:245-250`). A delta that adds one file and removes another leaves the length unchanged, which the current effect cannot see, and it already misses in-place replacement. The revision is bumped by every publish.

### D10. Queue handling on a delta

- **Status**: settled
- **Blocked by**: none
- **Decision**: unchanged for now. A delta with no changes does not touch the queue; a delta with changes calls `hydrateTracksFromLibrary` exactly as a full scan does, behind the existing `trackListLockedByUser` guard (`deviceLibrary.svelte.ts:196`). Adding a remove API to the player is out of scope (see Out of scope).

### D11. How the mtime uncertainty gets settled for real

- **Status**: settled by the human
- **Blocked by**: none
- **Decision**: ship a one-shot probe. On the first delta walk the native side logs, per directory it skipped, the mtime it trusted; `docs/device-verification.md` gains a check that walks a folder, adds a file in a subfolder, and records whether the parent's mtime moved. The probe stays in the code behind the existing scan path rather than a hidden debug flag.

### D12. Every cache writer shares one path

- **Status**: settled
- **Blocked by**: D6
- **Decision**: the scan, `fileOps.forgetDeletedFile` (which rewrites the cache after a delete, `src/lib/files/fileOps.ts:201-233`), and the two hidden-input paths all write through one function that carries `schemaVersion`, `dirs` and `completedAt`. Today a delete rewrites the payload from the file list alone, which would drop the tree and force the next start into a full walk; the writers that cannot know a tree (hidden inputs, no SAF tree URI) write `schemaVersion: 1` with an empty `dirs` so the next walk is full by design.

### D13. Native type duplicate

- **Status**: settled
- **Blocked by**: none
- **Decision**: `NativeDirectoryFile` is declared in more than one place (`src/lib/native/directory-reader.ts:3-11` and again in the browse layer). Collapse to the bridge declaration before adding `sizeBytes`, so the new field lands once.
