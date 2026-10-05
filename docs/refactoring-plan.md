# Refactoring plan

- Status: complete. GitHub PRs 1 to 11 are merged, and the PR 3 series (3.1 to 3.8) is done
- Base: `main` at `8dc7495` when the programme started; it is far ahead of that now
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

### PR 1: verified dead code (merged)

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

### PR 1b: dead-code follow-up (this PR)

On branch `refactor/dead-code-followup`, rebased onto `5e4e48f`, in two commits.

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

### PR 2: wire the ADR-0001 player module (merged)

ADR-0001 (`docs/adr/0001-player-module.md`, accepted 2026-08-22) decided this.
The module landed in commit `af3f6e5` with tests and had no caller until this
PR, which merged to `main` as `4f02339` through `5e4e48f`.

`Mp3PlayerView.svelte` now builds one `createPlayer` instance per deck
(`src/lib/audio/player.svelte.ts`), supplies the `resolveUrl` adapter and binds
the view to `player.state`. The in-view `<audio bind:this={audioEl}>`,
`safePlay`, `ensureTrackUrl`, `preloadNextTrack`, `advanceTrack`, `prevTrack`,
`revokeAll`, `releaseTrackUrl` and the volume, mute and speed effects are gone.
The view went from 4,578 to 4,032 lines and the module from 418 to 654.

The landmine was handled in the view: the module still never calls `claimAudio`
(zero hits in `src/lib/audio/player.svelte.ts`), so the view registers the
module's `pause()` with `registerAudioSource` and proves exclusivity in e2e.
Three adversarial review rounds found and fixed two regressions before merge: a
preload resolving after a queue replacement wrote a foreign URL by index and
orphaned the blob, and the first fix keyed on `PlayerTrack` wrapper identity
while `append()` rebuilds wrappers but keeps source objects.

Deliberate divergence from pre-migration `main`: claiming the audio channel now
follows the start of playback, so a skip on a paused deck neither plays nor
claims, where `main` claimed unconditionally once a URL had landed. Follow-up
(e) records the lost `wasPlaying` guard that made a paused skip start playing.

### PR 3: Drive and folder-picker domain (eight extractions)

Replaces the earlier single-step PR 3. Each extraction is its own
behaviour-preserving PR, listed in dependency order, and each depends only on
the earlier ones. Function names are in
`src/lib/components/views/Mp3PlayerView.svelte` unless a target module is
named. Line ranges are anchors from the recon snapshot (`/tmp/pr3-recon.md`),
taken before the dead-code follow-up above; treat them as anchors, not current
offsets.

Status: 3.1 to 3.8 merged. 3.8 merged from `refactor/pr3-8-file-ops`, which
completes the series. The view is still above the 2,500-line target in the
definition of done; the honest count and what remains are recorded under 3.8.

**3.1 `driveSession` (`src/lib/drive/driveSession.svelte.ts`).**
`hasValidDriveToken` (1259-1261), `ensureDriveAccessToken` (1263-1319) and the
`formatDriveAuthError` alias (1178). Takes the `driveAccessToken`,
`driveTokenExpiresAt`, `driveUser` and `driveError` state. `googleDriveSession`
stays the persistence owner.

**3.2 `libraryCache` (`src/lib/browse/libraryCache.ts`, pure).** Delivered, with
40 unit tests in `tests/unit/browse/libraryCache.test.ts`. Moved:
`getDeviceLibraryCacheKey`, `saveCachedLibrary`, `loadDeviceCachedLibrary`,
`restoreStoredFilesFromCache`, `collectStoredFilesFromSnapshot`, `pathToString`,
`collectFilesFromDirHandle`, `collectStoredFilesFromDirHandle`,
`resolveDirAtPath`, plus the `LAST_LIBRARY_CACHE_KEY` constant.

The recon was wrong about two of these. `getDeviceLibraryCacheKey` already took
`treeUri` in its options object, with no `nativeTreeUri` default, and
`collectStoredFilesFromDirHandle` already took its directory as a parameter.
Only `resolveDirAtPath` closed over component state. The signatures that did
change: `saveCachedLibrary(treeUri, folderName, files)` now requires the tree
URI that three of its four callers already passed,
`collectStoredFilesFromSnapshot(files, path, sortOrder)` takes the sort order
instead of calling the view's wrapper, and `resolveDirAtPath(root, path)` takes
the root handle.

