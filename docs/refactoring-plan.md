# Refactoring plan

- Status: active, PR 1 open
- Base: `main` at `8dc7495`
- Branch per PR: `refactor/dead-code`, `refactor/adr-0001-player`, `refactor/mp3-drive-domain`, ...
- Scope: `src/` only. `android/` is out of scope.
- Rule: every PR is behaviour-preserving. Store APIs stay source-compatible.
- Gate: `pnpm check && pnpm test` on every commit, `pnpm test:e2e` before merge,
  and Playwright is mandatory on the player-migration PR.

## Goal

Shrink the codebase by removing dead code and by reducing the complexity
concentrated in `src/lib/components/views/Mp3PlayerView.svelte`. This plan does
not chase playback defects; it removes code and moves it to where it can be
tested.

## Where the code stands

`src/` holds 68 TypeScript and Svelte files, 16,599 lines.

| file | lines | parsed functions | analyzer complexity |
| --- | --- | --- | --- |
| `src/lib/components/views/Mp3PlayerView.svelte` | 4,578 | 371 | 751 |
| `src/lib/components/views/PodcastView.svelte` | 1,400 | 95 | 242 |
| `src/lib/components/views/SettingsView.svelte` | 1,291 | 31 | 71 |
| `src/lib/components/ui/MiniPlayer.svelte` | 461 | 20 | 53 |
| `src/lib/components/views/RadioView.svelte` | 413 | 20 | 37 |
| `src/lib/stores/mediaEngine.svelte.ts` | 832 | | |
| `src/lib/google-drive.ts` | 703 | | |
| `src/lib/audio/player.svelte.ts` | 418 | | |

Function counts and complexity scores come from the `codedeck-analysis.json`
snapshot of 2026-09-06, so treat the scores as a rough ordering, not as a
measurement. Line counts are from `HEAD`.

Playback helpers are copied across files, which is the reason a single player
fix costs four edits:

| function | copies |
| --- | --- |
| `safePlay` | `src/lib/audio/player.svelte.ts:115`, `src/lib/components/views/Mp3PlayerView.svelte:853`, `src/lib/components/views/PodcastView.svelte:144`, `src/lib/components/ui/YoutubePanel.svelte:119` |
| `togglePlay` | `src/lib/components/views/PodcastView.svelte:908`, `src/lib/components/views/RadioView.svelte:93`, `src/lib/components/ui/YoutubePanel.svelte:429`, plus a dead copy at `src/lib/components/views/Mp3PlayerView.svelte:3127` |
| `pausePlayback` | `src/lib/components/views/Mp3PlayerView.svelte:3139`, `src/lib/components/views/PodcastView.svelte:916`, `src/lib/components/views/RadioView.svelte:101` |

## The programme

### PR 1: verified dead code (this branch)

Fifteen functions with no reference anywhere in `src/`, `tests/`, `scripts/` or
the root config files. The proof method is at the bottom of this file.

| file:line | function | note |
| --- | --- | --- |
| `src/lib/components/AuroraBackground.svelte:91` | `getMoonAlpha` | superseded by the inline moon math below it |
| `src/lib/components/ui/MiniPlayer.svelte:153` | `handleSeekInput` | `PlayerControls` has the live one |
| `src/lib/components/views/Mp3PlayerView.svelte:1664` | `isCurrentFolderFavorited` | feature-shaped, see below |
| `src/lib/components/views/Mp3PlayerView.svelte:1670` | `toggleCurrentFolderFavorite` | feature-shaped |
| `src/lib/components/views/Mp3PlayerView.svelte:1851` | `cancelDriveLoad` | feature-shaped |
| `src/lib/components/views/Mp3PlayerView.svelte:1993` | `signOutGoogleDrive` | feature-shaped |
| `src/lib/components/views/Mp3PlayerView.svelte:2847` | `navigateLocalPickerUp` | feature-shaped |
| `src/lib/components/views/Mp3PlayerView.svelte:2947` | `navigateDrivePickerInto` | feature-shaped |
| `src/lib/components/views/Mp3PlayerView.svelte:2952` | `navigateDrivePickerUp` | feature-shaped |
| `src/lib/components/views/Mp3PlayerView.svelte:3127` | `togglePlay` | dead copy; the live handlers are `resumePlayback` and the markup |
| `src/lib/components/views/Mp3PlayerView.svelte:3228` | `selectTrack` | dead copy |
| `src/lib/components/views/Mp3PlayerView.svelte:3432` | `handleSeekInput` | dead copy |
| `src/lib/components/views/Mp3PlayerView.svelte:3436` | `handleSeekCommit` | dead copy |
| `src/lib/components/views/PodcastView.svelte:967` | `handleSeek` | dead copy |
| `src/lib/components/views/RadioView.svelte:93` | `togglePlay` | dead copy; `pausePlayback`/`resumePlayback` are the live pair |

