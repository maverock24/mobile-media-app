# Questions: library-delta

Stage: Q (Questions). For each question the Research stage must answer with `file:line`
evidence from the current tree (branch `main`, commit `1c4347e`). The
`qrspi/library-delta` worktree from decision D4 does not exist yet, so all pointers
below were read in the main checkout. Nothing here proposes a design.

Pointer convention: paths are repo relative. Java paths are shortened to
`DirectoryReaderPlugin.java` =
`android/app/src/main/java/com/maverock24/mobilemediaapp/DirectoryReaderPlugin.java`.

---

## 1. What the native scan can and cannot report per directory

- **Q1. What exactly does one native scan batch contain, and in what unit?**
  Read `DirectoryReaderPlugin.java:145-221` (`getAudioScanBatch`), `:72-84`
  (`AudioScanSession`: `pendingDirs`, `foldersScanned`), `:201-217` (the result
  fields), `src/lib/native/directory-reader.ts:29-40` (`AudioScanBatchResult`),
  `src/lib/browse/folderScan.ts:70-88`. Which counters are per directory and which
  per file, and which of them are cumulative versus per batch?

- **Q2. Which directory-level facts ever cross the bridge to JavaScript?**
  Read the projection at `DirectoryReaderPlugin.java:54-59`, the file object built
  at `:405-414`, the folder object built by `listEntries` at `:254-258`, and the
  TypeScript mirrors `src/lib/native/directory-reader.ts:3-21`. Does any payload
  carry a directory's own document id, mtime, or child count? Is `COLUMN_DOCUMENT_ID`
  ever surfaced (it is read at `:178`, `:246`, `:308` and used only to build a URI at
  `:191`, `:264`, `:321`, `:389`)?

- **Q3. Where could a directory's mtime come from at all today?**
  A directory's mtime is only visible as a child row of its parent's cursor read
  (`:181`, `:249`, `:311`). Read `:388-398` (`queryDisplayName`) and `:108-143`
  (`startAudioScan`) to confirm what is queried for the tree root itself. Can the
  current protocol learn the mtime of the scan root, or of any directory, before
  descending into it?

- **Q4. How does the scan represent a directory it could not read?**
  Read the `cursor == null` skips at `:176` and `:306`, the swallowed exceptions at
  `:196-198` and `:325-328`, and the counter increments at `:172` and `:201-217`.
  Can a caller distinguish "directory had no children" from "directory failed"? Does
  `foldersScanned` count a directory whose query threw? Is any error ever returned in
  a resolved batch?

- **Q5. Is file size available on the native path?**
  Read `CHILD_PROJECTION` at `DirectoryReaderPlugin.java:54-59`, `createFileObject`
  at `:405-414`, `NativeDirectoryFile` at `src/lib/native/directory-reader.ts:3-11`,
  `StoredAudioFile` native variant at `src/lib/models/music.ts:10`,
  `CachedNativeLibraryFile` at `src/lib/models/music.ts:59-66`. Is `COLUMN_SIZE`
  queried anywhere in the file, and is any size field carried on any native type?

- **Q6. How is an absent mtime represented end to end?**
  Read `cursor.isNull(3) ? 0L : cursor.getLong(3)` at `DirectoryReaderPlugin.java:181`
  (also `:249`, `:311`), `createStoredNativeAudioFile` at `src/lib/models/music.ts:147-157`,
  the cache write at `src/lib/browse/libraryCache.ts:69-81`, and the restore at
  `:115-130`. What value lands in `modifiedAt` when the provider returns null, and can
  any consumer tell that apart from a real timestamp?

- **Q7. What traversal order and batching guarantees does the session give?**
  Read the queue at `DirectoryReaderPlugin.java:72-84` (`ArrayDeque`, `addLast` at
  `:81`, `:185`), the batch loop at `:170-199`, and the comment at `:167-169` about a
  directory's files never being split. Is the walk breadth first? Can a batch contain
  files from many directories? Is `done` set only when the queue empties (`:201-204`)?

- **Q8. Does the protocol report absences, or only presence?**
  Read the whole of `DirectoryReaderPlugin.java` for any tombstone, deleted, or
  diff field. What is the only evidence a caller has that a file no longer exists?