**3.3 `folderScan` (`src/lib/browse/folderScan.ts`, pure).** Delivered on
`refactor/pr3-3-folder-scan`, with 21 unit tests in
`tests/unit/browse/folderScan.test.ts`. Moved: `yieldScanToUi`,
`scanNativeAudioFiles`, `collectAllFromPath`, `pickNativeAudioDirectory`. No
behaviour change was needed to make any of the four pure.

The recon was wrong about the injection seam. It described the group as driven
by `{ nativeTreeUri, rootDirHandle, onBatch }`, which fits none of the four
signatures. `scanNativeAudioFiles` closes over `nativeTreeUri` alone, so it now
takes the tree URI as its first parameter and keeps its
`(path, batchSize, options, onBatch)` tail. `collectAllFromPath` closes over six
values, so it takes a `deps` object of `{ librarySource, sortOrder, allFiles,
libraryScanPromise, rootDirHandle, nativeTreeUri }`; the `librarySource` field
is load-bearing, because the drive branch short-circuits before an in-flight
scan promise. `yieldScanToUi` and `pickNativeAudioDirectory` closed over nothing
but module imports and globals, so their signatures are unchanged.

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
`toggleDriveFolderPickerFavorite` (1496-1504), delivered with 25 unit tests in
`tests/unit/drive/folderPicker.test.ts`. The module owns `showFolderPicker`, the
`folderPicker*` state, `folderHasSubFolders`, the intent key, the per-instance
`isRestoringPendingDriveFolderPicker` flag and the restore-timer array. It is a
factory (`createFolderPicker`), not a singleton, so two mounted decks never share
a picker; the caller injects the deck's `driveSession`, a callback that resets
the view's `isDriveAuthenticating`/`isDriveLoading` flags after a restore, and the
view's `confirmDriveFolderSelection`. `confirmDriveFolderSelection` (1441-1455)
stays a thin view-level composition: it resets `rootDirHandle`, `nativeTreeUri`
and `libraryScanPromise` and calls `finishDriveLoad`.

The recon was wrong about why the module must own the state. It said the focus
and visibility effects read `showFolderPicker`/`folderPicker*`. They do not: the
retry effect reads only `hasPendingDriveFolderPickerIntent` and calls
`restorePendingDriveFolderPickerIfNeeded`, and the focus/visibility effect reads
the same helper, writes the two busy flags and calls the restore/clear methods.
The state belongs to the module because the moved functions read and write it and
the picker template renders it. `hasRestoredPendingDriveFolderPicker` stays in the
view, because it is the latch on that view's own restore effect.

The recon also implied a `folderPickerToken` staleness guard in
`loadFolderPickerLevel`, so a superseded load writes nothing. There is no such
guard, and there never was: the view (and now the module) assigns
`folderPickerFolders` from the awaited listing with no token or load-id check, so
when two loads overlap the last to resolve wins. The extraction preserves that;
adding a guard would be a behaviour change.

**3.5 `driveLibrary` (`src/lib/drive/driveLibrary.ts`).**
`activateDriveLibrary` (1328-1340), `finishDriveLoad` (1571-1654),
`loadDriveLibrary` (1342-1394), `connectGoogleDrive` (1657-1659),
`refreshGoogleDrive` (1661-1667), `changeDriveFolder` (1669-1679),
`openDriveSourceButton` (1680-1715), `materializeStoredFile` (1794-1824),
`loadDriveFolderPicker` (2611-2621), `selectDriveFolderAndUpload` (2625-2659),
`openDriveUploadFolderPicker` (2474-2484), `switchToFavorite` (1506-1542).

Delivered on `refactor/pr3-5-drive-library` with 24 unit tests in
`tests/unit/drive/driveLibrary.test.ts`. `createDriveLibrary` is a factory, like
`createDriveSession` and `createFolderPicker`. It is a plain `.ts` module and
holds no runes: the deck allocates the reactive busy bag (`isDriveLoading`,
`isDriveAuthenticating`, `driveLoadAbort`) and the factory owns every transition
of it.