"Feature-shaped" means the function is the only remaining implementation of
something a user could once do: signing out of Google Drive, cancelling a Drive
load, walking up a folder picker, favouriting a folder. Nothing calls them, so
removing them removes the capability, not just the code. Git history keeps them;
if the capability is wanted back, restore it deliberately rather than leaving
dead copies around.

Left in place by choice, because they are exported helpers rather than local
leftovers: `src/lib/utils/storage.ts:22 setJSON` and `:31 removeJSON`.

### PR 1b: dead-code follow-up (delivered)

Landed as branch `refactor/dead-code-followup` on top of `5e4e48f`, in two
commits.

- `Mp3PlayerView.svelte`: deleted `currentFolderAsFavorite` (zero callers) and
the write-only `driveLoadProgress` state, 29 lines.
- `src/lib/stores/library.svelte.ts`: deleted the whole dead `LibraryStore`
class and `export const library = new LibraryStore()`, keeping only the
`StoredAudioFile` and `BrowseEntry` types that `src/lib/models/browse.ts:1`,
`src/lib/audio/fileResolver.ts:5` and `tests/unit/models/browse.test.ts:3-4`
import. The five imports the class alone used are gone.
- The file keeps its `.svelte.ts` name. The only reference to it beyond the
three type importers is the gitignored analyzer snapshot
`codedeck-analysis.json`, so the rename to `library.ts` is left for a later
pass.

### PR 2: wire the ADR-0001 player module

ADR-0001 (`docs/adr/0001-player-module.md`, accepted 2026-08-22) decided this
already. The module landed in commit `af3f6e5` and is complete with tests, but
nothing in `src/` calls it: the only caller of `createPlayer`
(`src/lib/audio/player.svelte.ts:88`) is
`tests/unit/models/player.test.ts:43`. `Mp3PlayerView.svelte` still binds its own
`<audio bind:this={audioEl}>` and keeps its own `safePlay` at line 853.

Work: construct one `createPlayer` instance per deck inside `Mp3PlayerView`,
supply the `resolveUrl` adapter, bind the view to `player.state`, then delete the
in-view playback copies. Scanning, Drive auth, favourites and folder pickers stay
where they are; PR 3 to PR 5 move those separately.

The landmine: the module never calls `claimAudio` (zero hits in
`src/lib/audio/player.svelte.ts`) while `guardrails.md` requires every audio
source to register a stop callback with `mediaEngine`. Deck A and Deck B would
both keep playing. The view must register the module's `pause()` with
`registerAudioSource`, and the migration PR must prove exclusivity with e2e.

### PR 3: Drive and folder-picker domain (eight extractions)

Replaces the earlier single-step PR 3. Each extraction is its own
behaviour-preserving PR, listed in dependency order, and each depends only on
the earlier ones. Function names are in
`src/lib/components/views/Mp3PlayerView.svelte` unless a target module is
named. Line ranges are anchors from the recon snapshot (`/tmp/pr3-recon.md`),
taken before the dead-code follow-up above; treat them as anchors, not current
offsets.