- **Q9. Can a scan be started at an arbitrary subtree without a name path?**
  Read `startAudioScan` at `DirectoryReaderPlugin.java:108-143` (it accepts
  `treeUri` and `path`) and `resolveDocumentId` at `:345-386`. What does starting at a
  document id require today, what does each path segment cost, and what happens if a
  name repeats or a directory was renamed?

- **Q10. Which listing path does each caller use, and what does each cost?**
  Read `listEntries` at `DirectoryReaderPlugin.java:224-279`, `listAudioFiles` at
  `:281-343`, `startAudioScan`/`getAudioScanBatch` at `:108-221`; then the callers:
  `src/lib/browse/browseNavigation.svelte.ts:130-200` (live single-level listing),
  `src/lib/browse/folderScan.ts:108-114` (`pickNativeAudioDirectory`),
  `src/lib/components/views/Mp3PlayerView.svelte:1159-1210` (folder playback scan),
  `src/lib/device/deviceLibrary.svelte.ts:161-208` (index scan). Which of the three
  returns folder mtimes, and which of them can be used mid-scan without disturbing a
  running session?

- **Q11. Where is the set of accepted extensions duplicated, and what happens when the
  two disagree?**
  Read `SUPPORTED_AUDIO_EXTENSIONS` and `isSupportedAudioFile` at
  `DirectoryReaderPlugin.java:38-46` against `src/lib/models/music.ts:85-95`. Which
  side filters what, and which side is authoritative for a file the other one rejects?

## 2. Provider behaviour and mtime trust

- **Q12. What does the code assume about `COLUMN_LAST_MODIFIED`, and where is
  `modifiedAt` actually consumed?**
  Grep `modifiedAt` across `src/`. It is stored and forwarded
  (`src/lib/browse/libraryCache.ts:76`, `:127`, `src/lib/models/music.ts:154`) and read  by `src/lib/favorites/favoriteTracks.ts:146-190`, `src/lib/audio/fileResolver.ts:82`,
  `src/lib/drive/driveLibrary.ts:376-384`. Is it ever compared between two observations
  of the same file? Is it ever used to decide that something is unchanged?

- **Q13. What does the repo record about providers that do not populate mtime, or
  populate it coarsely?**
  Read `docs/device-verification.md` §1 (lines 37-52) and §19 (lines 304-320),
  `docs/adr/0002-file-move-copy-delete.md`, and any comment in
  `DirectoryReaderPlugin.java` about provider variance. Also check the test fixtures:
  `tests/unit/browse/folderScan.test.ts:137-220` and
  `tests/unit/browse/libraryCache.test.ts:172-260`. Is there any fixture that models a
  null, zero, or unchanged mtime? Android platform behaviour (what a SAF provider may
  legally return for `COLUMN_LAST_MODIFIED`) is not in this repo, so the Research stage
  must cite the platform docs for that half of the answer and say plainly which claims
  are repo evidence and which are platform reference.

- **Q14. What else could identify an unchanged directory if mtime is not usable?**
  Read `resolveDocumentId` at `DirectoryReaderPlugin.java:345-386` and the folder
  object at `:254-258`. Is there any value today that is stable across renames and
  restarts, and does any of it survive to the cache
  (`src/lib/models/music.ts:59-68`)?