The recon was wrong about the seam list, and so was this paragraph. The four
seams listed before (`player.clear`, the `allFiles`/`browseVersion` sink,
`openFolderPicker`, `confirmDriveFolderSelection`) are not enough. `openFolderPicker`
is not a standalone seam at all: it arrives on the injected `folderPicker`
instance. The module also needs `hydrateTracksFromLibrary` and
`activateDeviceLibrary` (both reached by `switchToFavorite`), an accessor for
every piece of view state the functions wrote (`allFiles`, and the device-side
`libraryScanPromise`/`rootDirHandle`/`nativeTreeUri`/`pendingHandle`/`browsePath`/
`showQueue`/`showPanel` that settle into 3.6, the `switchingToFavId` favourite
spinner, and the Drive transfer picker state `drivePickerLoading`/
`drivePickerFolders`/`showDriveFolderPicker`/`transferFile`/`transferDirection`/
`isTransferring`/`isFileOpRunning` that settles into 3.8), and the `busy` bag
itself. The mount effect's `untrack()` boundary is unchanged: the effect still
calls `driveLibrary.finishDriveLoad(...)` from inside it, so no reactive read in
`finishDriveLoad`'s synchronous preamble becomes an effect dependency.

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

Delivered on `refactor/pr3-6-device-library` with 35 unit tests in
`tests/unit/device/deviceLibrary.test.ts`. `createDeviceLibrary` is a factory,
like the earlier extractions. It owns `libraryScanPromise`, `rootDirHandle`,
`nativeTreeUri`, `pendingHandle`, `scanProgress`, `trackListLockedByUser`,
`deckFolderLabel` and the Android local-picker fields (`localPickerPath`,
`localPickerEntries`, `localPickerLoading`). Everything else is injected:
`allFiles` and `browsePath` (the browse view owns and reads them),
`showQueue`, the open-folder spinner `isLoading`, the `driveSearch` write target,
the transfer state shared with 3.5 and 3.8 (`transferFile`,
`transferDirection`, `isTransferring`, `transferProgress`, `transferPhase`,
`showLocalFolderPicker`, `isFileOpRunning`, `pendingFileOp`), the
`bumpBrowseVersion` / `hydrateTracksFromLibrary` / `runPendingFileOp` callbacks,
the Drive library's `refreshGoogleDrive` (for the drive branch of
`rescanCurrentLibraryIndex`), `isNativeApp`, and the two input refs as getters.

This paragraph understated the seam: naming only the two input refs implied the
module needs nothing else from the view. It needs the accessor and callback list
above. The 3.5 paragraph was also wrong that `browsePath`, `showQueue` and
`showPanel` settle into 3.6: they do not. `browsePath` and `showQueue` stay in
the view (extraction 3.7 owns them) and `showPanel` is EQ-panel state. Moving
`libraryScanPromise`, `rootDirHandle`, `nativeTreeUri` and `pendingHandle` did
re-point 3.5's injected `view` accessor: those four getters and setters now read
and write the `deviceLibrary` instance, and `createDriveLibrary`'s injected
`activateDeviceLibrary` is now `deviceLibrary.activateDeviceLibrary`.
`driveLibrary.ts` is otherwise unchanged.

`rescanCurrentLibraryIndex` stays externally callable: the view keeps the
`music-library:rescan` window listener and calls
`deviceLibrary.rescanCurrentLibraryIndex()` from it, so
`SettingsView.svelte:764` is untouched.

**3.7 `browseNavigation` (`src/lib/browse/browseNavigation.svelte.ts`).**
`loadBrowseEntries` (1839-1931) with `_browseLoadId` (1838) kept per instance,
`navigateInto` (2438-2443), `goToFileFolder` (2444-2456),
`navigateToParentFolderFromSwipe` (2457-2461), `navigateUp` (2462-2472).
`navigateUp` and `navigateToParentFolderFromSwipe` write `musicFavorites.shown`,
so that store is an explicit dependency.