**3.1 `driveSession` (`src/lib/drive/driveSession.svelte.ts`).**
`hasValidDriveToken` (1259-1261), `ensureDriveAccessToken` (1263-1319) and the
`formatDriveAuthError` alias (1178). Takes the `driveAccessToken`,
`driveTokenExpiresAt`, `driveUser` and `driveError` state. `googleDriveSession`
stays the persistence owner.

**3.2 `libraryCache` (`src/lib/browse/libraryCache.ts`, pure).**
`getDeviceLibraryCacheKey` (104-114, taking `treeUri` as a parameter instead of
the `nativeTreeUri` default), `saveCachedLibrary` (115-152),
`loadDeviceCachedLibrary` (153-160), `restoreStoredFilesFromCache` (162-179),
`collectStoredFilesFromSnapshot` (1065-1071), `pathToString` (798-800),
`collectFilesFromDirHandle` (1932-1942), `collectStoredFilesFromDirHandle`
(1944-1960), `resolveDirAtPath` (1961-1976).

**3.3 `folderScan` (`src/lib/browse/folderScan.ts`, pure).** `yieldScanToUi`
(1072-1075), `scanNativeAudioFiles` (1077-1126), `collectAllFromPath`
(1977-1999), `pickNativeAudioDirectory` (1826-1838). Driven by injected
`{ nativeTreeUri, rootDirHandle, onBatch }`.

**3.4 `folderPicker` (`src/lib/drive/folderPicker.svelte.ts`).**
`hasPendingDriveFolderPickerIntent` (1180-1186), `markDriveFolderPickerPending`
(1188-1194), `clearPendingDriveFolderPickerIntent` (1196-1202),
`restorePendingDriveFolderPickerIfNeeded` (1204-1233),
`schedulePendingDriveFolderPickerRestore` (1235-1248),
`clearPendingDriveFolderPickerRestoreTimers` (1250-1257), `openFolderPicker`
(1396-1402), `loadFolderPickerLevel` (1404-1429), `navigateFolderPickerInto`
(1431-1434), `navigateFolderPickerBack` (1436-1439), `cancelFolderPicker`
(1457-1466), `confirmCurrentFolder` (1562-1569), and the favorites trio
`removeFavoriteFolder` (1488-1490), `isDriveFolderPickerFavorited` (1492-1494),
`toggleDriveFolderPickerFavorite` (1496-1504). The module must own
`showFolderPicker` (444), the `folderPicker*` state (445-449),
`folderHasSubFolders` (450) and the intent key (442), because the focus and
visibility effects read them. `confirmDriveFolderSelection` (1441-1455) stays a
thin view-level composition: it resets `rootDirHandle`, `nativeTreeUri` and
`libraryScanPromise` and calls `finishDriveLoad`.

**3.5 `driveLibrary` (`src/lib/drive/driveLibrary.ts`).**
`activateDriveLibrary` (1328-1340), `finishDriveLoad` (1571-1654),
`loadDriveLibrary` (1342-1394), `connectGoogleDrive` (1657-1659),
`refreshGoogleDrive` (1661-1667), `changeDriveFolder` (1669-1679),
`openDriveSourceButton` (1680-1715), `materializeStoredFile` (1794-1824),
`loadDriveFolderPicker` (2611-2621), `selectDriveFolderAndUpload` (2625-2659),
`openDriveUploadFolderPicker` (2474-2484), `switchToFavorite` (1506-1542). Seams
to inject: `player.clear`, the `allFiles`/`browseVersion` sink,
`openFolderPicker`, `confirmDriveFolderSelection`.