- **Q15. What does the app do today when a scan cannot proceed at all?**
  Read the reject at `DirectoryReaderPlugin.java:154-155` ("Audio scan session not
  found"), `src/lib/browse/folderScan.ts:91-99`, the catch at
  `src/lib/device/deviceLibrary.svelte.ts:198-207`, `restoreLocalLibrary`'s catch at
  `:282-302`, and `reconnectFolder` at `:441-464`. What reaches the user, and what
  reaches `allFiles`?

## 3. The cache: what it holds and how old entries are read

- **Q16. What exactly is persisted per file and per library?**
  Read `CachedLibrary` and `CachedLibraryFile` at `src/lib/models/music.ts:59-68`,
  the write mapping at `src/lib/browse/libraryCache.ts:52-94`. Enumerate the fields.
  Is there a scan-completion flag, a directory list, a tree URI, or a schema version?

- **Q17. How is the cache key derived, and where is it mirrored?**
  Read `getDeviceLibraryCacheKey` at `src/lib/browse/libraryCache.ts:41-45`,
  `LAST_LIBRARY_CACHE_KEY` at `:35`, `saveCachedLibrary` at `:52-94`, the fallback in
  `loadDeviceCachedLibrary` at `:101-108`, and `src/lib/utils/idb.ts:77-93`. When two
  keys hold the same payload, which one is authoritative on load?

- **Q18. How is an old cached entry read, and what shape tolerance exists?**
  Read `loadCachedLibrary` at `src/lib/utils/idb.ts:77-86` (no version check) and
  `loadDeviceCachedLibrary` at `src/lib/browse/libraryCache.ts:101-108`, plus
  `openIDB` at `src/lib/utils/idb.ts:44-59` (db version 2, no per-store schema).
  Is there any migration, version field, or defensive parse? What happens today if a
  stored payload lacks a field that the current readers expect?

- **Q19. Is `savedAt` ever read?**
  Grep `savedAt`. It is written at `src/lib/browse/libraryCache.ts:86` and typed at
  `src/lib/models/music.ts:68`; the only reader is the Drive cache TTL at
  `src/lib/utils/idb.ts:118-131`. Does anything treat a device cache as stale today?

- **Q20. Who writes the device cache, with which key and which file list?**
  Read `src/lib/device/deviceLibrary.svelte.ts:197` (scan end),
  `:407` and `:434` (hidden inputs, `treeUri` null),
  `src/lib/components/views/Mp3PlayerView.svelte:1219-1225` (root folder-play scan),
  `src/lib/files/fileOps.ts:201-233` (delete rewrite). Which of these write a partial
  list, and which write a full listing?

- **Q21. What happens when the library is empty?**
  Read the early return at `src/lib/browse/libraryCache.ts:83`, the delete-then-drop
  path in `src/lib/files/fileOps.ts:226-233`, and the empty-cache branches in
  `src/lib/device/deviceLibrary.svelte.ts:257-263`, `:341-347`, `:381-386`. Can an
  empty result ever be written, and can a stale cache survive a now-empty folder?

- **Q22. Would an extra field on the cached payload break existing readers?**
  Read `src/lib/utils/idb.ts:24-33` (`idbPut` stores arbitrary objects) and the web
  branch of `saveCachedLibrary` at `src/lib/browse/libraryCache.ts:59-68` (a real
  `File` is stored). Does IndexedDB structured clone preserve unknown fields and
  `File` objects here, and does any existing reader reject an unexpected key?

- **Q23. What deletes cache entries today, and is deletion ever reversible?**
  Read `deleteCachedLibrary` at `src/lib/utils/idb.ts:88-96` and its callers:
  `src/lib/device/deviceLibrary.svelte.ts:213-218`, `src/lib/files/fileOps.ts:226-233`.
  What is lost if a delete lands and the following scan never completes?

## 4. How the index, browse list, search index and queue react to mutation

- **Q24. What rebuilds the browse list, and what does a rebuild read?**
  Read the effect at `src/lib/components/views/Mp3PlayerView.svelte:784-792` and
  `loadBrowseEntries` at `src/lib/browse/browseNavigation.svelte.ts:108-200`. Which
  reactive reads inside the loader register as dependencies (library source, sort
  order, `allFiles`, `libraryScanPromise`, handles)? Is the reload triggered per
  `bumpBrowseVersion` call, per `allFiles` write, or both?

- **Q25. Where do folder counts come from, and what does a partial index show?**
  Read `buildBrowseEntries` at `src/lib/models/browse.ts:15-44` and the live-listing
  branches that set `count: 0` at
  `src/lib/browse/browseNavigation.svelte.ts:146-150`, `:186-190`. Which branch wins
  when the index has entries for the current path (`:130-142`)?

- **Q26. How does the incremental search index decide what is new?**
  Read `src/lib/components/views/Mp3PlayerView.svelte:239-302`, especially the length
  comparison at `:249-250`, the full rebuild at `:259-263`, the tail slice at `:265-271`,
  and `mergeSortedIndex` at `:276-301`. What happens if `allFiles` keeps the same length
  but changes contents, if an entry is replaced in place, or if removals and additions
  balance out? What happens if `allFiles` shrinks by one and then grows back by one
  between two effect runs?

- **Q27. What reacts to `allFiles` shrinking today?**
  Read `src/lib/files/fileOps.ts:205-213` and the search-index reset comment at
  `src/lib/components/views/Mp3PlayerView.svelte:246-250`, plus the selection-pruning
  effect at `:793-811` (it prunes against `allFiles`, `:800-801`). Which of these
  depend on array identity versus length versus contents?

- **Q28. What happens to the playing queue when the index changes?**
  Read `hydrateTracksFromLibrary` at `src/lib/components/views/Mp3PlayerView.svelte:116-147`,
  its guarded call at `src/lib/device/deviceLibrary.svelte.ts:196`, `beginQueue` at
  `Mp3PlayerView.svelte:1103-1109` and `appendTracksToQueue` at `:1149-1153`, and the player API at
  `src/lib/audio/player.svelte.ts:528-575` (`play`, `load`, `append`) with
  `loadQueue` at `:292-330`. Does the player expose any remove or in-place update?
  Does the queue hold the same array as `allFiles` or a copy?

- **Q29. What is the identity key everything hangs off, and what happens on rename or
  move?**
  Read `getStoredFileKey` at `src/lib/models/music.ts:114-117`, `mergeStoredFiles` at
  `:230-241`, the player's keyed merge at `src/lib/audio/player.svelte.ts:545-566`,
  and the persisted resume key `lastTrackKey` at `src/lib/stores/settings.svelte.ts:46`
  with its use at `Mp3PlayerView.svelte:138-146`. Which consumers would see a renamed
  file as a different file, and which as the same?

## 5. Cancellation, interruption, concurrency

- **Q30. What cancels a scan today, and when?**
  Read the `finally` at `src/lib/browse/folderScan.ts:91-99` with its
  `cancelAudioScan` call at `:94`, the completion flag at `:62`/`:83-88`, and the
  coverage at `tests/unit/browse/folderScan.test.ts:197-220`. Is there any path that
  cancels a running native session from outside `scanNativeAudioFiles`?

- **Q31. What happens when a second scan starts while one is running?**
  Read `src/lib/device/deviceLibrary.svelte.ts:161-208`, especially the stale-callback
  guard at `:177` and the promise swap at `:191-206`. Is the first native session
  cancelled, or does it keep draining batches that are then discarded?

- **Q32. What interrupts a scan when the screen, the app, or the deck changes?**
  Read the mount effect at `src/lib/components/views/Mp3PlayerView.svelte:1539-1603`,
  the unmount cleanup at `:1613`, the rescan listener at `:1606-1611`, and the
  focus/visibility handlers installed at `:1524-1529`. Is anything wired to `visibilitychange`,
  Capacitor app-state, or component destroy that stops or resumes a scan?

- **Q33. Can two native scans of the same tree run at once?**
  Compare the index scan at `src/lib/device/deviceLibrary.svelte.ts:176` with the
  folder-playback scan at `src/lib/components/views/Mp3PlayerView.svelte:1159-1210`.
  Both call `startAudioScan`, which allocates a fresh session id
  (`DirectoryReaderPlugin.java:129-131`). What stops them colliding, and what stops
  one from overwriting the other's `allFiles`?

- **Q34. What marks a scan as complete for its caller, and what happens on a mid-scan
  failure?**
  Read `done` at `DirectoryReaderPlugin.java:201-204`, `scanCompleted` in
  `src/lib/browse/folderScan.ts:62-96`, and the reject paths in
  `src/lib/device/deviceLibrary.svelte.ts:199-206`. On a failure, is anything cached,
  is `allFiles` left holding the partial batches it already received
  (`:178`), and does the queue get hydrated?

## 6. Entry points that scan or restore

- **Q35. Enumerate every trigger of a scan or a cache restore.**
  Read: the mount restore effect at `src/lib/components/views/Mp3PlayerView.svelte:1539-1603`;
  `openLocalSourceButton` and `restoreLocalLibrary` at
  `src/lib/device/deviceLibrary.svelte.ts:230-302`; `openFolder` at `:310-391`;
  `reconnectFolder` at `:441-464`; the first-search effect at
  `Mp3PlayerView.svelte:342-348`; the rescan event chain
  `src/lib/components/views/SettingsView.svelte:765` →
  `src/lib/stores/musicView.svelte.ts:36-47` → `Mp3PlayerView.svelte:1606-1611` →
  `deviceLibrary.svelte.ts:210-226`; the YouTube save at
  `src/lib/components/ui/YoutubePanel.svelte:426`; and the root folder-play scan at
  `Mp3PlayerView.svelte:1219-1225`. Which of these start a scan, which only restore a
  cache, and which do both?

- **Q36. What runs on a cold app start on Android, in what order, and what is left
  empty?**
  Read `Mp3PlayerView.svelte:1539-1603` and `deviceLibrary.svelte.ts:239-264`. Trace
  the case where `musicSettings.nativeTreeUri` is set but the cache is empty or
  missing: does anything start a scan at mount, what does `hasFolderLoaded`
  (`Mp3PlayerView.svelte:589`) evaluate to, and what does the browse list show
  (`browseNavigation.svelte.ts:177-193`)?

- **Q37. What does a rescan do to the cache before it scans, and what is the failure
  mode?**
  Read `rescanCurrentLibraryIndex` at `src/lib/device/deviceLibrary.svelte.ts:210-226`
  and `startLibraryScan`'s reset at `:161-173`, plus
  `tests/unit/device/deviceLibrary.test.ts:277-318`. If the scan that follows the
  delete fails or the app is killed, what remains on disk and in IndexedDB?

- **Q38. Does anything verify a restored cache against the device after mount?**
  Read the restore branches at `src/lib/device/deviceLibrary.svelte.ts:257-260`,
  `:294-298`, `:343-347`, `:381-386` and `Mp3PlayerView.svelte:1564-1572`. After a
  restore, is any background refresh scheduled, and can a file deleted while the app
  was closed ever leave the restored index?

## 7. What the tests and CI already pin

- **Q39. Which existing tests constrain this change?**
  Read the `describe` blocks in `tests/unit/device/deviceLibrary.test.ts:206-318`
  (streaming batches, `bumpBrowseVersion` per batch, queue lock, rescan deletes both
  keys), `tests/unit/browse/libraryCache.test.ts:211-260` (key derivation, mirroring,
  empty and drive-only writes), `tests/unit/browse/folderScan.test.ts:137-220`
  (batching, cancellation on reject), `tests/unit/browse/browseNavigation.test.ts:132-215`
  (snapshot versus live listing), `tests/unit/files/deleteUpdatesView.test.ts:102-130`,
  and `tests/unit/utils/idb.test.ts:48-57`. Which of them would fail if batches stopped
  bumping `browseVersion`, if rescan stopped clearing the cache, or if the cache payload
  gained fields?

- **Q40. Is the Java plugin covered by any test at all?**
  Read `android/app/src/test/java/com/getcapacitor/myapp/ExampleUnitTest.java` and
  `android/app/src/androidTest/java/com/getcapacitor/myapp/ExampleInstrumentedTest.java`.
  Is there any mock `ContentResolver`, provider fixture, or Robolectric setup in the
  repo (grep `robolectric`, `MockCursor`, `shadowOf`)? What is the only automated
  guarantee about the plugin's shape?

- **Q41. What does CI actually compile and run for the scan path?**
  Read `.github/workflows/quality.yml` (`android-release-compile` job from line 50:
  `assembleRelease` at line 96-100, the DEX method-name assertion from line 128, and
  the `DirectoryReaderPlugin` method list in the `METHODS` map) plus the `quality` job
  at lines 3-49. Is any Java test executed, and which JS suites run on a pull request?
  Note: `AGENTS.md` says no workflow compiles Java on a pull request, which the job at
  `quality.yml:50` contradicts; record which is true.

- **Q42. Is there an ADR or state spec for the library index or the scan lifecycle
  that this change must extend?**
  List `docs/adr/` (0001 player module, 0002 file move/copy/delete, 0003 YouTube audio)
  and `docs/state/_index.md` (four machines: audio playback, Drive auth, sleep timer,
  YouTube). Is the scan or cache lifecycle described anywhere, and where would a new
  state or invariant be recorded?

---

## Done criteria for this stage

Every question above is answerable with `file:line` evidence from the current tree,
except Q13's platform-reference half, which must be split into repo evidence plus a
cited Android source. The set is complete when a design can be settled on the answers
alone, in particular: the exact per-directory facts the walk can return (Q1-Q3, Q6),
what a failed directory looks like (Q4, Q15), the current cache contract and its
forward-compatibility (Q16-Q22), how each consumer reacts to a mutation of the index
(Q24-Q29), what cancellation and completion mean (Q30-Q34), and which entry points must
keep their current behaviour (Q35-Q38).