Delivered on `refactor/pr3-7-browse-navigation` with 21 unit tests in
`tests/unit/browse/browseNavigation.test.ts`. `createBrowseNavigation` is a
factory, like the earlier extractions, so the load-id counter stays per deck and
one deck's load cannot cancel the other's in-flight one. The module owns
`browseEntries`, `browseLoading` and that counter. `browsePath`,
`fileSearchQuery` and `selectedBrowseFileKeys` stay in the view and arrive
through an injected `view` accessor: the breadcrumb markup and other view
functions read and write `browsePath` directly, `fileSearchQuery` is a
`bind:value` input, and `selectedBrowseFileKeys` drives the view's selection
effect. The loader reads the deck's `deviceLibrary` for `libraryScanPromise`,
`nativeTreeUri` and `rootDirHandle`. The browse reload effect stays in the view
and is unchanged: it still reads `browsePath`, `driveSearch`, `browseVersion` and
`musicSettings.librarySource` and calls `browseNavigation.loadBrowseEntries`,
which runs synchronously under the effect, so the reads inside it (library
source, sort order, file list, device handles) still register as dependencies.

This paragraph was wrong twice. It says only `navigateUp` and
`navigateToParentFolderFromSwipe` write `musicFavorites.shown`; `navigateInto`
and `goToFileFolder` write it too, so all four navigation functions touch the
store. And it omitted that `goToFileFolder` also clears `fileSearchQuery` and
`selectedBrowseFileKeys` and sets `mediaEngine.musicSelectionLoopActive = false`.
The line anchors above are stale (the view shrank after 3.4 to 3.6); the function
names are the reliable locator.

**3.8 `fileOps` (`src/lib/files/fileOps.ts`).** The last PR 3 group. Moved
`openDestinationForOp`, `openLocalDestinationPicker`, `confirmAndDelete`,
`runPendingFileOp`, `deleteFileOp`, `moveOrCopyFileOp`, `handleMoveEntry`,
`handleCopyEntry`, `handleDeleteEntry`, `folderOpNotice` and
`reloadCurrentBrowse`, plus the `OpTarget` and `PendingFileOp` types. Delivered
on `refactor/pr3-8-fileOps` with 24 unit tests in
`tests/unit/files/fileOps.test.ts`.

`createFileOps` is a factory, like the earlier groups, so two decks never share
a pending op. It is a plain `.ts` and holds no runes, so it does not own the
reactive state: `pendingFileOp` and `isFileOpRunning` stay in the view and
arrive through an injected `view` accessor, the same shape `driveLibrary.ts`
already uses for `isFileOpRunning`. Both are read reactively by the
local-picker markup and a plain `.ts` cannot hold `$state`, so moving them
would have forced the module to `.svelte.ts` and churned the 3.5 and 3.6
accessors for no behaviour gain. The transfer fields (`transferFile`,
`transferDirection`, `isTransferring`, `transferProgress`, `transferPhase`)
stay in the view and with 3.5/3.6; `fileOps` touches none of them except
`showLocalFolderPicker`, which does not move either.

It needs the deck's `deviceLibrary` (`nativeTreeUri`, `openFolder`,
`loadLocalFolderPicker`), the deck's `browseNavigation` (`loadBrowseEntries`)
and `isNativeApp`. The recon's "needs only `nativeTreeUri` plus the local-picker
callbacks" is wrong: `reloadCurrentBrowse` is in this group and needs the browse
navigation.

One seam was re-pointed. 3.6's `createDeviceLibrary` injection
`runPendingFileOp: (destination) => runPendingFileOp(destination)` is now
`fileOps.runPendingFileOp`. The 3.5 `DriveLibraryView.isFileOpRunning` and the
3.6 `DeviceLibraryView.pendingFileOp`/`isFileOpRunning` accessors are unchanged,
because that state did not move; `deviceLibrary.svelte.ts` and `driveLibrary.ts`
are otherwise untouched.

Behaviour preserved: the `pendingFileOp` set/run/clear lifecycle; the confirm
toast and its Delete-action ordering; `folderOpNotice`'s text and type;
`openLocalDestinationPicker`'s native and web branches and both its warning
toasts; `runPendingFileOp`'s per-op failure toast; the three handlers setting
`pendingFileOp` before the picker opens; and `reloadCurrentBrowse`'s
`loadBrowseEntries(browsePath, 'drive' | undefined)` arguments and its
synchronous call from the runner. The recon's line anchors for this group
(2661-2736) are stale; every function was read in place before the move.