**3.6 `deviceLibrary` (`src/lib/device/deviceLibrary.svelte.ts`).**
`activateDeviceLibrary` (1321-1326), `openFolder` (2114-2194),
`handleFolderInput` (2196-2212), `handleNativeFileInput` (2214-2243),
`reconnectFolder` (2244-2271), `restoreLocalLibrary` (1725-1791),
`openLocalSourceButton` (1716-1723), `rescanCurrentLibraryIndex` (1544-1560),
`startLibraryScan` (1128-1178), `loadLocalFolderPicker` (2509-2520),
`navigateLocalPickerInto` (2522-2525), `selectLocalFolderAndDownload`
(2528-2609), `downloadToLocalFolder` (2738-2797),
`openLocalDownloadFolderPicker` (2486-2507). Needs the two `bind:this` input
refs (`folderInputEl`, `nativeFileInputEl`) injected. `rescanCurrentLibraryIndex`
must stay externally callable: `SettingsView.svelte:764` dispatches
`music-library:rescan`, handled at 3065-3070.

**3.7 `browseNavigation` (`src/lib/browse/browseNavigation.svelte.ts`).**
`loadBrowseEntries` (1839-1931) with `_browseLoadId` (1838) kept per instance,
`navigateInto` (2438-2443), `goToFileFolder` (2444-2456),
`navigateToParentFolderFromSwipe` (2457-2461), `navigateUp` (2462-2472).
`navigateUp` and `navigateToParentFolderFromSwipe` write `musicFavorites.shown`,
so that store is an explicit dependency.

**3.8 `fileOps` (`src/lib/files/fileOps.ts`).** `openDestinationForOp`
(2661-2664), `openLocalDestinationPicker` (2666-2677), `confirmAndDelete`
(2679-2687), `runPendingFileOp` (2689-2707), `deleteFileOp` (2709-2713),
`moveOrCopyFileOp` (2715-2724), `handleMoveEntry`/`handleCopyEntry`/
`handleDeleteEntry` (2726-2729), `folderOpNotice` (2730-2732),
`reloadCurrentBrowse` (2734-2736). Needs only `nativeTreeUri` plus the
local-picker callbacks.

#### Two hard hazards

1. Per-instance state must not become module-global. Two decks mount at once
(the `deck` prop at `Mp3PlayerView.svelte:86`), so `_browseLoadId` (1838),
`queueSessionId` (219), `trackListLockedByUser` (230), `libraryScanPromise`
(231), `hasRestoredPendingDriveFolderPicker` (451),
`isRestoringPendingDriveFolderPicker` (452) and
`pendingDriveFolderPickerRestoreTimers` (453) must stay per instance or be
threaded through a factory. Share them and deck A's load bumps the counter,
deck B's in-flight `loadBrowseEntries` bails at 1861, 1909 or 1927, and
`browseLoading` stays stale.
2. The `untrack()` boundary at `Mp3PlayerView.svelte:2998-3063` is deliberate.
It keeps reactive reads in the sync preamble, such as the `driveAccessToken`
reads inside `ensureDriveAccessToken`, out of the mount effect's dependency
set. The comment at 2993-2997 records the reason: without it the effect re-runs
while hydration writes those signals, which fires concurrent `finishDriveLoad`
calls and leaves a spinner that never resolves.

#### Test coverage

Extractions 3.4 to 3.8 have no test coverage. `tests/unit` stops at
`models/browse`, `models/player`, `utils/idb`, `utils/google-drive-auth-error`,
the stores and the equalizer, and `tests/e2e/music-player.test.ts` drives a
local folder only, with no Drive path, no folder picker and no transfer.
Extractions 3.2 (`libraryCache`) and 3.3 (`folderScan`) are pure and ship unit
tests of their own with their PRs.

### PR 4: browse and scan domain (absorbed into PR 3)

Now covered by PR 3.2 (`libraryCache`), PR 3.3 (`folderScan`) and PR 3.7
(`browseNavigation`), so no separate PR is needed.

### PR 5: favourites domain

Six functions, plus the machine that resolves favourite tracks to files.

### After the programme

`PodcastView.svelte` (1,400 lines, complexity 242, its own `safePlay`) is the
next single-file target and needs its own decision about whether the podcast
engine shares `createPlayer`. The three duplicated handlers in
`RadioView.svelte` fold into that pass.

## Known follow-ups

Non-blocking items the three audits of PR 2 left open. Recorded here so they are
not lost; none of them blocks this PR.

