# Research: library-delta (Q1-Q42, merged)

Stage: R (Research), effort `library-delta`. Merged from the six cluster files
`.scratch/library-delta/research/1.md` … `6.md`. Tree read at `main`, commit `1c4347e`.
Read-only; the in-flight edits to `ScreenDimPlugin.java`, `src/lib/native/screen-dim.ts`
and `src/routes/+layout.svelte` are unrelated and untouched.

Java paths are shortened: `DirectoryReaderPlugin.java` =
`android/app/src/main/java/com/maverock24/mobilemediaapp/DirectoryReaderPlugin.java`.

Where a cluster's line number disagreed with `questions.md`, the tree was re-read and
the tree's number used; the notable drift is the browse reload effect (tree `:784-790`,
`questions.md` said `:784-792`), the selection-pruning effect (tree `:793-810`) and the
player's public surface (`play` `:530`, `load` `:538`, `append` `:541`). Cluster 1, 5
and 6 also record their own corrections to the pointer set.

---

## Constraints that decide the design

1. A directory's mtime is destroyed at the source: it is visible only in the parent's cursor row and is discarded for directories, because `DirNode` keeps only `documentId` and `relativePath` (`DirectoryReaderPlugin.java:181`, `:249`, `:311`, `:63-64`, `:185`).
2. No directory-level fact crosses the bridge at all: the folder object carries `kind`, `name`, `relativePath` and nothing else, no document id, no mtime, no child count (`DirectoryReaderPlugin.java:254-258`; `src/lib/native/directory-reader.ts:12-16`).
3. A failed directory is indistinguishable from an empty one: the exception is swallowed, `foldersScanned` was already incremented, and a resolved batch has no error field (`DirectoryReaderPlugin.java:172`, `:176`, `:196-198`, `:206-211`).
4. The protocol reports presence only. There is no tombstone or diff field; absence is inferred from a listing that reached `done: true`, so a skipped directory looks like deleted files (`DirectoryReaderPlugin.java:201`, `:210`).
5. No file size exists on the native path: `COLUMN_SIZE` appears nowhere in the Android source, and no native TypeScript shape carries it (`DirectoryReaderPlugin.java:54-59`, `:405-414`; `src/lib/models/music.ts:10`, `:59-66`).
6. An absent mtime becomes `0L` and stays `0` through the type, the cache and the restore; nothing in `src/` ever compares `modifiedAt`, so mtime is metadata, never a change signal (`DirectoryReaderPlugin.java:181`; `src/lib/models/music.ts:154`; `src/lib/browse/libraryCache.ts:76`, `:127`).
7. The cached library has no schema version, no scan-completion flag, no directory list and no tree-URI field: `{ folderName, files, savedAt, cacheKey? }` (`src/lib/models/music.ts:68`; `src/lib/browse/libraryCache.ts:86`).
8. Cache load is unversioned and unparsed; a payload missing `files` throws at the first reader and is swallowed, so an old entry fails silently rather than migrating (`src/lib/utils/idb.ts:77-86`; `src/lib/components/views/Mp3PlayerView.svelte:1566`; `src/lib/device/deviceLibrary.svelte.ts:257`).
9. An empty scan result is never written, so a stale cache outlives a folder that was emptied, until a rescan or a delete-rewrite runs (`src/lib/browse/libraryCache.ts:83`; `src/lib/device/deviceLibrary.svelte.ts:197`).
10. Cache deletion is unconditional and irreversible, and `rescanCurrentLibraryIndex` deletes both keys before the scan that would replace them (`src/lib/utils/idb.ts:88-94`; `src/lib/device/deviceLibrary.svelte.ts:218-221`).
11. The search index is keyed on `allFiles.length` alone, so an equal-length replacement leaves it stale; the player queue is a copy with no remove or in-place update (`src/lib/components/views/Mp3PlayerView.svelte:245`, `:250`; `src/lib/audio/player.svelte.ts:292-302`, `:529-543`).
12. Identity is `relativePath` (`n:`/`w:`), so a rename is a different file for favourites, resume, queue merge and selection; only Drive survives it (`src/lib/models/music.ts:114-117`, `:230-241`; `src/lib/stores/settings.svelte.ts:46`).

---

## Q1

One batch is a resolved `JSObject` with exactly four fields, `files`, `foldersScanned`,
`foldersQueued` and `done` (`DirectoryReaderPlugin.java:206-211`), mirrored by
`AudioScanBatchResult` (`src/lib/native/directory-reader.ts:37-41`). The unit of work is
the directory, not the file: the loop dequeues whole directories and stops when emitted
files reach `batchSize` or the queue empties, so one directory's files are never split
(`DirectoryReaderPlugin.java:167-170`). `foldersScanned` is a cumulative session field
incremented once per dequeued directory (`:76`, `:172`, `:208`); `foldersQueued` is a
per-batch snapshot of the queue length (`:209`); `filesAdded` is per-batch and never
returned (`:165`, `:194`). The JS side adds `totalFiles`, the running length of
`collectedFiles` (`src/lib/browse/folderScan.ts:33-38`, `:61`, `:78`, `:83`). `batchSize`
is per call with a native default of 250 (`DirectoryReaderPlugin.java:41`, `:158-161`).

## Q2

No directory-level fact crosses the bridge. The only folder object the plugin builds is
`kind`, `name`, `relativePath` (`DirectoryReaderPlugin.java:254-258`), matching
`NativeDirectoryFolder` (`src/lib/native/directory-reader.ts:12-16`): no directory mtime,
no child count, no document id field. `COLUMN_DOCUMENT_ID` is read at `:178`, `:246`,
`:308` but used only to queue a child in Java (`:185`, `:315`, held in `DirNode` at
`:63`) or to build a document URI (`:191`, `:264`, `:321`). It is therefore reachable
from JS only inside the emitted `path` string, produced by
`DocumentsContract.buildDocumentUriUsingTree` (`:191`, `:409`) and stored verbatim
(`:405-414`); the URI layout is platform-defined and asserted nowhere in this repo
(`tests/unit/files/fileOps.test.ts:71` uses an opaque literal).

## Q3

The scan root's mtime is never queried: `startAudioScan` resolves the root document id
(`DirectoryReaderPlugin.java:118`) and then calls `queryDisplayName` (`:124`), which
projects `COLUMN_DISPLAY_NAME` only (`:390-391`). A child directory's mtime is present
in its parent's cursor row (`:181`, `:249`, `:311`) but discarded, because a queued
directory is a `DirNode` holding only `documentId` and `relativePath` (`:62-69`, built at
`:185`, `:315`). No directory's mtime, including the root's, can be known before
descending into it, and `queryDisplayName` is the only per-document query in the plugin
(`:388-399`).

## Q4

An unreadable directory is silent: a null cursor short-circuits with `continue` (`:176`),
an exception is swallowed with a comment (`:196-198`), and `foldersScanned` is
incremented before the query runs (`:172`), so a directory that threw is counted exactly
like one with no children. A resolved batch has no error field (`:206-211`), so "empty"
and "failed" are indistinguishable to the caller. The only rejections in the scan path
are a missing `scanId` (`:148`), an unknown session (`:154`) and the failures inside
`startAudioScan` (`:112`, `:120`, `:139-141`).

