# Outline: library-delta

Stage: S (Structure). Inputs: `tree.md` (D1-D11), `research.md`, `ticket.md`.
Tree read at `main`, commit `1c4347e`. Java paths shortened to
`DirectoryReaderPlugin.java` (`android/app/src/main/java/com/maverock24/mobilemediaapp/`).

Ten vertical slices, ordered risk first. Each one leaves the app working and
carries its own check. Gate command per slice is a real `pnpm test <file>`;
`pnpm validate` is the app-level gate before every commit, and `pnpm check`
covers `svelte-check` for every slice that touches a `.svelte` file.

Native verification is the weak spot and is stated plainly per slice: **no
browser check can exercise the SAF walk**, and **no Java test target exists**
(`ExampleUnitTest.java:12-18` is `4 == 2 + 2`; no workflow runs gradle `test`,
`quality.yml:1-205`). The native slices therefore lean on three compensations:
the JS side mocked in vitest, the `android-release-compile` job in
`quality.yml:50` (compile + R8/dex assertion at `:117-201`, whose 26
`@PluginMethod` names are unchanged by this effort), and the on-device probe in
S7.

## Slice map

| # | Slice | Decisions | Needs | Automated check |
|---|---|---|---|---|
| S1 | File size crosses the bridge and the cache | D5 | none | `libraryCache.test.ts` + gradle compile |
| S2 | Cache payload versioned, directory rows preserved by every writer | D6 | S1 | `libraryCache.test.ts`, `fileOps.test.ts` |
| S3 | Walker accepts a previous tree, reports what it walked and skipped | D4 | none | `folderScan.test.ts` + gradle compile |
| S4 | Delta merge as a pure function, with the prune policy | D2 | none | new `libraryDelta.test.ts` |
| S5 | Rescan stops deleting the cache before it walks | D7 | S2 | `deviceLibrary.test.ts` (rescan) |
| S6 | The delta walk runs end to end | D1, D3, D10 | S1-S5 | `deviceLibrary.test.ts`, `libraryDelta.test.ts` |
| S7 | The mtime probe and the device-verification check | D11 | S3, S6 | none, by nature (device only) |
| S8 | Browse reload coalesced, one publish per delta | D8 | S6 | `browseNavigation.test.ts`, `deviceLibrary.test.ts`, `pnpm test:e2e` |
| S9 | Prefactor: the incremental search index leaves the view | none | none | new `searchIndex.test.ts` |
| S10 | Search index keyed on a publish revision | D9 | S6, S9 | `searchIndex.test.ts` |

Every decision D1-D11 sits in exactly one slice. Every slice's dependencies are
earlier slices; nothing reaches forward.

---

## S1. File size crosses the bridge and the cache (D5)

The fingerprint is (mtime, size), so size has to exist on three layers before
any delta can trust it. Ships with no behaviour change.

**Files**
- `DirectoryReaderPlugin.java`: add `COLUMN_SIZE` to `CHILD_PROJECTION` (`:54-59`);
  read it as `cursor.isNull(4) ? 0L : cursor.getLong(4)` at all three readers
  (`:181` scan, `:249` `listEntries`, `:311` `listAudioFiles`); add a `long size`
  parameter to `createFileObject` (`:405-414`) and emit `sizeBytes`. Three call
  sites of `createFileObject` must pass it (easy to miss one: the projection is
  shared, so a missed reader silently reports `0`).
- `src/lib/native/directory-reader.ts`: `NativeDirectoryFile` gains `sizeBytes?: number` (`:3-10`).
- `src/lib/models/music.ts`: the same field on the **second** `NativeDirectoryFile`
  declaration (`:144-151`, duplicated from the file above), on the native variant
  of `StoredAudioFile` (`:10`), on `CachedNativeLibraryFile` (`:59-66`), and passed
  through `createStoredNativeAudioFile` (`:151-161`).
