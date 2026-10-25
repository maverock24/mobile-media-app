# Work tree: library-delta

- **Slug**: library-delta
- **Worktree**: `/home/maverock24/github/mobile-media-app-delta`
- **Branch**: `qrspi/library-delta`, from `main` at `1c4347e`
- **Commit trailer**: `QRSPI: library-delta`
- **Gate per task**: `pnpm check && pnpm test`; `pnpm test:e2e` once before the final commit
- **Native check**: `pnpm cap:sync:android && (cd android && ./gradlew :app:assembleDebug)`

One task per plan phase. One commit per task. Blocked-by edges below are acyclic.

| Task | Phase | Files touched | Blocked by | Check |
|---|---|---|---|---|
| T1 | P1 size crosses bridge and cache | `DirectoryReaderPlugin.java`, `native/directory-reader.ts`, `models/music.ts`, `browse/libraryCache.ts` | none | `pnpm test tests/unit/browse/libraryCache.test.ts tests/unit/models/music.test.ts` |
| T2 | P2 cache payload versioned | `models/music.ts`, `browse/libraryCache.ts`, `files/fileOps.ts`, `device/deviceLibrary.svelte.ts` | T1 | `pnpm test tests/unit/browse/libraryCache.test.ts tests/unit/files/fileOps.test.ts` |
| T3 | P3 walker takes a previous tree | `DirectoryReaderPlugin.java`, `native/directory-reader.ts`, `browse/folderScan.ts` | T1 (shared Java and bridge files) | `pnpm test tests/unit/browse/folderScan.test.ts` |
| T4 | P4 delta merge pure function | new `browse/libraryDelta.ts`, new `tests/unit/browse/libraryDelta.test.ts` | none | `pnpm test tests/unit/browse/libraryDelta.test.ts` |
| T5 | P5 rescan stops deleting first | `device/deviceLibrary.svelte.ts`, `tests/unit/device/deviceLibrary.test.ts` | T2 | `pnpm test tests/unit/device/deviceLibrary.test.ts -t rescanCurrentLibraryIndex` |
| T6 | P6 delta walk end to end | `browse/libraryDelta.ts`, `device/deviceLibrary.svelte.ts`, `browse/libraryCache.ts` | T1, T2, T3, T4, T5 | `pnpm test tests/unit/browse/libraryDelta.test.ts tests/unit/device/deviceLibrary.test.ts tests/unit/browse/folderScan.test.ts` |
| T7 | P7 mtime probe and device check | `DirectoryReaderPlugin.java`, `docs/device-verification.md` | T3, T6 | gradle compile only |
| T8 | P8 coalesced browse reload | `browse/browseNavigation.svelte.ts`, `views/Mp3PlayerView.svelte`, `device/deviceLibrary.svelte.ts` | T6 | `pnpm test tests/unit/browse/browseNavigation.test.ts tests/unit/device/deviceLibrary.test.ts` |
| T9 | P9 search index leaves the view | new `browse/searchIndex.ts`, `views/Mp3PlayerView.svelte`, new `tests/unit/browse/searchIndex.test.ts` | none | `pnpm test tests/unit/browse/searchIndex.test.ts` |
| T10 | P10 search index revision-keyed | `browse/searchIndex.ts`, `views/Mp3PlayerView.svelte`, `device/deviceLibrary.svelte.ts` | T6, T9, T8 (shared view file) | `pnpm test tests/unit/browse/searchIndex.test.ts` |

## Waves (what can run at once without two workers editing one file)

- **Wave 1**: T1, T4, T9 (disjoint file sets).
- **Wave 2**: T2, T3 (T3 shares Java and bridge types with T1, so it waits for T1).
- **Wave 3**: T5.
- **Wave 4**: T6.
- **Wave 5**: T7 and T8 (disjoint), then T10 (shares `Mp3PlayerView.svelte` and `deviceLibrary.svelte.ts` with T8).