**Where the series landed.** With 3.8, all eight PR 3 groups are out of the
view. `Mp3PlayerView.svelte` is 2,665 lines (1,706 script, 935 template, 24
style), down from 4,032 at the start of PR 3 but still above the 2,500-line
target in the definition of done. What remains is not one of the eight domains:
the playback transport and URL lifecycle (`resolveTrackUrl`, `appendTracksToQueue`,
`hydrateTracksFromLibrary` and the queue/session glue), the track-favourite
machine, the browse selection and play-folder logic, the EQ panel wiring, and
the 935 lines of markup this pass deliberately did not touch (logic extraction
only). Closing the gap needs PR 5 (`favourites`) and a markup split, neither of
which is in this branch.

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

Extractions 3.7 and 3.8 now ship unit tests (21 in
`tests/unit/browse/browseNavigation.test.ts` and 24 in
`tests/unit/files/fileOps.test.ts`). `tests/unit` stops at
`models/browse`, `models/player`, `utils/idb`, `utils/google-drive-auth-error`,
the stores, the equalizer and the extracted browse/drive/device modules, and
`tests/e2e/music-player.test.ts` drives a local folder only, with no Drive path,
no folder picker and no transfer. Extractions 3.2 (`libraryCache`), 3.3
(`folderScan`), 3.4 (`folderPicker`), 3.5 (`driveLibrary`) and 3.6
(`deviceLibrary`) ship unit tests of their own with their PRs; 3.2 and 3.3 are
pure, 3.4 mocks the two Drive calls, 3.5 mocks the Drive calls, the Drive cache
and the native resolver, and 3.6 mocks the native plugin, the cache, the Drive
download and the File System Access API.

### PR 4: browse and scan domain (absorbed into PR 3)

Now covered by PR 3.2 (`libraryCache`), PR 3.3 (`folderScan`) and PR 3.7
(`browseNavigation`), so no separate PR is needed.

### PR 5: favourites domain (delivered)

The track-favourite machine moved out of `Mp3PlayerView.svelte` into
`src/lib/favorites/favoriteTracks.ts`, behind the `createFavoriteTracks`
factory: `createFavoriteTrack`, `resolveFavoriteTrackFile`, `isFavoriteTrack`,
`toggleFavoriteTrack`, `removeFavoriteTrack`, `getResolvedFavoriteTrackFiles`
and `playFavoriteTrack`. PR 4 was already absorbed into PR 3, so this is the
only remaining favourites work.

**Seam.** A per-deck factory, not a module singleton: two decks mount at once,
so a shared instance would let deck A's `playFavoriteTrack` answer for deck B.
The module is a rune-free `.ts`, so every closure dependency arrives as an
injected option. The `view` accessor carries the deck's `allFiles` and its live
queue (`player.state.tracks`, the second half of the resolve lookup) as
read-only getters, plus `isChangingTrack` with a setter for the guard
`playFavoriteTrack` holds across its `await`. `settings` is the shared persisted
`musicSettings` object, so the `favoriteTracks` writes still land on the
reactive store rather than a copy. The playback entry points arrive as
callbacks: `initAudioContext`, `beginQueue` and `startPlayback`, plus
`openYoutubePanel` and the `addToast` sink.

**What stayed in the view, and why.** The two deriveds `filteredFavoriteTracks`
and `currentTrackIsFavorite` read view state (`fileSearchQuery`, `currentTrack`,
`musicSettings.lastTrackIndex`), so they stay and call the instance instead of
local wrappers. The markup is not split into components, but every bare-name
call site was converted to `favoriteTracks.*`: the favourites list's play and
remove handlers, the browse-row star (class, toggle, aria-label, title and
fill), the now-playing star toggle, and both deriveds.