- `src/lib/browse/libraryCache.ts`: `saveCachedLibrary`'s native branch (`:69-76`)
  and `restoreStoredFilesFromCache` (`:115-130`) carry the field.
- `tests/unit/browse/libraryCache.test.ts`, `tests/unit/models/music.test.ts`.

**Change**: additive only. `sizeBytes` is written, read and ignored downstream.

**Check**: `pnpm test tests/unit/browse/libraryCache.test.ts tests/unit/models/music.test.ts`.
Two existing tests use strict `toEqual` against exactly six native keys
(`libraryCache.test.ts:183-193`, `:212-218`) and must gain `sizeBytes`; one new
test, `round-trips sizeBytes from a cached native entry`, proves the field survives
write → load → restore. `pnpm check` proves the type reaches every declaration.
Native side: `pnpm cap:sync:android && (cd android && ./gradlew :app:assembleDebug)`,
plus the CI `android-release-compile` job. Neither proves the value is right.

**On device**: none needed for this slice; a rescan after install must still list
the same files (S7's check covers the walk).

---

## S2. Cache payload versioned, directory rows preserved by every writer (D6)

**Files**
- `src/lib/models/music.ts`: `CachedLibrary` (`:68`) gains `schemaVersion?: number`,
  `completedAt?: number`, `dirs?: CachedLibraryDir[]`; new
  `CachedLibraryDir = { path: string; mtime: number }`.
- `src/lib/browse/libraryCache.ts`: `saveCachedLibrary` (`:52-92`) writes
  `schemaVersion: 1`, `completedAt: Date.now()` and the rows it is given (an
  `dirs` argument, `[]` until S6 supplies real ones); `loadDeviceCachedLibrary`
  (`:101-108`) keeps returning whatever is stored, and gains one predicate
  `hasUsableDirectoryTree(cached)` that S6 consumes (false when `schemaVersion`
  is absent, not `1`, or `dirs` is missing or empty).
- `src/lib/files/fileOps.ts`: `forgetDeletedFile` rewrites the cache through
  `saveCachedLibrary` (`:219`) and would drop `schemaVersion` and `dirs`; the
  rewrite must carry the loaded payload's tree forward, or one delete downgrades
  the next launch to a full walk.
- `src/lib/device/deviceLibrary.svelte.ts`: the three `saveCachedLibrary` call
  sites (`:197`, `:403`, `:432`) pass no tree yet.
- `tests/unit/browse/libraryCache.test.ts`, `tests/unit/files/fileOps.test.ts`.

**Change**: additive and inert. Readers ignore unknown fields, so a legacy payload
still loads (`pendingHandle`/`restoreLocalLibrary` untouched).

**Check**: `pnpm test tests/unit/browse/libraryCache.test.ts tests/unit/files/fileOps.test.ts`.
New tests: `writes schemaVersion 1 with completedAt and the directory rows`,
`restores a legacy payload that has no schemaVersion`,
`keeps the directory rows when a delete rewrites the cache`, and
`reports no usable tree for a payload without schemaVersion`.

---

## S3. Walker accepts a previous tree, reports what it walked and skipped (D4)

The skip decision lives where the queue lives, so this slice makes the native
walker delta-aware. Nothing passes a tree yet, so behaviour is unchanged.

**Files**
- `DirectoryReaderPlugin.java`:
  - `AudioScanSession` (`:74-88`) gains `Map<String,Long> previousDirMtimes`,
    `Map<String,Long> observedDirMtimes`, `int skippedDirs`, `int unreadableDirs`.
  - `startAudioScan` (`:110-147`) reads `prevDirs` via `call.getArray("prevDirs")`
    (confirmed present in the installed `@capacitor/android` 8.2.0,
    `PluginCall.java:295`) into the session map. Each element arrives as a plain
    `JSONObject`, not a `JSObject`, so read it with `optString("path")` /
    `optLong("mtime")`.
  - The child loop (`:174-199`): for a directory row, skip only when a cached
    mtime exists for the path, is greater than `0`, and equals this row's
    `COLUMN_LAST_MODIFIED` (a `0` or absent cached value means unknown, always
    descend). Otherwise queue it and record `observedDirMtimes.put(path, modified)`.
  - Count `unreadableDirs` in the two silent failure paths (`:176`, `:196-198`).
  - The batch (`:206-211`) gains `dirs` (the rows observed during this batch,
    `{path, mtime}`), `skippedDirs` and `unreadableDirs` (both cumulative).
- `src/lib/native/directory-reader.ts`: new `NativeDirectoryDir { path: string; mtime: number }`;
  `startAudioScan` options gain `prevDirs?: NativeDirectoryDir[]`;
  `AudioScanBatchResult` gains the three fields as optional (so the folder-play
  path keeps working against an older APK).
- `src/lib/browse/folderScan.ts`: new `scanNativeLibrary(...)` returning
  `{ files, dirs, unreadableDirs, skippedDirs }` and forwarding `prevDirs`;
  `scanNativeAudioFiles` becomes a thin wrapper returning `.files`, so
  `Mp3PlayerView.svelte:1172` and the existing tests keep their shape. The batch
  callback must fire for a batch that carries directory rows and zero files;
  today `onBatch` fires only when `mappedBatch.length > 0` (`folderScan.ts:79`),
  which would lose every directory row of a files-free batch.
- `tests/unit/browse/folderScan.test.ts`.

**Check**: `pnpm test tests/unit/browse/folderScan.test.ts`.
`startAudioScan` is pinned to exactly `{ treeUri, path }` at `:152` and `:165` and
must gain `prevDirs`; new tests `forwards the previous directory tree`,
`aggregates directory rows from a batch that carried no files`,
`counts an unreadable directory across batches`.
Native: the same gradle compile and dex assertion as S1 (no `@PluginMethod` added
or renamed, so `quality.yml:170-177` stays green).

**No automated check for the Java half**, plainly: the skip logic can only be
exercised by a real `ContentResolver`. Compensations: the mocked JS plumbing
above, the compile job, and S7's on-device probe, which is the only thing that
proves a skip actually happens.

---

## S4. Delta merge as a pure function, with the prune policy (D2)

The one piece of genuine correctness risk. Extracted into a pure module so it can
be tested without a device, a component or the bridge. Written before anything
calls it.

**Files**
- New `src/lib/browse/libraryDelta.ts`: `mergeLibraryDelta({ previous, walked, dirs, skippedDirs, unreadableDirs, completed })`
  returning `{ files, dirs }`.
- New `tests/unit/browse/libraryDelta.test.ts`.

**Rules the tests pin**
1. A walked file is unchanged when `(modifiedAt, sizeBytes)` both match the
   previous entry; keep the previous object, take the new one otherwise.
2. Identity is `relativePath` (`music.ts:114-117`): a rename is one removal plus
   one addition.
3. `completed === false` prunes nothing.
4. `unreadableDirs > 0` prunes nothing for the whole walk (D2), while the
   additions and updates it did observe are kept.
5. **A skipped directory protects its own subtree**: previous files under a
   skipped path are retained even on a completed walk, and pruning only ever
   happens inside subtrees the walk actually visited. This is D2's rule applied
   to skips, and the tree does not state it (see gaps below).
6. Prefix matching is `/`-delimited: `Alpha2/x.mp3` is not under `Alpha`
   (the same trap `libraryCache.test.ts:129` pins for the browse snapshot).

**Check**: `pnpm test tests/unit/browse/libraryDelta.test.ts`, one test per rule
above, plus `an equal-length add plus remove changes the result` (the D9 trap,
seen from the data side) and `an incomplete walk keeps the previous files`.

---

## S5. Rescan stops deleting the cache before it walks (D7)

Small, independent, and it removes the data-loss window that would otherwise make
S6 risky to debug. Tests that pin the old delete-first order change here.

**Files**
- `src/lib/device/deviceLibrary.svelte.ts`: `rescanCurrentLibraryIndex`
  (`:210-226`) stops calling `deleteCachedLibrary` for the derived key and the
  `last-library` mirror (`:218-221`); the cache is replaced only by the completion
  write that already exists (`:197`).
- `tests/unit/device/deviceLibrary.test.ts`: `:277-318` currently asserts the
  ordered deletes and must be rewritten to assert that no delete happens before a
  scan and that a failed scan leaves the stored payload alone.

**Check**: `pnpm test tests/unit/device/deviceLibrary.test.ts -t rescanCurrentLibraryIndex`.
New test `keeps the stored payload when the rescan fails`, and the mirror-key test
becomes `never deletes the last-library key`.

---

## S6. The delta walk runs end to end (D1, D3, D10) — largest slice

Everything above converges here: the index decides which walk to run, hands the
tree over, merges, publishes once, and writes the cache on completion.

**Files**
- `src/lib/browse/libraryDelta.ts`: add the pure decision
  `decideScanMode({ cached, now, encodedTreeBytes })` → `'full' | 'delta'`, with
  `DELTA_TREE_MAX_BYTES` (2 MB of `JSON.stringify(dirs)`) and
  `FULL_WALK_MAX_AGE_MS` (the verification window) as named constants.
- `src/lib/device/deviceLibrary.svelte.ts`:
  - `startLibraryScan` (`:161-207`) takes the previous payload (files, dirs,
    `completedAt`) and a mode; on `delta` it must **not** clear `view.allFiles`
    and must not reset progress to a full-walk shape.
  - `rescanCurrentLibraryIndex` loads the stored payload, calls `decideScanMode`,
    and on `delta` calls `scanNativeLibrary` with `prevDirs`, then
    `mergeLibraryDelta`, then one publish, then one `saveCachedLibrary` with the
    new rows and `completedAt`. On `full` it keeps today's streaming batches.
  - D10: `hydrateTracksFromLibrary` stays behind `!trackListLockedByUser` (`:196`)
    and is skipped when the merge changed nothing.
- `src/lib/browse/libraryCache.ts`: a completed delta that empties the library
  must be writable. Today `saveCachedLibrary` returns before touching IndexedDB
  when the file list is empty (`:83`), so an emptied library keeps its stale
  payload forever; the delta completion path needs an explicit empty write.
- Tests: `tests/unit/device/deviceLibrary.test.ts`, `tests/unit/browse/libraryDelta.test.ts`.

**Fallbacks (D3)** pinned as four test names in the new decision tests and one in
`deviceLibrary.test.ts`: `a cold cache walks in full`, `a payload without
schemaVersion walks in full`, `a tree over the size cap walks in full`,
`a cached walk older than the window walks in full`. The verification window is
the only reader of `completedAt`.

**Check**: `pnpm test tests/unit/browse/libraryDelta.test.ts tests/unit/device/deviceLibrary.test.ts tests/unit/browse/folderScan.test.ts`,
plus `pnpm check`. The `vi.mock('$lib/browse/folderScan')` factory in
`deviceLibrary.test.ts:29-32` must export `scanNativeLibrary` or every test in
that file fails on an undefined import, which is the intended tripwire.

**On device** (no automated substitute): install the debug APK over a library of
a few hundred files, rescan, and confirm the list is identical and the queue
still loads. The first full walk after install must still produce a complete list.

**Should it split?** It carries three decisions and touches two modules plus two
test files, which is the largest of the ten. It should stay one slice: D1, D3 and
D10 all live in `rescanCurrentLibraryIndex` and share one test file, and a split
would produce a delta path with no fallbacks (a corrupted-cache bug factory). If
the implementer finds it over ~400 changed lines, the clean seam is D3's three
fallbacks plus the window (`decideScanMode` and its tests) as a separate preceding
slice, since nothing else reads it.

---

## S7. The mtime probe and the device-verification check (D11)

**Files**
- `DirectoryReaderPlugin.java`: on a delta walk, log one line per skipped
  directory with the mtime it trusted (`android.util.Log`, tag
  `DirectoryReaderPlugin`), behind the existing scan path, no debug flag.
- `docs/device-verification.md`: new section `## 21. A directory's mtime after a
  child changes` in the style of `:37-51`, with the steps (load a folder, note the
  probe log, add an MP3 in a subfolder from a file manager, rescan, read the log),
  the expected line, and the two outcomes: the parent's mtime moved, or it did
  not (which is the finding, not a failure).

**Check**: none automated, and none is possible. No Java test target exists
(`research.md` Q40), the probe is a log line, and the question it answers is
about an Android provider's behaviour on a specific device. Compensations: the
gradle compile and dex assertion, and a recorded logcat excerpt pasted into the
verification doc. This is the slice where `research.md`'s unresolved item 1 gets
settled, and it should be run before the effort is called done.

---

## S8. Browse reload coalesced, one publish per delta (D8)

**Files**
- `src/lib/browse/browseNavigation.svelte.ts`: add `scheduleBrowseEntries(path, filter)`,
  a coalescing wrapper (one scheduled load per frame, with a `setTimeout(...,0)`
  fallback so it does not depend on `requestAnimationFrame` under jsdom). It must
  sit **next to** `loadBrowseEntries`, not inside it: the existing tests
  (`browseNavigation.test.ts:132-215`) await `loadBrowseEntries` and assert the
  entries are already rebuilt, so wrapping that function would break all of them.
- `src/lib/components/views/Mp3PlayerView.svelte`: the reload effect (`:784-790`)
  calls the scheduler instead of `void browseNavigation.loadBrowseEntries(...)`.
- `src/lib/device/deviceLibrary.svelte.ts`: a delta publish is a single
  `view.allFiles` assignment and one bump; the full-walk batch callback (`:178-182`)
  keeps appending but the bump goes through the same coalescing boundary.
- Tests: `tests/unit/browse/browseNavigation.test.ts` (scheduler, fake timers:
  `collapses three requests in one frame into one load`,
  `does not collapse across frames`), `tests/unit/device/deviceLibrary.test.ts`
  (`streams a native scan batch by batch, bumping the browse version and progress`
  at `:223-246` asserts a bump per batch and changes to a coalesced assertion).

**Check**: `pnpm test tests/unit/browse/browseNavigation.test.ts tests/unit/device/deviceLibrary.test.ts`
and `pnpm test:e2e` (the browse list is the one part of this effort the browser
suite really covers).

---

## S9. Prefactor: the incremental search index leaves the view (no decision)

D9 cannot be tested while the logic lives inside a 3,000-line component effect
(`Mp3PlayerView.svelte:240-299`). This slice moves it out with behaviour unchanged,
so S10 has a real check.

**Files**
- New `src/lib/browse/searchIndex.ts`: `buildSearchIndex(allFiles, sortOrder)` and
  `mergeSearchIndex(existing, incoming, sortOrder)`, carrying today's logic
  verbatim, including the length-based fast path, the shrink reset and the
  `{ numeric: true }` merge comparator.
- `src/lib/components/views/Mp3PlayerView.svelte`: the effect keeps its reactive
  reads (`allFiles.length`, every element through the builder, `sortOrder`) and
  delegates to the module.
- New `tests/unit/browse/searchIndex.test.ts`.

**Check**: `pnpm test tests/unit/browse/searchIndex.test.ts` with tests that pin
today's behaviour, including the known bug: `an equal-length replacement leaves
the old index in place` (this test asserts the *current* wrong behaviour and is
the one S10 rewrites). `pnpm check` for the view. No on-device check needed, but
search in the APK must still return the same results before S10 lands.

---

## S10. Search index keyed on a publish revision (D9)

**Files**
- `src/lib/browse/searchIndex.ts`: the update entry point takes a revision
  instead of a length; rebuild when the revision changed and the new list is not
  a strict append of the old one, merge only on a monotone append.
- `src/lib/components/views/Mp3PlayerView.svelte`: a `libraryRevision` counter
  bumped by every publish, in the same place `browseVersion` is bumped
  (`deviceLibrary.svelte.ts:94-95` sink pattern, view side `:446`, `:497`).
- `src/lib/device/deviceLibrary.svelte.ts`: the publish sites bump it.
- `tests/unit/browse/searchIndex.test.ts`.

**Check**: `pnpm test tests/unit/browse/searchIndex.test.ts`, rewriting
`an equal-length replacement leaves the old index in place` into
`replaces the index when one file is added and another removed`, plus
`an in-place replacement is visible to the next search` and
`an append still merges instead of rebuilding`.

---

## No automated check, and why

| Slice | What has no check | Why | Compensation |
|---|---|---|---|
| S1, S3 | the Java read of `COLUMN_SIZE` / the skip comparison | no Java test target (`research.md` Q40); a real `ContentResolver` is needed | mocked `folderScan` tests, gradle compile + dex assertion, S7 device run |
| S3, S6 | that a skip actually happens | the SAF walk cannot run in a browser or in vitest | S7's logcat probe |
| S7 | everything | it is a device observation about an Android provider | the recorded logcat excerpt in `docs/device-verification.md` |

## Design gaps found while slicing

1. **D1 contradicts the end state.** D1 says "always on an explicit Rescan" run a
   full walk, and the end state says "a rescan walks only directories whose mtime
   is new or unknown". The Rescan button is the only trigger a delta could hang
   off (`rescanCurrentLibraryIndex` is its only entry), so the two readings cannot
   both hold. This outline takes the end state as authoritative: Rescan runs the
   delta, the verification window applies, and no path forces a full walk except
   D3's three fallbacks. If the human meant a "force full walk" affordance, that
   is an extra control and belongs in its own ticket.
2. **D4 names only half the payload.** It says the walker reports the directories
   it skipped, but D6's cache needs the tree it *did* walk. The rows must cross
   back per batch, and a batch that carries only directory rows must still reach
   the caller, which today it would not: `onBatch` fires only for non-empty file
   batches (`folderScan.ts:79`). S3 fixes both.
3. **D2 covers unreadable directories, not skipped ones.** A completed walk that
   skipped a subtree must not prune that subtree's files either, or every delta
   after the first deletes most of the library. Rule 5 in S4 is that rule; it is
   not in the tree.
4. **An emptied library cannot be recorded.** `saveCachedLibrary` returns early
   on an empty file list (`libraryCache.ts:83`), so a completed delta that removes
   the last file writes nothing and the stale payload survives. S6 has to allow
   that one empty write. That is new behaviour beyond D6/D7 and worth a line in
   the PR.
5. **Every cache writer must carry the tree.** `forgetDeletedFile` rewrites the
   cache through `saveCachedLibrary` (`fileOps.ts:219`); without S2's change one
   delete silently downgrades the next launch to a full walk.
6. **`NativeDirectoryFile` is declared twice** (`native/directory-reader.ts:3-10`
   and `models/music.ts:144-151`). D5 must touch both or `sizeBytes` is dropped at
   one boundary.
7. **The 2 MB cap has no stated metric.** S6 measures `JSON.stringify(dirs)` and
   ignores bridge encoding overhead, so the effective real cap is lower. A named
   constant with a comment is enough; the cap is a guard, not a threshold.
8. **Directory mtime trust is still unverified.** Everything in S1-S6 assumes a
   provider may or may not move a parent's mtime on a child change; D11 is the
   only thing that settles it, and only by observation.

## Largest slice

S6. It carries D1, D3 and D10 and touches `deviceLibrary.svelte.ts`,
`libraryDelta.ts` and `libraryCache.ts`. Reasoning on whether to split it is in
the slice itself: keep it whole, with the `decideScanMode` seam named in case it
grows past ~400 changed lines.