- A re-sorting `append()` can put a resolved URL on the wrong index. `ensureUrl`
  writes the URL to the index captured before its `await`, so a file that sorts
  ahead of the resolved track takes that slot and playback follows the wrong
  entry. Same in the pre-migration code, so it is not a migration regression.
- A resolve superseded by a queue replacement keeps its blob attached as
  `cleanup` instead of revoking it immediately: one object URL survives until
  the next `clear()` or `destroy()`, for a track that is no longer queued.
- `mediaEngine` has no `unregisterAudioSource`, so the view's register effect
  has no teardown. Podcast, Radio and YouTube have the same shape; the fix
  belongs in `mediaEngine`, not in one view.
- The deck element is now a detached `new Audio()` with `preload = 'none'`
  instead of an in-DOM `<audio>`. Its behaviour on Android and iOS WebViews is
  unverified without a device, like the rest of the native path.
- Fixed: `next()` from a loaded, paused deck started playback and resolved
  `true`, where the audit expected `false`. `advanceTrack`'s main branch now
  carries the same `wasPlaying` guard as its same-track branch and as the
  `loadAndPlayAt` path `prev()` uses, so a paused skip changes track and loads
  the src without starting playback, resolves `false`, and does not claim the
  channel. Pinned by "next from a loaded, paused deck changes track without
  beginning playback" in `tests/unit/models/player.test.ts`.
- `resolveTrackUrl` (`Mp3PlayerView.svelte:2000-2058`) and
  `appendTracksToQueue` (2105-2113) still duplicate the URL lifecycle and queue
  merge that `src/lib/audio/player.svelte.ts` owns in `ensureUrl` (240),
  `releaseUrl` (261) and `loadQueue` (279). Retire both when the view binds to
  the module.
- The PR 1 dead-code sweep missed the two view leftovers
  (`currentFolderAsFavorite`, `driveLoadProgress`) and the whole dead
  `LibraryStore` class, so the analyzer behind it produced false negatives as
  well as false positives. Use its candidate list as a starting point only and
  confirm every deletion with a word-boundary grep.

## Out of scope

- `android/`: `DirectoryReaderPlugin.java` (627 lines, 21 functions) and
  `MediaPlaybackService.java`.
- `SettingsView.svelte` (1,291 lines) and `WeatherView.svelte`.
- Splitting the markup of `Mp3PlayerView.svelte` into child components. This pass
  extracts logic only, so the diff stays reviewable.
- The analyzer's raw dead-code count (114) and its duplicate-name hits. Both are
  mostly noise, as the method below shows.
- `docs/research/` and the repo's own `.agents/`.

## Definition of done

- `Mp3PlayerView.svelte` under 2,500 lines, from 4,578.
- Every function in the PR 1 table gone, none re-added by later PRs.
- ADR-0001 wired, deck exclusivity proven by e2e.
- `guardrails.md` and `CONTEXT.md` describe the code as it then is.
- `pnpm validate` green.

## How the dead-code proof was produced

1. `codedeck-analysis.json` (snapshot 2026-09-06, 173 files) claims 114 unused
   functions. It counts a function as unused when no other file calls it, which
   misses Svelte markup in the same file: `onclick={handleSeekPointerDown}` is a
   call the analyzer does not see. Of 111 claims inside `src/`, 94 appear again
   in their own file and are false positives.
2. Remaining candidates were tested against a word-boundary scan of every
   `src/`, `tests/`, `scripts/`, `static/` and root config file, with the
   generated `codedeck*.json` files excluded so the analysis could not match
   itself.
3. Thirteen functions have zero references anywhere. Four more
   (`MiniPlayer.svelte:153`, `Mp3PlayerView.svelte:3127`, `:3432`,
   `RadioView.svelte:93`) appear exactly once in their own file, at the
   declaration, but share a name with a live function elsewhere, so only the
   per-file check can clear them.
4. Every candidate was read before deletion, and the resulting diff was checked
   with `pnpm check` and `pnpm test`.