**Behaviour preserved.** `createFavoriteTrack`'s `parseFilename` parse and its
per-source shape (web, native with path/mime/mtime, drive with id/size/link),
and the per-branch `source` that keeps the discriminant narrow;
`resolveFavoriteTrackFile`'s two-step lookup (library index, then the live
queue) with its per-source reconstruction fallback and its `null` for an
unloaded web favourite; `isFavoriteTrack`'s `Array.isArray` guard;
`toggleFavoriteTrack`'s remove-when-present / append-when-absent semantics;
`removeFavoriteTrack`'s key match; `getResolvedFavoriteTrackFiles`'s stored
order, unresolved skips and de-duplication by key; and `playFavoriteTrack`'s
guard order (bail while changing, hand YouTube to the panel, warn on an
unresolvable favourite, init the context, warn on an empty batch, then start at
the favourite's index with `preserveOrder`, releasing `isChangingTrack` in
`finally`). The recon's line anchors were stale; every function was read in
place before the move.

**Test coverage.** 23 unit tests in
`tests/unit/favorites/favoriteTracks.test.ts`, fully dependency-injected so no
store or device is needed: one `createFavoriteTrack` branch per source, the
resolve hit (index and queue) and miss, the `isFavoriteTrack` non-array guard,
the add and remove paths of `toggleFavoriteTrack`, `removeFavoriteTrack`, the
batch skip and de-dup, and `playFavoriteTrack` for a resolved favourite, an
unresolvable one, an empty batch, the changing-track guard and a YouTube
hand-off.

### PR 6: podcast domain (group 1 delivered)

`PodcastView.svelte` (1,392 lines, complexity 242, its own `safePlay`) is the
last single-file target. It is extracted in dependency order, each group its
own behaviour-preserving step, and logic only: the effects and the markup stay
in the component. The five groups: `episodeDisplay` (pure), `itunes` (pure),
`progress` (coupled to `podcastData`), `podcastLibrary` (factory) and
`podcastPlayer` (factory).

**Decision: the podcast transport keeps its own module and
`src/lib/audio/player.svelte.ts` is not modified.** The podcast path has
behaviours the music player does not: stop on end; resume persistence
throttled to one write per 20 seconds and flushed on pause and on end;
rebuild-on-restart that loads a source without playing; a network reconnect
path with an `online` listener; system-pause auto-resume; MediaSession updates
routed through `mediaEngine`; and a per-episode playback-speed reset.

**Two facts the transport work rests on.** `PodcastView` mounts once and stays
mounted behind `class:hidden`, so its effects, timers and element listeners
keep running in the background when another tab is shown. And no unit test
mounts `PodcastView`; the e2e suite only clicks the Podcasts tab and asserts
that two `<audio>` elements exist, so nothing guards the transport today.

**6.1 `episodeDisplay` (`src/lib/podcast/episodeDisplay.ts`, pure).** Delivered
on `refactor/pr6-podcast-display`, with 28 unit tests in
`tests/unit/podcast/episodeDisplay.test.ts`. Moved `isActiveEpisode`,
`getEpisodeProgressPercent`, `getEpisodeProgressLabel`, `isNewEpisode` and
`artworkFallback`, plus the `NEW_EPISODE_WINDOW_MS` constant (moved in whole,
not parameterised). The first four closed over view state: `isActiveEpisode`
reads `currentEpisode.episode.id`; the two progress helpers read
`currentEpisode`, `currentTime` and `duration`; `isNewEpisode` reads the
constant. Each now takes that state as a parameter. `artworkFallback` already
took its podcast and was pure in place, so only its import changed. `isNewEpisode`
takes an optional `now` so tests can pin the window boundary; its call site is
unchanged. The view still owns `formatDuration` for the episode-row duration at
`PodcastView.svelte:1108`; the module imports the same helper from
`$lib/models/music`. Of the twelve references to the five helpers in the
component, five stay as markup calls (four with new arguments, `artworkFallback`
unchanged) and seven moved with the code (five declarations and the two
`isActiveEpisode` calls inside the two progress helpers). The view drops from
1,392 to 1,342 lines. Groups 2 to 5 are not started.

