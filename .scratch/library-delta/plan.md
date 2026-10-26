# Plan: library-delta

- **Slug**: library-delta
- **Stage**: Plan
- **Critical**: no
- **Inputs**: `tree.md` (D1 to D13), `outline.md` (S1 to S10), `research.md`
- **Written in the main window** after the Plan subagent returned no result and wrote nothing. Content follows `outline.md`, with one design correction recorded in `tree.md` under D1.

## Prerequisites

1. Worktree and branch, from `main` at `1c4347e`, leaving the main checkout's uncommitted `ScreenDim`/`+layout.svelte` work untouched:
   `git worktree add .worktrees/library-delta -b qrspi/library-delta main`
2. Copy `.scratch/library-delta/` into the worktree so every commit carries its artifact (`outline.md` says artifacts are committed with the work; never commit `ACTIVE`).
3. Work inside the worktree only. `AGENTS.md` gate: `pnpm check && pnpm test` before each commit; `pnpm test:e2e` once before the final commit. Native compile check per native phase: `pnpm cap:sync:android && (cd android && ./gradlew :app:assembleDebug)`.

## Acceptance criteria (observable, not a stopwatch)

- **A1** A warm start with a usable cache issues a delta walk, and a delta walk on an unchanged library visits exactly one directory (the root), with `skippedDirs` equal to the number of cached directories.
- **A2** A warm start on a complete cache performs zero file reads, and the index is published once: `view.allFiles` is assigned once and `bumpBrowseVersion` fires once per walk, not once per batch.
- **A3** An explicit Rescan always performs a full walk, `skippedDirs === 0`, and a failed or cancelled walk leaves the previous cache payload intact.
- **A4** A walk with any `unreadableDirs > 0` prunes nothing, and a file under a skipped subtree is never pruned.
- **A5** A completed delta that removes every file writes a completed empty payload, so the library does not resurrect on the next start.
- **A6** Search results reflect an equal-length add-plus-remove in the same walk (the D9 trap).
- **A7** The unit suite and `pnpm check` pass, and `tests/unit/browse/libraryDelta.test.ts` covers rules 1 to 6 of `outline.md` S4 one test each.

## Phases

### P1. Size crosses the bridge and the cache (S1, D5)

- **Files**: `DirectoryReaderPlugin.java` (projection `:54-59`, three readers `:181`, `:249`, `:311`, `createFileObject` `:405-414` and its three call sites); `src/lib/native/directory-reader.ts`; `src/lib/models/music.ts` (both `NativeDirectoryFile` declarations, `StoredAudioFile['native']`, `CachedNativeLibraryFile`, `createStoredNativeAudioFile`); `src/lib/browse/libraryCache.ts`.
- **Change**: add `COLUMN_SIZE`, emit `sizeBytes`, thread it through types, cache write and restore. Additive, no behaviour change.
- **Automated check**: `pnpm test tests/unit/browse/libraryCache.test.ts tests/unit/models/music.test.ts` plus `pnpm check`. Two strict `toEqual` assertions gain `sizeBytes`; new test `round-trips sizeBytes from a cached native entry`.
- **Manual check**: install the debug APK, rescan the existing library, confirm the file count and list are identical to before.

### P2. Cache payload versioned; every writer preserves the tree (S2, D6, D12)

- **Files**: `src/lib/models/music.ts` (`CachedLibrary`, new `CachedLibraryDir`); `src/lib/browse/libraryCache.ts` (`saveCachedLibrary`, new `hasUsableDirectoryTree`); `src/lib/files/fileOps.ts` (`forgetDeletedFile` rewrite); `src/lib/device/deviceLibrary.svelte.ts` (three write sites).
- **Change**: write `schemaVersion: 1`, `completedAt`, `dirs` (empty until P6); readers ignore unknown fields; the delete rewrite carries the loaded payload's tree forward.
- **Automated check**: `pnpm test tests/unit/browse/libraryCache.test.ts tests/unit/files/fileOps.test.ts`. New tests: writes version+completedAt+rows; restores a legacy payload without `schemaVersion`; a delete keeps the rows; `hasUsableDirectoryTree` false for a legacy payload.
- **Manual check**: delete one file in the APK, restart, confirm the library does not come back and that the next scan is still not forced full (log line from P7).

### P3. Walker takes a previous tree, reports walked and skipped directories (S3, D4)

- **Files**: `DirectoryReaderPlugin.java` (`AudioScanSession`, `startAudioScan`, child loop, batch payload); `src/lib/native/directory-reader.ts` (`NativeDirectoryDir`, optional options and result fields); `src/lib/browse/folderScan.ts` (`scanNativeLibrary`, `scanNativeAudioFiles` wrapper).
- **Change**: `prevDirs` in, `dirs`/`skippedDirs`/`unreadableDirs` out; skip only when a cached mtime exists, is non-zero and matches; `onBatch` must fire for directory-only batches.
- **Automated check**: `pnpm test tests/unit/browse/folderScan.test.ts` (forwards the tree; aggregates a directory-only batch; counts an unreadable directory), plus the gradle debug compile.
- **Manual check**: none possible for the Java half; P7's probe is the compensating observation.

### P4. Delta merge as a pure function (S4, D2)

- **Files**: new `src/lib/browse/libraryDelta.ts`; new `tests/unit/browse/libraryDelta.test.ts`.
- **Change**: `mergeLibraryDelta({ previous, walked, dirs, skippedDirs, unreadableDirs, completed })`, rules 1 to 6 from `outline.md` S4 (fingerprint, identity, incomplete, unreadable, skipped-subtree protection, `/`-delimited prefixes).
- **Automated check**: `pnpm test tests/unit/browse/libraryDelta.test.ts`, one test per rule, plus equal-length add-plus-remove and incomplete-walk-keeps-previous.
- **Manual check**: none; the check is the suite.