## Q5

No. `COLUMN_SIZE` appears nowhere under `android/app/src/main/java/`, and
`CHILD_PROJECTION` lists only id, display name, MIME type and last modified
(`DirectoryReaderPlugin.java:54-59`). `createFileObject` emits six fields and no size
(`:405-414`), and every TypeScript mirror lacks it: `NativeDirectoryFile`
(`src/lib/native/directory-reader.ts:3-10`; `src/lib/models/music.ts:144`), the native
variant of `StoredAudioFile` (`src/lib/models/music.ts:10`), and
`CachedNativeLibraryFile` (`src/lib/models/music.ts:59-66`). `sizeBytes` exists only on
the Drive shapes (`src/lib/models/music.ts:40`).

## Q6

`cursor.isNull(3) ? 0L : cursor.getLong(3)` (`DirectoryReaderPlugin.java:181`, repeated
at `:249` and `:311`) turns an absent mtime into `0`, and `0` is passed through
unchanged by `createStoredNativeAudioFile` (`src/lib/models/music.ts:154`), written as
`modifiedAt` (`src/lib/browse/libraryCache.ts:76`) and restored as `modifiedAt`
(`:127`). The type is `modifiedAt?: number` (`src/lib/models/music.ts:10`, `:65`), so
`0` is a legal timestamp and no consumer, type or cache field records that it meant
"absent". The null/none distinction is destroyed at the source and cannot be recovered
downstream.

## Q7

The walk is breadth first: children are appended with `addLast` (`:185`) onto the
`ArrayDeque` declared at `:73`, and batches dequeue with `removeFirst` (`:171`), so it
is FIFO from the root; `listAudioFiles` has the same shape without batching
(`DirectoryReaderPlugin.java:299-328`). A batch can contain files from many directories,
since the loop iterates directories until the file budget is met (`:170-199`), and it
can contain zero files while `done` is false. `done` is `pendingDirs.isEmpty()` and
nothing else (`:201`); once true the session is removed (`:202-204`), so a later batch
call for the same id rejects (`:152-155`).

## Q8

The protocol reports presence only. The whole plugin contains no tombstone, `deleted`,
diff or unchanged field; the single occurrence of the idea is the comment at `:197`
about removed media. The only evidence a caller has that a file is gone is the absence
of its `relativePath` and `path` from a listing that reached `done: true`
(`DirectoryReaderPlugin.java:201`, `:210`), and because failures are silent (Q4) that
absence cannot be distinguished from a directory that was skipped.

## Q9

There is no way to start from a document id: every plugin method takes `treeUri` plus an
optional `/`-separated name `path` (`DirectoryReaderPlugin.java:110-118`, method list at
`:108`, `:145`, `:215`, `:224`, `:281`), and an empty path returns the tree's own
document id without any query (`:346-349`). `resolveDocumentId` costs one full child-list
query per segment (`:351-361`), matching exact display name and `MIME_TYPE_DIR`
(`:367-371`) with no sort order (`:361`, all-null arguments), first match wins because it
breaks (`:370`); a start at depth N therefore costs N child queries plus one
`queryDisplayName` (`:124`). A repeated name resolves to whichever row the provider
returns first with no ambiguity signal, and a renamed or missing segment returns null,
which surfaces as the single rejection "Selected directory is not accessible"
(`:119-122`, `:374-380`).

## Q10

The three listing paths differ in cost and shape. `listEntries` (`:224-278`) reads one
directory with one child query (`:243`) plus one `queryDisplayName` (`:270`) and returns
files with mtime (`:249`, `:265`) and folders with three fields and no mtime (`:254-258`).
`listAudioFiles` (`:281`, loop `:299-328`) walks the whole subtree in one resolved call
with no cap and no truncation; the TypeScript `truncated` and `count` fields
(`src/lib/native/directory-reader.ts:26-27`) are never set by Java. `startAudioScan` plus
`getAudioScanBatch` (`:108-212`) is the streaming variant of Q1/Q7.

Callers: `listEntries` at `src/lib/browse/browseNavigation.svelte.ts:129` (live listing
while a scan runs) and `:177` (no index), at `src/lib/browse/folderScan.ts:110` and
`src/lib/components/views/SettingsView.svelte:141` (native folder picker);
`listAudioFiles` at `src/lib/browse/folderScan.ts:145` (`collectAllFromPath` fallback);
the streaming scan at `src/lib/browse/folderScan.ts:67`, used from
`src/lib/device/deviceLibrary.svelte.ts:176` (index scan, batch 500 at `:56`) and
`src/lib/components/views/Mp3PlayerView.svelte:1172` (folder playback, batch 48 at
`:108`). None of the three returns a folder mtime. `listEntries` and `listAudioFiles`
keep no session state, since `AUDIO_SCAN_SESSIONS` is touched only at `:42`, `:131`,
`:152`, `:203` and `:218`, so either can run while a session drains, and
`browseNavigation.svelte.ts:129` already does exactly that.

## Q11

The set is duplicated with two encodings and no shared source. Java holds a dotted array
`{ ".mp3", ".m4a" }` (`DirectoryReaderPlugin.java:44`) and tests it with
`name.toLowerCase().endsWith(ext)` (`:46-51`); TypeScript holds `['mp3', 'm4a']`
(`src/lib/models/music.ts:85`) and builds a case-insensitive regex from it (`:87-95`).
The two lists agree by coincidence of content, not by construction. On the native path
Java is authoritative: it filters before anything crosses the bridge in all three read
paths (`:189`, `:262`, `:319`), so a file it rejects is invisible to JS regardless of the
TypeScript predicate; the TypeScript filter covers inputs Java never sees, the web and
native file inputs (`src/lib/device/deviceLibrary.svelte.ts:395`, `:414`), File System
Access walks (`src/lib/browse/libraryCache.ts:154`, `:173`;
`src/lib/browse/browseNavigation.svelte.ts:165`) and Drive
(`src/lib/google-drive.ts:490-493`). The MIME accept path `isSupportedAudioMime`
(`src/lib/models/music.ts:101-112`, any `audio/*`) can never rescue a native-scan file
because it is dropped at `DirectoryReaderPlugin.java:189` first.

## Q12

The only entry point for a provider mtime is the native cursor read, coerced at the
boundary: `COLUMN_LAST_MODIFIED` is projected at `DirectoryReaderPlugin.java:58` and
read as `cursor.isNull(3) ? 0L : cursor.getLong(3)` at `:181`, `:249`, `:311`, so JS
never receives null. Storage and forwarding are plain copies
(`src/lib/browse/libraryCache.ts:76`, `:127`; `src/lib/models/music.ts:154`). The only
value reads pass it into a `File` constructor (`src/lib/audio/fileResolver.ts:82`;
`src/lib/drive/driveLibrary.ts:376`, `:384`; `src/lib/google-drive.ts:667`, `:675`), and
`grep -rnE "modifiedAt\s*(===|!==|>=|<=|>|<)" src/` returns zero matches, so two
observations of one file are never compared and nothing is ever decided unchanged. One
write site invents the value: `src/lib/device/deviceLibrary.svelte.ts:570`
(`modifiedAt: Date.now()`) on the entry created for a Drive file downloaded to the phone.