**6.2 `itunes` (`src/lib/podcast/itunes.ts`, pure).** Delivered on
`refactor/pr6-podcast-itunes`, with 12 unit tests in
`tests/unit/podcast/itunes.test.ts` (`fetch` mocked, no network). Moved
`resolvePodcastApiUrl` and `searchITunes`, and the `ItunesResult` interface with
them. `resolvePodcastApiUrl` now takes `(path, baseUrl)`; of its four view call
sites, the one inside `searchITunes` moved with the function and the other three
(the `rssFetchConfig` closure and the two iTunes-lookup URLs) now pass
`podcastApiBaseUrl`. `searchITunes` takes `(q, { baseUrl, useHostedProxy })` and
returns `ItunesResult[]`; it no longer writes `searchResults` or `searchLoading`.
Returning the results (rather than accepting setters) keeps the module pure and
lets the tests assert the value instead of spying on a callback. The view keeps a
thin `runITunesSearch` wrapper that owns both state writes, so the debounce
(400 ms) and the discover effect are unchanged. A short query, a non-ok
response, a malformed body and any fetch rejection all still yield `[]`. The
view drops from 1,342 to 1,317 lines. Groups 3 to 5 are not started.

**6.3 `progress` (`src/lib/podcast/progress.ts`, coupled to `podcastData`).**
Delivered on `refactor/pr6-podcast-progress`, with 17 unit tests in
`tests/unit/podcast/progress.test.ts`. Moved `syncPersistedEpisodeState`,
`markEpisodeFullyPlayed`, `mergeEpisodeHistory` and `getEpisodeResumePosition`,
plus the 20-second `PROGRESS_PERSIST_MS` constant. Unlike groups 1 and 2 this
module is not pure: it imports the shared `podcastData` store directly, the same
way `fileOps.ts` imports `musicSettings`. The two other objects
`syncPersistedEpisodeState` writes, `selectedPodcast` and `currentEpisode`, are
component `$state`, so they arrive through an injected `PodcastProgressView`
accessor (getter/setter pairs) — the same shape `createFileOps` uses for
`pendingFileOp`, chosen over extra return values so the six call sites stay
one-line and the view keeps ownership of its reactive state. The throttle
*decision* stays in the view's timeupdate handler alongside the per-element
`_lastProgressPersist` timestamp; only the constant and an equivalent pure
boundary predicate (`shouldPersistProgress(lastPersistMs, now)`) moved, so the
boundary is testable. Every persistence semantic is preserved: the persisting
object's four copied keys (`played`, `progress`, `positionSec ?? 0`, `duration`)
and the mirror into `selectedPodcast` / `currentEpisode`; the forced flush on
pause and on end; `markEpisodeFullyPlayed`'s `played = true`, `progress = 100`,
`positionSec = 0` and the store's `lastEpisodeId` / `lastPodcastId` /
`lastPositionSec = 0` writes; `mergeEpisodeHistory`'s saved-state-wins rule with
its id → audioUrl → title+date matching and `lastEpisodeId` remap; and
`getEpisodeResumePosition`'s `Math.max(savedPosition, lastPositionSec)` on the
last-played episode and bare `positionSec ?? 0` for every other episode. The
view drops from 1,317 to 1,252 lines. Groups 4 and 5 are not started.

### After the programme

`PodcastView.svelte` (1,252 lines after group 3, complexity 242, its own
`safePlay`) is the next single-file target; PR 6 records the decision not to
share `createPlayer` and the five-group order. The three duplicated handlers in
`RadioView.svelte` fold into that pass.

## Known follow-ups

Non-blocking items left open by the PR 2 audits and by the PR 3 extractions.
Recorded here so they are not lost; none of them blocks a PR.

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
- `Mp3PlayerView.svelte` still imports `idbGet`, `idbDelete`,
  `CachedWebLibraryFile` and `CachedNativeLibraryFile` without using them. They
  predate the PR 3 extractions and belong with the browse groups that will touch
  those imports anyway. `src/lib/utils/idb.ts:9` also still describes
  `saveCachedLibrary` as view-coupled, which stopped being true in 3.2.
- `saveCachedLibrary` silently drops files whose source is Drive, so a
  drive-only library is never cached. Behaviour unchanged and pinned by a test
  in `tests/unit/browse/libraryCache.test.ts`; fix it deliberately or not at all.

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