### P5. Rescan stops deleting the cache before it walks (S5, D7)

- **Files**: `src/lib/device/deviceLibrary.svelte.ts` (`rescanCurrentLibraryIndex`); `tests/unit/device/deviceLibrary.test.ts`.
- **Change**: no pre-scan delete; the completion write replaces the payload.
- **Automated check**: `pnpm test tests/unit/device/deviceLibrary.test.ts -t rescanCurrentLibraryIndex`, plus `keeps the stored payload when the rescan fails`.
- **Manual check**: start a rescan and kill the app mid-walk; the library still lists files on the next launch.

### P6. The delta walk runs end to end (S6, D1, D3, D10)

- **Files**: `src/lib/browse/libraryDelta.ts` (`decideScanMode`, `DELTA_TREE_MAX_BYTES`, `FULL_WALK_MAX_AGE_MS`); `src/lib/device/deviceLibrary.svelte.ts` (`startLibraryScan`, `rescanCurrentLibraryIndex`, publish, hydrate guard); `src/lib/browse/libraryCache.ts` (allow the completed empty write); tests in `deviceLibrary.test.ts` and `libraryDelta.test.ts`.
- **Change**: warm start triggers a delta when the tree is usable and inside the window; Rescan is always full; fallbacks are cold cache, legacy payload, over-cap tree, stale window; one publish; cache write on completion only.
- **Automated check**: `pnpm test tests/unit/browse/libraryDelta.test.ts tests/unit/device/deviceLibrary.test.ts tests/unit/browse/folderScan.test.ts` plus `pnpm check`. The `vi.mock('$lib/browse/folderScan')` factory must export `scanNativeLibrary`, which is the intended tripwire.
- **Manual check**: on device, rescan and confirm the list is identical; press Rescan and confirm from logcat that the walk is full (`skippedDirs=0`).
- **Revert seam**: this phase alone can be reverted to restore today's behaviour while P1 to P5 stay.

### P7. mtime probe and device-verification section (S7, D11)

- **Files**: `DirectoryReaderPlugin.java` (one log line per skipped directory); `docs/device-verification.md` (new section 21).
- **Change**: probe behind the normal scan path; the doc gains steps, the expected line, and both outcomes.
- **Automated check**: none possible. Compensated by the gradle compile and by pasting a real logcat excerpt into the doc.
- **Manual check**: walk a folder, add an MP3 in a subfolder, rescan, read the probe line; record whether the parent mtime moved.

### P8. Coalesced browse reload, one publish (S8, D8)

- **Files**: `src/lib/browse/browseNavigation.svelte.ts` (`scheduleBrowseEntries` next to, not inside, `loadBrowseEntries`); `src/lib/components/views/Mp3PlayerView.svelte` (reload effect); `src/lib/device/deviceLibrary.svelte.ts` (bump through the boundary); tests.
- **Change**: one scheduled load per frame; the full-walk streaming keeps appending but stops bumping per batch.
- **Automated check**: `pnpm test tests/unit/browse/browseNavigation.test.ts tests/unit/device/deviceLibrary.test.ts` (fake timers: three requests collapse into one; no collapse across frames), then `pnpm test:e2e`.
- **Manual check**: on a large library, the first full scan still fills the list while it runs.

### P9. Prefactor: the search index leaves the view (S9, no decision)

- **Files**: new `src/lib/browse/searchIndex.ts`; `Mp3PlayerView.svelte` effect delegates; new `tests/unit/browse/searchIndex.test.ts`.
- **Change**: move today's logic verbatim, including the length fast path and the shrink reset. Behaviour unchanged.
- **Automated check**: `pnpm test tests/unit/browse/searchIndex.test.ts`, including a test that pins today's equal-length staleness as the current (wrong) behaviour.
- **Manual check**: search in the APK returns the same results before P10.

### P10. Search index keyed on a publish revision (S10, D9)

- **Files**: `src/lib/browse/searchIndex.ts`; `Mp3PlayerView.svelte` (`libraryRevision`); `src/lib/device/deviceLibrary.svelte.ts` (publish sites); `tests/unit/browse/searchIndex.test.ts`.
- **Change**: rebuild on revision change unless the new list is a strict append of the old one; merge on append only.
- **Automated check**: `pnpm test tests/unit/browse/searchIndex.test.ts`, rewriting the pinned staleness test into `replaces the index when one file is added and another removed`.
- **Manual check**: delete one file and add another with the search box open; both changes show up without a reload.

## Ordering, risk, revert

- **Riskiest**: P4 (the merge and prune rules). It is the only place a bug deletes rows the user still has. It is pure and fully tested, which is why it lands before anything calls it.
- **Largest**: P6, three decisions in one place; keep whole, split off `decideScanMode` if it grows past ~400 changed lines.
- **Independently revertable**: P6 (back to full-walk-only), P8 and P10 (cosmetic correctness), P7 (logging plus docs).
- **Must land together**: P1 with P2 (a `sizeBytes` written but not cached is dead weight), P3 with P4 (the payload and its consumer), P9 with P10 (the revision has no seam until the index moves out).

## Deviations from the outline

1. **D1 trigger**: the outline proposed dropping "always full on Rescan" to keep the delta alive. The human chose the full walk on Rescan, so this plan instead adds the warm-start delta trigger and keeps Rescan full. Recorded as an amendment under D1 in `tree.md`.
2. **Plan written in the main window** after the Plan subagent produced no output and wrote no artifact.
3. Everything else follows `outline.md` slice for slice, including its four test-file tripwires.