## Q13

**Repo evidence.** The pointers in the question do not discuss mtime:
`docs/device-verification.md:37-51` is the SAF-picker section (expected index text, three
failure strings, logcat line) and `:304-319` is the move/copy/delete section, while
`docs/adr/0002-file-move-copy-delete.md` never mentions mtime or provider variance; a
grep for `mtime|modified|last.?modif|provider|coarse` over `docs/` (excluding
`docs/archive/`) matches only a field list at `docs/refactoring-plan.md:441`. The plugin
comment (`DirectoryReaderPlugin.java:28-38`) covers performance only, and the `? 0L`
coalesce carries no comment (`:181`). No fixture models a null, zero or unchanged mtime:
`tests/unit/browse/folderScan.test.ts:44-50` omits `modifiedAt` and `:288-298` pins the
`undefined` result, `tests/unit/browse/libraryCache.test.ts:29-35` omits it and `:178`,
`:217` only round-trip a number or `undefined`. Apart from the coalesce and those
fixtures the repo records nothing on this point, so this half stays unresolved as posed.

**Platform reference.** Android's own documentation for
`DocumentsContract.Document#COLUMN_LAST_MODIFIED` says the column "is required, and may
be null if unknown", and that a provider "can update this field using events from
OnCloseListener or other reliable ParcelFileDescriptor transports", i.e. no freshness
obligation and no stated granularity
(<https://developer.android.com/reference/android/provider/DocumentsContract.Document#COLUMN_LAST_MODIFIED>,
section heading COLUMN_LAST_MODIFIED); `DocumentFile#lastModified()` documents the
unknown sentinel as 0 ("Returns 0 if the file does not exist, or if the modified time is
unknown",
<https://developer.android.com/reference/androidx/documentfile/provider/DocumentFile#lastModified()>,
section heading lastModified()). No Android page states whether a directory's timestamp
tracks its children; the nearest primary source is POSIX.1-2017, whose `unlink` marks
"the last data modification and last file status change timestamps of the parent
directory" for update
(<https://pubs.opengroup.org/onlinepubs/9699919799/functions/unlink.html>, DESCRIPTION)
and whose §4.9 permits that update to land late
(<https://pubs.opengroup.org/onlinepubs/9699919799/basedefs/V1_chap04.html#tag_04_09>,
section heading 4.9 File Times Update).

## Q14

For a file, one provider-assigned value is stable across restarts and survives to cache:
the document URI in `path`, built at `DirectoryReaderPlugin.java:191-193`, `:264-265`,
`:321-322` and stored at `:409`, then persisted at `src/lib/models/music.ts:63` and
`src/lib/browse/libraryCache.ts:74`. `relativePath` is name-based, so it changes on
rename. For a directory there is nothing: the folder object has three fields
(`:255-257`), `resolveDocumentId` recomputes the id on every call from the tree root
(`:346`) plus one child query per segment (`:357-376`) and returns it as a local
(`:384`), and nothing directory-shaped is persisted (`src/lib/models/music.ts:68`;
`src/lib/browse/libraryCache.ts:60-82`). The platform analogue is the document id, which
"must not change once returned"
(<https://developer.android.com/reference/android/provider/DocumentsProvider>, class
description).

## Q15

A native failure rejects and propagates: `DirectoryReaderPlugin.java:154` for a missing
session and `:118-122` for an unreachable start directory, while per-directory failures
are swallowed (`:196-198`). `src/lib/browse/folderScan.ts:91-99` is a `finally` that
cancels the session when `!scanCompleted` and rethrows, with no `catch` and no fallback
listing. `src/lib/device/deviceLibrary.svelte.ts:199-201` catches it and only
`console.error`s, then clears `libraryScanPromise` and `scanProgress` (`:202-207`), so no
toast or alert reaches the user and `view.allFiles` keeps the partial batches appended
at `:178`. A failed rescan additionally leaves no cache, because
`rescanCurrentLibraryIndex` deleted both keys first (`:218-221`) and the rewriting `.then`
never runs. The folder-play caller logs only and resolves `false`
(`src/lib/components/views/Mp3PlayerView.svelte:1230-1236`); `restoreLocalLibrary`'s
catch is empty (`src/lib/device/deviceLibrary.svelte.ts:301-303`) and so is
`reconnectFolder`'s (`:463`).

## Q16

Per file, two shapes: `CachedWebLibraryFile` = `source`, `name`, `relativePath`, `file`
(`src/lib/models/music.ts:58`), and `CachedNativeLibraryFile` = `source`, `name`,
`relativePath`, `path`, optional `mimeType`, optional `modifiedAt`
(`src/lib/models/music.ts:59-66`). Per library, `CachedLibrary` = `folderName`, `files`,
`savedAt`, optional `cacheKey` (`src/lib/models/music.ts:68`). The write mapping copies
exactly those fields, keeping the web `File` as is (`src/lib/browse/libraryCache.ts:59-67`)
and rebuilding native entries (`:69-76`), while `drive` entries fall through both
branches and are dropped (`:58-81`; `tests/unit/browse/libraryCache.test.ts:239-244`).
There is no scan-completion flag, no directory or folder record, no tree URI field (the
URI appears only inside the key string, `:42`) and no schema version; the `cacheKey`
field written at `:86` is never read anywhere in `src/` or `tests/`.

## Q17

`getDeviceLibraryCacheKey` (`src/lib/browse/libraryCache.ts:41-45`) derives
`device:<treeUri>` when a tree URI is passed, else `device-folder:<folderName>`, else
`LAST_LIBRARY_CACHE_KEY = 'last-library'` (`:35`). `saveCachedLibrary` writes under the
derived key (`:87`) and then, unless that key already is `last-library`, writes the same
object under `last-library` (`:88-90`), so the mirror is last-write-wins across every
library ever saved. `loadDeviceCachedLibrary` (`:101-108`) reads the derived key first
and returns it if present, so the specific key is authoritative; the mirror is consulted
only after a miss on that key and only when its `folderName` equals the requested one
(`:106-107`), otherwise null. Primitives: `loadCachedLibrary` at
`src/lib/utils/idb.ts:77-86`, `deleteCachedLibrary` at `:88-94`.

## Q18

`loadCachedLibrary` does a plain object-store `get` and casts the result to
`CachedLibrary` (`src/lib/utils/idb.ts:77-86`): no version check, no migration, no
defensive parse, the only guard being a `catch` that returns null (`:83-85`). `openIDB`
(`:43-56`) opens database `music-app` at version 2 and creates `handles` and `libraries`
only when absent (`:48-49`), both without a `keyPath`, so values are unconstrained, and
no payload field records a schema version (`src/lib/models/music.ts:68`). A stored
payload missing `files` therefore throws at the first reader:
`src/lib/components/views/Mp3PlayerView.svelte:1566` (swallowed by the empty `catch` at
`:1597`), `src/lib/device/deviceLibrary.svelte.ts:257` (inside the `try` opened at
`:245`, caught at `:301`), and `src/lib/drive/driveLibrary.ts:473` (inside a
`try`/`finally` with no `catch`). A native entry without `path` is rehydrated with
`path: undefined` (`src/lib/browse/libraryCache.ts:125`) and handed to
`Capacitor.convertFileSrc` unchecked (`src/lib/audio/fileResolver.ts:63`), and an
unrecognised `source` falls into the native branch (`src/lib/browse/libraryCache.ts:117-130`).

## Q19

`savedAt` is written at `src/lib/browse/libraryCache.ts:86` and typed at
`src/lib/models/music.ts:68`, and the only reader in the tree is the Drive cache TTL at
`src/lib/utils/idb.ts:122-124` against `DRIVE_CACHE_TTL` (`:97`). Nothing compares a
device cache's age, so a device library entry never expires and
`loadDeviceCachedLibrary` (`src/lib/browse/libraryCache.ts:101-108`) returns whatever is
stored regardless of `savedAt`; the field appears in tests only as fixture data
(`tests/unit/browse/libraryCache.test.ts:175`, `:203`; `tests/unit/utils/idb.test.ts:78`).

## Q20

Five call sites reach `saveCachedLibrary`. At scan completion
`src/lib/device/deviceLibrary.svelte.ts:197` writes the full result of
`scanNativeAudioFiles` for an Android tree or `collectStoredFilesFromDirHandle` for a web
handle (`:170-173`), under `s.nativeTreeUri` plus the caller's `folderName`: a full
listing. The two hidden inputs write a selection, not a tree: `:407` (`webkitdirectory`,
with `s.nativeTreeUri` nulled just before at `:399`) and `:434` (native
`<input multiple>`, folder name hardcoded to `'Selected Files'`, `:419-421`), both under
a `device-folder:` key. `src/lib/files/fileOps.ts:219` writes `remaining`, the in-memory
index minus the deleted file, with no rescan; it is the only partial rewrite and when
`remaining` is empty it deletes both keys instead (`:224-226`).
`rescanCurrentLibraryIndex` (`src/lib/device/deviceLibrary.svelte.ts:217-221`) deletes
but does not write.

CONFLICT: `src/lib/components/views/Mp3PlayerView.svelte:1224` is listed by cluster 3 as
a fifth full-listing writer (the root folder-play scan, guarded by `path.length === 0` at
`:1221`), while cluster 5 (`Q35`) holds that branch unreachable. The tree supports
cluster 5: `playNativeFolderFromScan` has one caller, `playFolderPath` at `:1286`, whose
only call site is `:2009`, which always passes `[...browsePath, entry.name]` and so never
supplies a zero-length path; the guard at `:1221` therefore never holds and that branch
never writes the cache (`Mp3PlayerView.svelte:1219-1225`, `:2009`).

## Q21

`saveCachedLibrary` returns before opening IndexedDB when the mapped list is empty
(`src/lib/browse/libraryCache.ts:83`; `tests/unit/browse/libraryCache.test.ts:234-238`),
so an empty result is never written and the previous entry stays untouched. Only two
places remove it: `rescanCurrentLibraryIndex` deletes the derived key and then
`last-library` before the scan starts (`src/lib/device/deviceLibrary.svelte.ts:218-221`),
and `forgetDeletedFile` does the same when the index empties
(`src/lib/files/fileOps.ts:224-226`). A scan yielding nothing therefore leaves the old
cache in place on the surviving write path (`src/lib/device/deviceLibrary.svelte.ts:197`
with empty `scannedFiles`), so a stale listing can outlive an emptied folder until a
rescan or a delete-rewrite runs. Empty-cache branches: the Android restore starts a scan
(`:257-263`), while the tree-URI picker branch (`:343-347`) and the web handle branch
(`:382-386`) leave `allFiles` empty and start nothing.

## Q22

`idbPut` takes `value: unknown` and calls `put(value, key)` (`src/lib/utils/idb.ts:24-31`)
into a store created without a `keyPath` (`:48-49`), so no shape is rejected on write.
IndexedDB stores values by structured clone, whose supported types include `File` and
`Blob` and plain objects, and which recurses through the input object
(<https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Structured_clone_algorithm>);
every stored value here is a plain object of primitives, further plain objects and
`File`s, so a round trip preserves unknown extra fields and the `File` the web branch
stores (`src/lib/browse/libraryCache.ts:63`). Nothing rejects an unexpected key: readers
access named properties only (`:102-107`, `:116-130`) and there is no `Object.keys`,
`JSON.parse` or schema check in the cache path. Narrowing happens at the two mapping
boundaries instead (`:58-81`, `:115-130`), so a new field survives IndexedDB but is
dropped unless both mappings are extended; no test round-trips a web entry with its
`File` (`tests/unit/browse/libraryCache.test.ts:213-255`).

## Q23

`deleteCachedLibrary` (`src/lib/utils/idb.ts:88-94`) is a single unconditional
`idbDelete` (`:33-41`) on one key, with no backup, tombstone, version history or restore
path. Its callers are `rescanCurrentLibraryIndex`, which deletes the derived key and the
mirror before scanning (`src/lib/device/deviceLibrary.svelte.ts:218-221`), and
`forgetDeletedFile`, which deletes both when the index empties
(`src/lib/files/fileOps.ts:224-226`). If a delete lands and the following scan never
completes, the persisted file list is gone and nothing else holds it: `musicSettings`
stores only `nativeTreeUri`, `lastFolderName` and `favoriteFolders`
(`src/lib/stores/settings.svelte.ts:41-42`, `:57`) and Android remembers the tree
permission separately (`src/lib/device/deviceLibrary.svelte.ts:339`), so access survives
while the index does not, and the next cold start restores nothing and starts no scan
(`src/lib/components/views/Mp3PlayerView.svelte:1564-1575`).

## Q24

The reload effect is `src/lib/components/views/Mp3PlayerView.svelte:784-790`: its own
reactive reads are `browsePath` (`:785`), `driveSearch` (`:786`), `browseVersion`
(`:787`) and `musicSettings.librarySource` (`:788`), and because it calls
`loadBrowseEntries` synchronously every pre-`await` read inside the loader also becomes a
dependency: `librarySource` and the drive filter
(`src/lib/browse/browseNavigation.svelte.ts:112`), `sortOrder` in the drive-search branch
(`:115`), `allFiles.length` (`:122`), every element of `allFiles` (`src/lib/models/browse.ts:20`,
called at `browseNavigation.svelte.ts:123`), and `nativeTreeUri` (`:127`, `:176`) and
`rootDirHandle` (`:146`). `libraryScanPromise` is read at `:124` but is a plain `let`
(`src/lib/device/deviceLibrary.svelte.ts:140-141`, deliberately not `$state` per the
comment at `:136-139`), so it never re-triggers a reload, and reads after an `await`
(`browseNavigation.svelte.ts:129`, `:177`) are untracked. The reload fires on both
signals: `bumpBrowseVersion` per scan batch (`deviceLibrary.svelte.ts:179`) and every
`allFiles` write, which a device batch does in the same tick (`:178-179`, coalesced), and
the scan-end assignment at `:194` reloads through the `allFiles` read alone. Overlapping
loads are dropped by the per-instance `browseLoadId` (`browseNavigation.svelte.ts:106`,
`:109`, checked at `:130`, `:178`, `:197`).

## Q25

Counts come from `buildBrowseEntries` (`src/lib/models/browse.ts:15-41`): folders are
derived from path prefixes, and `count` is the number of indexed files whose relative
path continues under that folder name at any depth (`:30-31`, `:34-38`), so no
filesystem child count is involved. The live branches set `count: 0` for native folders,
mid-scan at `src/lib/browse/browseNavigation.svelte.ts:135` and in the no-index listing
at `:184`; only the web `rootDirHandle` branch computes a real count, by iterating one
level deep (`:162-168`). Which branch wins is decided at `:122-126`: the index snapshot
wins when it has at least one entry for the current path, or when
`libraryScanPromise === null` (`:124`), and the live `listEntries` call runs only when
the snapshot is empty for this path, a scan promise exists and `nativeTreeUri` is set
(`:127-129`). With a partial index a folder that has no indexed files yet does not appear
at all (`browse.ts:30-31`), and one with some indexed files shows a partial count.

## Q26

The effect is `Mp3PlayerView.svelte:244-274`: `:245` reads `allFiles.length` into
`total`, `:249` zeroes the tracked length when `total` is below it, `:250` returns
immediately when `total` equals it, `:251-255` clears the index at 0, `:259-263` does the
full rebuild when the tracked length is 0, `:265` slices the tail, `:266` sorts that
slice (through the wrapper at `:899-900`, which reads `musicSettings.sortOrder`), `:271`
merges via `mergeSortedIndex` (`:276-299`) and `:273` records `total`. Every `allFiles`
write in the tree is a whole-array assignment, never a mutation of the existing array
(`Mp3PlayerView.svelte:1222`, `:1567`, `:1590`;
`src/lib/device/deviceLibrary.svelte.ts:163`, `:178`, `:194`, `:251`, `:258`, `:269`,
`:285`, `:294`, `:332`, `:344`, `:375`, `:383`, `:401`, `:428`, `:451`, `:458`, `:572`;
`src/lib/drive/driveLibrary.ts:235`, `:248`, `:260`, `:270`, `:467`, `:474`;
`src/lib/files/fileOps.ts:213`), the one in-place write being on the scan's own
accumulator before assignment (`Mp3PlayerView.svelte:1178-1180`).

Consequences: an append with an unchanged prefix takes the tail-slice path correctly; a
replacement by a longer array whose prefix differs (e.g. `:1222`,
`deviceLibrary.svelte.ts:194`, `driveLibrary.ts:248`) never indexes the new array's first
`oldLength` entries; a shorter replacement rebuilds fully via `:249`; an equal-length
replacement with different contents returns at `:250` before reading any element, so the
index keeps removed files (result rows still carry the old objects,
`Mp3PlayerView.svelte:313-320`) and misses every new one, which is reachable through the
Drive background refresh (`driveLibrary.ts:235`, `:248`), the web file inputs
(`deviceLibrary.svelte.ts:401`, `:428`) and any rescan whose removals and additions
balance between two flushes. In-place element assignment notifies nothing the effect
subscribed to; in-place append or splice notifies `length` and takes the tail or reset
path; a shrink by one and grow back by one inside one flush is observed only as its final
length. Two further facts: `mergeSortedIndex` compares with `{ numeric: true }` (`:290`)
while the full build uses plain `localeCompare` for `title`/`artist`
(`src/lib/models/music.ts:222-225`), and the merge never dedupes by key.

## Q27

Five things react to a shrink, none to array identity. `forgetDeletedFile` filters by
`getStoredFileKey`, compares lengths and assigns (`src/lib/files/fileOps.ts:209-222`),
then rewrites the cache (`:218-220`) or deletes the keys (`:224-226`): contents plus
length. The search-index reset (`Mp3PlayerView.svelte:246-249`) is length only, forcing
the rebuild at `:259`. The selection-pruning effect (`:793-810`) reads `allFiles.length`
(`:798`) and maps every element to a key set (`:801`), so contents and length. The browse
reload (`:784-790`) arrives through the loader's `allFiles` read
(`src/lib/browse/browseNavigation.svelte.ts:122-123`), and `hasFolderLoaded`
(`Mp3PlayerView.svelte:589`) is length only. Nothing reacts to a shrink by touching the
queue or `currentIndex`; no consumer compares array identity (`=== allFiles` has no
matches).

## Q28

`hydrateTracksFromLibrary` (`Mp3PlayerView.svelte:116-146`) sorts the list, clears the
player when it is empty (`:120-125`), resets to track 0 when asked (`:127-133`) and
otherwise resumes by `musicSettings.lastTrackKey` falling back to `lastTrackIndex`
(`:138-145`); it is called at scan end only when `trackListLockedByUser` is false
(`deviceLibrary.svelte.ts:196`), and `beginQueue` sets that lock on every user-started
queue (`Mp3PlayerView.svelte:1106`) along with a `queueSessionId` bump (`:1104`) that
`appendTracksToQueue` checks (`:1150`). The player's public surface is `state`, `play`,
`load`, `append`, `clear`, `stop`, `pause`, `resume`, `next`, `prev`, `seek`, `destroy`
(`src/lib/audio/player.svelte.ts:529`, `:530`, `:538`, `:541`, `:578` and the tail of the
returned object), with no remove and no in-place update: `load` replaces the queue through
`loadQueue` (`:292-330`), and `append` merges by `getTrackKey` through
`mergeStoredFiles` (`:550`), returning early when nothing is new (`:551`) and reusing url,
duration and cleanup for keys already queued (`:555-575`). The queue holds a copy, not the
`allFiles` array: `loadQueue` maps the files into new `PlayerTrack` objects (`:299-302`)
and keeps the same `source` objects in a new array, so a later `allFiles` write never
reaches `state.tracks` and a file deleted from the index stays queued and playable until
the queue is replaced.

## Q29

The identity key is `getStoredFileKey` (`src/lib/models/music.ts:114-117`): `d:<fileId>`
for Drive, `n:<relativePath>` for native, `w:<relativePath>` for web, aliased by
`getTrackKey` (`:120-122`), so a rename or move changes the key for native and web files
while Drive files keep theirs. Consumers that would treat a renamed native or web file as
a different file: favourites, which store the key (`src/lib/favorites/favoriteTracks.ts:133`)
and resolve it against `allFiles` and the queue (`:166-167`); the browse selection set
(`Mp3PlayerView.svelte:801`, `:911-915`); the resume key written by `setCurrentTrack`
(`src/lib/audio/player.svelte.ts:217-221`) into `musicSettings.lastTrackKey`
(`src/lib/stores/settings.svelte.ts:46`) and read at `Mp3PlayerView.svelte:138-139`; the
queue merge (`player.svelte.ts:550-551`); `forgetDeletedFile`
(`src/lib/files/fileOps.ts:210-213`); and the current-track highlight
(`Mp3PlayerView.svelte:2028`). `mergeStoredFiles` (`src/lib/models/music.ts:230-241`) is
first-wins by key, so an appended renamed file becomes a second entry and the old entry
is never removed because no merge path reports absence. Nothing here is unresolved.

## Q30

The only cancellation is `scanNativeAudioFiles`'s own `finally`
(`src/lib/browse/folderScan.ts:91-99`), guarded by `scanId && !scanCompleted` at `:92`,
where `scanCompleted` starts false (`:62`) and is assigned only from a resolved batch's
`done` (`:86`); the `cancelAudioScan` at `:94` therefore fires exactly when the `while`
loop (`:70`) is left by an exception, a rejecting `getAudioScanBatch` (`:74`) or a throw
from `onBatch` (`:79`), and a rejected `startAudioScan` (`:67`) leaves `scanId` empty and
cancels nothing. Pinned by `tests/unit/browse/folderScan.test.ts:143-159` (no cancel on
completion) and `:197-215` (cancel on rejection, cancel failure swallowed). Nothing
cancels a running session from outside this function: the only call sites of
`DirectoryReader.cancelAudioScan` in `src/` are the declaration
(`src/lib/native/directory-reader.ts:50`) and `folderScan.ts:94`, so nothing calls it on
unmount, on a new scan, on backgrounding or on a library switch; natively
`cancelAudioScan` only removes the session from the static map
(`DirectoryReaderPlugin.java:214-221`) and `getAudioScanBatch` removes it itself on drain
(`:201-204`).

## Q31

A second `startLibraryScan` is neither prevented nor does it cancel the first:
`src/lib/device/deviceLibrary.svelte.ts:161` has no in-flight check and assigns
`libraryScanPromise = scanPromise` at `:190`, replacing the first promise, after which the
first scan's batch callback fails its identity test (`:177`) and stops writing `allFiles`
and `scanProgress` (`:178-182`) while still draining its live native session; its
completion handler returns early at `:193` so it writes no cache and hydrates no queue,
and the `finally` (`:202-207`) only clears the field when it still owns it. The guarded
callers are the first-search effect, which checks `!deviceLibrary.libraryScanPromise`
(`src/lib/components/views/Mp3PlayerView.svelte:344-347`); the unguarded ones are
`rescanCurrentLibraryIndex` (`deviceLibrary.svelte.ts:210-226`) and the cache-miss branch
of `restoreLocalLibrary` (`:262`). Each deck owns its own `createDeviceLibrary` instance
(`Mp3PlayerView.svelte:415-447`), so this is per deck.

## Q32

Nothing stops or resumes a scan on screen, app or deck changes. There is no app-state
wiring at all: the Capacitor packages are `@capacitor/android`, `core`, `filesystem`,
`haptics` and `@capawesome/capacitor-file-picker` (`package.json:53-57`), `@capacitor/app`
is absent and no `appStateChange` listener exists in `src/`. The mount effect
(`Mp3PlayerView.svelte:1539-1603`) only restores from cache and toggles `isRestoring`
(`:1540`, cleared at `:1599-1600`); the rescan listener (`:1606-1611`) starts a rescan and
never stops one; the `focus`/`visibilitychange` handlers (`:1524-1529`) call
`handleFocusRestore` (`:1505-1522`), whose only action is
`folderPicker.restorePendingDriveFolderPickerIfNeeded()`. The destroy cleanup (`:1613`)
calls `player.destroy()` and `audioCtx?.close()` only, with no `cancelAudioScan`, so an
in-flight scan keeps polling batches after unmount and its callbacks keep writing the
deck's `$state` closure. A deck change is not a remount: both decks stay mounted and are
hidden with `class:hidden` (`src/routes/+page.svelte:206`, `:231-236`).

## Q33

Two native scans of the same tree can run at once and nothing stops them at the protocol
level: each `startAudioScan` allocates its own `UUID.randomUUID()` into the static
`ConcurrentHashMap` (`DirectoryReaderPlugin.java:129-131`, `:42`), so ids never collide,
but there is no per-tree or global guard and the plugin will hold two sessions walking
the same tree. The index scan (`src/lib/device/deviceLibrary.svelte.ts:176`) and the
folder-play scan (`Mp3PlayerView.svelte:1172-1177`) both reach `startAudioScan` this way.
Separation is JS bookkeeping and only partly: `queueSessionId` (`:1104`, guard at
`:1149-1151`) stops a still-streaming folder scan from appending to a replaced queue, and
the `libraryScanPromise === scanPromise` check (`deviceLibrary.svelte.ts:177`, `:193`)
stops a superseded index scan from writing `allFiles`. The folder-play scan writes
`allFiles` only inside the `path.length === 0` branch (`Mp3PlayerView.svelte:1221-1225`),
which per Q20 is unreachable from its only call site, so today it does not overwrite the
index; `trackListLockedByUser` (`:1106`) suppresses only the index scan's queue
hydration (`deviceLibrary.svelte.ts:196`), not its `allFiles` writes or cache write
(`:194`, `:197`).

## Q34

Completion is the native `done` flag: `getAudioScanBatch` computes
`done = session.pendingDirs.isEmpty()` and drops the session when true
(`DirectoryReaderPlugin.java:201-204`, returned at `:210`), and the JS loop mirrors it
into `scanCompleted` (`src/lib/browse/folderScan.ts:86`) and resolves with the collected
files (`:101`). For the index caller completion is the `.then` at
`src/lib/device/deviceLibrary.svelte.ts:192-198`: `allFiles` is replaced (`:194`),
progress cleared (`:195`), the queue hydrated unless locked (`:196`), and only then is
the cache written (`:197`); order and lock are pinned by
`tests/unit/device/deviceLibrary.test.ts:223-246`, `:261-270`. On a mid-scan failure none
of that runs: the `.catch` (`:199-201`) only logs, so nothing is cached,
`hydrateTracksFromLibrary` is not called, `allFiles` keeps the partial batches appended at
`:178`, and progress and the promise are cleared in the `finally` (`:202-207`); the
folder-play caller logs and resolves `false`
(`Mp3PlayerView.svelte:1230-1237`), and the native session is removed by the `finally`
cancel (`folderScan.ts:92-98`).

## Q35

Fourteen triggers reach a scan, a restore, or both (`src/lib/device/deviceLibrary.svelte.ts:230-464`; `src/lib/components/views/Mp3PlayerView.svelte:1539-1603`, `:2009`).

| # | Trigger | Entry point | Starts a scan | Restores cache |
|---|---|---|---|---|
| 1 | App mount, both decks (`src/routes/+page.svelte:206`, `:231-236`) | mount effect `Mp3PlayerView.svelte:1539-1603` | No | Yes, `:1566-1572` |
| 2 | Local tab button (`Mp3PlayerView.svelte:1774`) | `openLocalSourceButton` → `restoreLocalLibrary` (`deviceLibrary.svelte.ts:230-237`) | Only via the cache miss, `:262` | Yes, `:257-260` |
| 3 | Cache miss on a native restore | `restoreLocalLibrary`, `:247-264` | Yes, `:262` | No |
| 4 | Open/change folder, native picker (`Mp3PlayerView.svelte:1665`, `:1669`) | `openFolder`, `deviceLibrary.svelte.ts:310-364` | No | Yes if cached, `:343-347` |
| 5 | Open folder, web picker (`:367-390`) | same | No | Yes, `:382-386` |
| 6 | Reconnect button (`Mp3PlayerView.svelte:1662`) | `reconnectFolder`, `:441-464` | No | Yes, `:457-461` |
| 7 | First search keystroke with an empty index (`Mp3PlayerView.svelte:342-348`) | `:346` | Yes, no reset option | No |
| 8 | Settings rescan (`SettingsView.svelte:765` → `musicView.svelte.ts:45-47` → `Mp3PlayerView.svelte:1606-1611`) | `rescanCurrentLibraryIndex`, `deviceLibrary.svelte.ts:210-226` | Yes, `:224` | No; deletes both keys first `:218-221` |
| 9 | YouTube save (`YoutubePanel.svelte:426`) | same chain as 8 | Yes | No |
| 10 | Device favourite folder (`Mp3PlayerView.svelte:1854`) | `driveLibrary.switchToFavorite` (`src/lib/drive/driveLibrary.ts:461-477`) | No | Yes, `:472-477` |
| 11 | Play on a subfolder (`Mp3PlayerView.svelte:2009`) | `playFolderPath` (`:1286`) → `playNativeFolderFromScan` (`:1159-1238`, scan `:1172`) | Yes, playback scan of that subtree | No |
| 12 | Hidden `webkitdirectory` input (`Mp3PlayerView.svelte:1624`) | `handleFolderInput`, `deviceLibrary.svelte.ts:393-410` | No native scan | No |
| 13 | Hidden file input, native (`Mp3PlayerView.svelte:1633`) | `handleNativeFileInput`, `:412-437` | No | No |
| 14 | Move/copy with no local folder (`fileOps.ts:133`) | `openLocalDestinationPicker`, `:127-138` | No | Yes, via 4/5 |

Two corrections to `questions.md`. The root folder-play scan at
`Mp3PlayerView.svelte:1219-1225` is real code but unreachable: `playFolderPath`'s only
call site at `:2009` always passes at least one segment, so `path.length === 0` never
holds. And `openFolder` never starts a scan even when the picked folder has no cache
(`deviceLibrary.svelte.ts:328-347`, `:375-386`): `allFiles` stays empty and the browse
list goes live.

## Q36

Cold start on Android with `musicSettings.nativeTreeUri` set and no usable cache, once
per deck. The mount effect starts (`Mp3PlayerView.svelte:1539`), `isNativeApp` is true
(`:97`) so `isRestoring = true` (`:1540`) and the RESTORING spinner renders (`:1639-1643`);
`librarySource` defaults to `'device'` (`src/lib/stores/settings.svelte.ts:40`) so the
drive branch (`:1544-1560`) is skipped. `Promise.all` runs `loadHandleFromIDB()` and
`loadDeviceCachedLibrary(...)` (`:1563-1566`), the latter returning null for an empty
cache (`src/lib/browse/libraryCache.ts:101-108`), so nothing is restored: no `allFiles`,
no `hydrateTracksFromLibrary`, no `showQueue`, no bump from `:1566-1572`. Then
`isNativeApp && nativeTreeUri` sets `nativeTreeUri`, nulls `rootDirHandle` and
`pendingHandle`, sets `showQueue = true` and bumps `browseVersion` (`:1573-1579`), and
`if (!('showDirectoryPicker' in window) || !handle) return;` (`:1580-1581`) ends the body
on Android. The `finally` clears `isRestoring` (`:1599-1600`) and the bump re-runs the
browse effect, which with empty `allFiles` and null `rootDirHandle` takes the last native
branch (`src/lib/browse/browseNavigation.svelte.ts:177-193`): one live `listEntries` call,
folders with `count: 0` (`:184`), files mapped fresh (`:186`). Nothing starts a scan at
mount; `hasFolderLoaded` (`Mp3PlayerView.svelte:589`) is true because `nativeTreeUri` is
non-null, so the empty-state prompt at `:1645` is skipped, and the user sees the live root
listing with an empty queue, an empty search index (`:244-274` reacts only to `allFiles`)
and no progress bar (`:1809`).

## Q37

`rescanCurrentLibraryIndex` deletes before it scans:
`src/lib/device/deviceLibrary.svelte.ts:216-221` computes the key with
`getDeviceLibraryCacheKey({ treeUri, folderName })`, awaits `deleteCachedLibrary(cacheKey)`
and then `deleteCachedLibrary(LAST_LIBRARY_CACHE_KEY)` when the keys differ, and only
afterwards calls `startLibraryScan(folderName, { resetExistingFiles: true })` if a tree
URI or handle exists (`:223-225`); `startLibraryScan` clears `allFiles`, bumps the browse
version (`:162-165`) and sets `scanProgress` to `{ pct: 0, filesFound: 0 }` (`:166`).
Both deletes are plain record deletes on the `libraries` store
(`src/lib/utils/idb.ts:88-94`) with nothing copied aside, pinned by
`tests/unit/device/deviceLibrary.test.ts:277-302`, which also asserts that with no tree
and no handle `libraryScanPromise` stays null while both keys are still deleted
(`:290-302`). If the following scan fails nothing is written back, because
`saveCachedLibrary` runs only in the success `.then` (`:197`) and the failure `.catch`
(`:199-201`) only logs: IndexedDB is left with no device library entry while in-memory
`allFiles` keeps its partial batches. If the app is killed instead the outcome is the same
and already durable, because both keys are gone before any batch is requested and no
partial cache is ever written.

## Q38

Nothing verifies a restored device cache against the device and no refresh is scheduled.
Each restore branch only reads and applies: `deviceLibrary.svelte.ts:257-260` (native
cache hit), `:293-299` (web), `:343-347` (new native tree with a cache), `:381-386` (new
web handle), `:457-461` (reconnect), plus `Mp3PlayerView.svelte:1566-1572` and
`src/lib/drive/driveLibrary.ts:472-477`; none calls `startLibraryScan`, `listEntries` or
any list call afterwards, and the only follow-ups are `bumpBrowseVersion` and
`hydrateTracksFromLibrary`. There is no staleness check: `savedAt` is written at
`src/lib/browse/libraryCache.ts:86` but its only reader is the Drive TTL at
`src/lib/utils/idb.ts:124`. A file deleted or added while the app was closed therefore
stays wrong in the restored index indefinitely, because the browse list prefers the
non-empty `allFiles` (`browseNavigation.svelte.ts:122-145`) and only a rescan (Q35 8/9),
the first-search scan (trigger 7, which requires `allFiles.length === 0`,
`Mp3PlayerView.svelte:344-347`) or a file op (`src/lib/files/fileOps.ts:209-227`) can
correct it. Drive is the contrast: restoring a Drive cache schedules a background
refresh of the full listing immediately, replacing `allFiles` and re-saving
(`src/lib/drive/driveLibrary.ts:230-250`).

## Q39

Six test files constrain a change here. `tests/unit/device/deviceLibrary.test.ts:223-246`
pins the per-batch path: `scanNativeAudioFiles('content://tree', [], 500, {}, fn)`
(`:241`), `scanProgress` observed inside the batch as `{ pct: 99, filesFound: 1 }`
(`:242`), `allFiles` as `['a.mp3']` (`:243`) and `bumpBrowseVersion` called (`:245`), the
last being the assertion that fails if batches stop bumping, since the reset bump at
`src/lib/device/deviceLibrary.svelte.ts:164` does not fire without `resetExistingFiles`;
`:248-258` pins the reset shape and the no-argument sink; `:261` pins the queue lock;
`:207-219` pins the web write as `saveCachedLibrary(null, 'Music', view.allFiles)`;
`:277-318` pins that a rescan deletes both keys before scanning and that no scan starts
without a tree, asserting the ordered call lists `['device:content://tree',
'last-library']` (`:285`) and `['device-folder:Library', 'last-library']` (`:299`).
`tests/unit/browse/folderScan.test.ts:143-215` pins result order, per-batch state objects
with cumulative `foldersScanned`/`foldersQueued`/`totalFiles`, the two batch-size rules,
the empty-batch suppression, no cancel on completion (`:158`) and cancel on rejection
(`:202-203`) with the failure swallowed (`:212-213`).
`tests/unit/browse/libraryCache.test.ts:212-218` and `:183-193` use strict `toEqual`
against exactly the six native keys, so a field added to a cached entry and propagated by
`restoreStoredFilesFromCache` (`src/lib/browse/libraryCache.ts:115-129`) breaks both;
`:221-255` pins key derivation, the mirror write, the folder-name guard, the empty and
drive-only early returns and the explicit key, while a new top-level key on
`CachedLibrary` (`src/lib/models/music.ts:68`) fails nothing.
`tests/unit/browse/browseNavigation.test.ts:132-215` pins snapshot-versus-live precedence
through the completeness test at `src/lib/browse/browseNavigation.svelte.ts:124`,
`tests/unit/files/deleteUpdatesView.test.ts:102-130` pins that a delete rewrites
`allFiles` and the browse view reacts, and `tests/unit/utils/idb.test.ts:48-57` pins only
the empty-key behaviour of the raw store.

## Q40

The Java plugin has no test of its own: the only files in a test source set are the two
Capacitor templates, `ExampleUnitTest.java:12-18` (`4 == 2 + 2`) and
`ExampleInstrumentedTest.java:16-25`, whose package assertion
`"com.getcapacitor.app"` (`:24`) is stale against `applicationId
com.maverock24.mobilemediaapp` (`android/app/build.gradle:36`) and would fail on a device.
There is no test double for the provider layer: a repo-wide grep for `robolectric`,
`MockCursor`, `shadowOf` and `mockito` (excluding `node_modules` and `*/build/`) returns
no matches, and the test dependencies are the stock set
(`android/app/build.gradle:108-110`). No JS test reads the plugin source, since the JS
side mocks the bridge module instead (`tests/unit/device/deviceLibrary.test.ts:33-39`).
The only automated guarantee about the plugin's shape is the CI DEX check (Q41).

## Q41

The repo `AGENTS.md` claim is wrong and `quality.yml` is right (`AGENTS.md:26` against
`.github/workflows/quality.yml:7`, `:50`), so this is recorded as a documentation
conflict rather than an open question.

CONFLICT: `AGENTS.md:26` says "No workflow compiles Java on a pull request", while
`.github/workflows/quality.yml:7` triggers on `pull_request:` and `:50` declares
`android-release-compile:` as a top-level job with no `if:` and no `needs:` anywhere in
the file, so it runs on every run of the workflow including pull requests. The workflow is
the true statement: its steps are `./gradlew assembleRelease` (`:96-100`), the benchmark
assemblies (`:105-108`) and the DEX assertion (`:117-201`), whose `CLASSES` list is at
`:169` and whose `METHODS` map at `:170-177` names `rememberTreeUri`, `startAudioScan`,
`getAudioScanBatch`, `cancelAudioScan`, `listEntries`, `listAudioFiles`, `writeFile`,
`appendFileChunk`, `deleteEntry`, `copyEntry`, `moveEntry` and `installApk` for
`DirectoryReaderPlugin` (`:171`), requiring the class descriptor, a no-arg `<init>()V`
and each name in the dexdump of the minified APK (`:179-196`). No Java test runs anywhere
in CI: the only Gradle invocations across the four workflows are `assembleDebug`,
`assembleRelease`, `assemble<variant>` and the two benchmark tasks, and no workflow runs
`test`, `testDebugUnitTest`, `connectedAndroidTest` or `lint`. The JS side of a pull
request is the `validate` job (`:14-48`): `pnpm check` (`:39`), `pnpm test` (`:42`) and
`pnpm test:e2e` (`:48`), where `pnpm test` is `vitest run` over
`src/**/*.{test,spec}.{ts,js}` and `tests/unit/**/*.{test,spec}.{ts,js}`
(`package.json:21`; `vite.config.ts:38`).

## Q42

There is no ADR and no state spec for the library index or the scan lifecycle.
`docs/adr/` holds three Accepted files, none about scanning or caching:
`0001-player-module.md:1`, `0002-file-move-copy-delete.md:1` and
`0003-youtube-audio-playback.md:1`; scanning appears in `0001-player-module.md:11` and
`:49` only as a concern the view keeps, and `0002` never mentions the library cache even
though `src/lib/files/fileOps.ts` rewrites it. `docs/state/_index.md:5-8` lists exactly
four machines (Audio Playback Lifecycle, Google Drive Auth, Sleep Timer, YouTube Playback
Lifecycle), none of which covers scan or cache: `scan` has no match under `docs/state/`
and only the two incidental mentions under `docs/adr/`. The nearest prose is
`docs/refactoring-plan.md:143-158`, an extraction record for `libraryCache`, not a
decision. The placement rule is `AGENTS.md:25` (decisions to `docs/adr/`, runtime state
machines to `docs/state/`) with the spec format at `docs/state/_index.md:10`.

---

## Unresolved

1. **Directory mtime propagation (Q13, platform half).** No Android documentation states whether a directory's `COLUMN_LAST_MODIFIED` changes when its direct children change, or when something deeper does; only the column's definition, its permission to be null and its optional update are documented. POSIX marks only the immediate parent and even that may be deferred, but no Android doc requires a provider to be POSIX-backed. Settling it takes a recorded device observation against the actual providers in use, or the provider's own source.
2. **Q13 repo half as posed.** `docs/device-verification.md:37-51` and `:304-319` do not discuss mtime or provider variance, and `docs/adr/0002-file-move-copy-delete.md` never mentions mtime, so the repo records no note about providers that omit or coarsen the value; the only traces are the `? 0L` coalesce and the fixtures. Settling it takes an on-device probe of `COLUMN_LAST_MODIFIED` per provider, recorded in `docs/device-verification.md`.
3. **Granularity a real provider returns.** Not determinable from the repo: no Java test, no provider fixture, and no recorded device observation of the column (`android/app/src/test/java/com/getcapacitor/myapp/ExampleUnitTest.java:12-18`; `.github/workflows/quality.yml:96-108`). Settling it takes a Robolectric or instrumented fixture that drives a real `ContentResolver`, or one logged scan on the target device.

### Cluster conflicts carried forward

- **Cache writer at `Mp3PlayerView.svelte:1224`.** Cluster 3 (Q20, Q21) counts the root folder-play scan as a full-listing writer; cluster 5 (Q33, Q35) finds it unreachable because the only call site `:2009` always passes at least one path segment. The tree supports cluster 5. Not unresolved as a fact, but any design that reasons about "every cache writer" must pick one reading.
- **`AGENTS.md:26` versus `.github/workflows/quality.yml:7`, `:50`** on whether a pull request compiles Java. The workflow is true; `AGENTS.md` should be corrected, and no design decision depends on it.
