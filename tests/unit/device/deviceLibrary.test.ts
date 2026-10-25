import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { StoredAudioFile } from '$lib/models/music';

// The module under test talks to the native SAF plugin, the FilePicker plugin,
// the device library cache and Google Drive. All are replaced with vi.fn
// stand-ins so the folder-open branches, the scan, the cache deletes and the two
// download paths can be driven without a device, a database or a network. The
// settings store is real: the source, folder names and tree URI live there.
const mocks = vi.hoisted(() => ({
	pickNativeAudioDirectory: vi.fn(),
	scanNativeLibrary: vi.fn(),
	listEntries: vi.fn(),
	rememberTreeUri: vi.fn(),
	writeFile: vi.fn(),
	downloadGoogleDriveFile: vi.fn(),
	getDeviceLibraryCacheKey: vi.fn(),
	saveCachedLibrary: vi.fn(),
	loadDeviceCachedLibrary: vi.fn(),
	restoreStoredFilesFromCache: vi.fn(),
	collectStoredFilesFromDirHandle: vi.fn(),
	deleteCachedLibrary: vi.fn(),
	loadHandleFromIDB: vi.fn(),
	saveHandleToIDB: vi.fn(),
	idbPut: vi.fn(),
	loadCachedLibrary: vi.fn(),
	openIDB: vi.fn(),
	isPluginAvailable: vi.fn(() => true),
	addToast: vi.fn(),
}));

// `scanNativeLibrary` must be exported here: the module imports it, and a missing
// export fails every test in this file on an undefined import. That is the
// intended tripwire for the delta walk.
vi.mock('$lib/browse/folderScan', () => ({
	pickNativeAudioDirectory: mocks.pickNativeAudioDirectory,
	scanNativeLibrary: mocks.scanNativeLibrary,
}));

vi.mock('$lib/native/directory-reader', () => ({
	DirectoryReader: {
		listEntries: mocks.listEntries,
		rememberTreeUri: mocks.rememberTreeUri,
		writeFile: mocks.writeFile,
	},
}));

vi.mock('$lib/google-drive', () => ({
	downloadGoogleDriveFile: mocks.downloadGoogleDriveFile,
}));

vi.mock('$lib/utils/idb', () => ({
	deleteCachedLibrary: mocks.deleteCachedLibrary,
	loadHandleFromIDB: mocks.loadHandleFromIDB,
	saveHandleToIDB: mocks.saveHandleToIDB,
	// The real `libraryCache` module is loaded through the mock below (it owns
	// `hasUsableDirectoryTree`, which the scan decision reads), so the IDB
	// primitives it imports have to be present here.
	idbPut: mocks.idbPut,
	loadCachedLibrary: mocks.loadCachedLibrary,
	openIDB: mocks.openIDB,
}));

// The cache I/O is stubbed; everything else (`hasUsableDirectoryTree`) stays the
// real implementation, so the decision tests exercise the predicate that ships.
vi.mock('$lib/browse/libraryCache', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/browse/libraryCache')>()),
	getDeviceLibraryCacheKey: mocks.getDeviceLibraryCacheKey,
	saveCachedLibrary: mocks.saveCachedLibrary,
	loadDeviceCachedLibrary: mocks.loadDeviceCachedLibrary,
	restoreStoredFilesFromCache: mocks.restoreStoredFilesFromCache,
	collectStoredFilesFromDirHandle: mocks.collectStoredFilesFromDirHandle,
}));

vi.mock('@capacitor/core', () => ({
	Capacitor: { isPluginAvailable: mocks.isPluginAvailable },
}));

vi.mock('$lib/stores/toastStore.svelte', () => ({
	addToast: mocks.addToast,
}));

import {
	createDeviceLibrary,
	type DeviceLibrary,
	type DeviceLibraryOptions,
	type DeviceLibraryView,
	type LibraryScanPrevious,
	type LibraryScanOptions,
} from '$lib/device/deviceLibrary.svelte';
import type { DriveSession } from '$lib/drive/driveSession.svelte';
import { hasUsableDirectoryTree } from '$lib/browse/libraryCache';
import { musicSettings } from '$lib/stores/settings.svelte';

beforeEach(() => {
	vi.clearAllMocks();
	mocks.isPluginAvailable.mockReturnValue(true);
	mocks.getDeviceLibraryCacheKey.mockImplementation((options: { treeUri?: string | null; folderName?: string | null } = {}) => {
		if (options.treeUri) return `device:${options.treeUri}`;
		if (options.folderName) return `device-folder:${options.folderName}`;
		return 'last-library';
	});
	mocks.listEntries.mockResolvedValue({ entries: [], folderName: 'Music' });
	mocks.rememberTreeUri.mockResolvedValue(undefined);
	mocks.writeFile.mockResolvedValue({ path: '/dest/song.mp3' });
	mocks.downloadGoogleDriveFile.mockResolvedValue(new File(['bytes'], 'song.mp3', { type: 'audio/mpeg' }));
	mocks.loadDeviceCachedLibrary.mockResolvedValue(null);
	mocks.restoreStoredFilesFromCache.mockImplementation((cached: { files: StoredAudioFile[] }) => cached.files);
	mocks.collectStoredFilesFromDirHandle.mockResolvedValue([]);
	mocks.scanNativeLibrary.mockResolvedValue({ files: [], dirs: [], skippedDirs: 0, skippedPaths: [], unreadableDirs: 0, completed: true });
	mocks.pickNativeAudioDirectory.mockResolvedValue({ treeUri: 'tree', folderName: 'Music' });
	mocks.deleteCachedLibrary.mockResolvedValue(undefined);
	mocks.loadHandleFromIDB.mockResolvedValue(null);
	mocks.saveHandleToIDB.mockResolvedValue(undefined);
	mocks.addToast.mockReturnValue(undefined);

	musicSettings.librarySource = 'device';
	musicSettings.nativeTreeUri = '';
	musicSettings.lastFolderName = '';
	musicSettings.driveFolderId = '';
	musicSettings.driveFolderName = '';

	delete (window as { showDirectoryPicker?: unknown }).showDirectoryPicker;
});

afterEach(() => {
	delete (window as { showDirectoryPicker?: unknown }).showDirectoryPicker;
});

// ── helpers ──────────────────────────────────────────────────

const nativeFile = (name: string): StoredAudioFile => ({
	source: 'native', name, relativePath: name, path: `/sdcard/${name}`, mimeType: 'audio/mpeg',
	modifiedAt: 100, sizeBytes: 1000,
});

/** A cached native file, the shape a payload carries. */
const cachedNativeFile = (name: string) => ({
	source: 'native' as const, name, relativePath: name, path: `/sdcard/${name}`,
	mimeType: 'audio/mpeg', modifiedAt: 100, sizeBytes: 1000,
});

/**
 * A native walk result: the files and directory rows it observed, plus the relative
 * paths and the count of directories it skipped because their mtime still matched.
 * The two skip fields are independent on the wire, so `overrides` can disagree with
 * the paths, which is what an APK that predates `skippedPaths` looks like. The walk
 * reached `done` unless a test says otherwise.
 */
const walkResult = (
	files: StoredAudioFile[] = [],
	dirs: Array<{ path: string; mtime: number }> = [],
	skippedPaths: string[] = [],
	overrides: { skippedDirs?: number; unreadableDirs?: number; completed?: boolean } = {}
) => ({
	files,
	dirs,
	skippedDirs: skippedPaths.length,
	skippedPaths,
	unreadableDirs: 0,
	completed: true,
	...overrides
});

/** A cached payload a delta walk can trust: versioned, stamped, with a tree. */
const usableCache = (overrides: Record<string, unknown> = {}) => ({
	folderName: 'Music',
	files: [cachedNativeFile('a.mp3')],
	savedAt: 1,
	schemaVersion: 1,
	completedAt: Date.now(),
	dirs: [{ path: '', mtime: 5 }],
	...overrides,
});

const driveStored = (name: string): StoredAudioFile => ({
	source: 'drive', name, relativePath: name, fileId: `id:${name}`, mimeType: 'audio/mpeg',
});

const nativeFolder = (name: string) => ({ kind: 'folder' as const, name, relativePath: name });

function makeView() {
	return {
		allFiles: [] as StoredAudioFile[],
		browsePath: [] as string[],
		showQueue: false,
		isLoading: false,
		driveSearch: '',
		transferFile: null as StoredAudioFile | null,
		transferDirection: 'upload' as 'upload' | 'download',
		isTransferring: false,
		transferProgress: null as { loaded: number; total: number } | null,
		transferPhase: 'downloading' as 'downloading' | 'saving',
		showLocalFolderPicker: false,
		isFileOpRunning: false,
		pendingFileOp: null as { op: string } | null,
	};
}

/** A fresh device library wired to inert stand-ins unless a test overrides them. */
function makeDeviceLibrary(overrides: Partial<DeviceLibraryOptions> = {}) {
	const view = makeView();
	const driveSession = {
		ensureDriveAccessToken: vi.fn().mockResolvedValue('tok'),
	} as unknown as DriveSession;
	const bumpBrowseVersion = vi.fn();
	const bumpLibraryRevision = vi.fn();
	const hydrateTracksFromLibrary = vi.fn();
	const runPendingFileOp = vi.fn().mockResolvedValue(undefined);
	const refreshDriveLibrary = vi.fn().mockResolvedValue(undefined);
	const folderInputEl = { click: vi.fn() } as unknown as HTMLInputElement;
	const nativeFileInputEl = { click: vi.fn() } as unknown as HTMLInputElement;

	const lib = createDeviceLibrary({
		driveSession,
		view: view as DeviceLibraryView,
		isNativeApp: false,
		getFolderInputEl: () => folderInputEl,
		getNativeFileInputEl: () => nativeFileInputEl,
		bumpBrowseVersion,
		bumpLibraryRevision,
		hydrateTracksFromLibrary,
		runPendingFileOp,
		refreshDriveLibrary,
		...overrides,
	});

	return {
		lib, view, driveSession, bumpBrowseVersion, bumpLibraryRevision, hydrateTracksFromLibrary,
		runPendingFileOp, refreshDriveLibrary, folderInputEl, nativeFileInputEl,
	};
}

/** Record every assignment to `view.allFiles`, so "publishes once" is observable. */
function trackAllFiles(view: { allFiles: StoredAudioFile[] }) {
	const writes: StoredAudioFile[][] = [];
	let current = view.allFiles;
	Object.defineProperty(view, 'allFiles', {
		configurable: true,
		get: () => current,
		set: (value: StoredAudioFile[]) => { writes.push(value); current = value; },
	});
	return writes;
}

/** Run a scan and wait for the fired-and-forgotten promise chain to settle. */
function startScan(lib: DeviceLibrary, folderName = 'Library', options: LibraryScanOptions = {}) {
	lib.startLibraryScan(folderName, options);
	return waitForScanToSettle(lib);
}

/** Wait until the already-started scan's promise chain has settled. */
function waitForScanToSettle(lib: DeviceLibrary) {
	return vi.waitFor(() => {
		if (lib.libraryScanPromise) throw new Error('scan still running');
	});
}

/** Wait for the warm start's scheduled walk to start and finish. */
async function waitForWarmStartScan(lib: DeviceLibrary) {
	await vi.waitFor(() => {
		if (mocks.scanNativeLibrary.mock.calls.length === 0) throw new Error('warm start scan not started');
	});
	await waitForScanToSettle(lib);
}

/** A cached native entry, the shape a payload carries, rebuilt from a scanned file. */
function toCachedNative(file: StoredAudioFile) {
	if (file.source !== 'native') throw new Error(`not a native file: ${file.name}`);
	return {
		source: 'native' as const,
		name: file.name,
		relativePath: file.relativePath,
		path: file.path,
		mimeType: file.mimeType,
		modifiedAt: file.modifiedAt,
		sizeBytes: file.sizeBytes,
	};
}

/**
 * The payload a completed walk writes, read back from the real write path: run one
 * scan whose native walk reports `dirs`, then hand back the files and the tree the
 * module stored. A hand-written `{ path: '', mtime }` row is what hid the walker
 * never emitting one, so the fixtures that care about the root row build it here.
 */
async function cachedPayloadFromRealWalk(
	files: StoredAudioFile[],
	dirs: Array<{ path: string; mtime: number }>,
	folderName = 'Music'
) {
	const walk = makeDeviceLibrary({ isNativeApp: true });
	walk.lib.nativeTreeUri = 'content://tree';
	mocks.scanNativeLibrary.mockResolvedValue(walkResult(files, dirs));
	await startScan(walk.lib, folderName);
	const written = mocks.saveCachedLibrary.mock.calls.at(-1);
	if (!written) throw new Error('the walk wrote no cache payload');

	return {
		folderName: written[1] as string,
		files: (written[2] as StoredAudioFile[]).map(toCachedNative),
		savedAt: 1,
		schemaVersion: 1,
		completedAt: Date.now(),
		dirs: written[4] as Array<{ path: string; mtime: number }>
	};
}

// ─────────────────────────────────────────────────────────────
// activateDeviceLibrary
// ─────────────────────────────────────────────────────────────

describe('activateDeviceLibrary', () => {
	it('writes the device source settings and clears the Drive filter', () => {
		const { lib, view } = makeDeviceLibrary();
		musicSettings.librarySource = 'drive';
		musicSettings.lastFolderName = 'Old';
		view.driveSearch = 'query';

		lib.activateDeviceLibrary('Mixtapes');

		expect(musicSettings.librarySource).toBe('device');
		expect(musicSettings.lastFolderName).toBe('Mixtapes');
		expect(lib.deckFolderLabel).toBe('Mixtapes');
		expect(view.driveSearch).toBe('');
	});
});

// ─────────────────────────────────────────────────────────────
// startLibraryScan
// ─────────────────────────────────────────────────────────────

describe('startLibraryScan', () => {
	it('scans a web directory handle, stores the result and hydrates the queue', async () => {
		const { lib, view, hydrateTracksFromLibrary } = makeDeviceLibrary();
		const handle = { name: 'Music', kind: 'directory' } as unknown as FileSystemDirectoryHandle;
		lib.rootDirHandle = handle;
		mocks.collectStoredFilesFromDirHandle.mockResolvedValue([nativeFile('a.mp3'), nativeFile('b.mp3')]);

		await startScan(lib, 'Music');

		expect(mocks.collectStoredFilesFromDirHandle).toHaveBeenCalledWith(handle);
		expect(view.allFiles.map((f) => f.name)).toEqual(['a.mp3', 'b.mp3']);
		expect(hydrateTracksFromLibrary).toHaveBeenCalledWith(view.allFiles);
		// No tree from a File System Access walk. The completion write still happens:
		// a finished walk owns the payload, even an empty one.
		expect(mocks.saveCachedLibrary).toHaveBeenCalledWith(null, 'Music', view.allFiles, undefined, [], { allowEmpty: true });
		expect(lib.scanProgress).toBeNull();
		expect(lib.libraryScanPromise).toBeNull();
	});

	it('streams a native scan batch by batch, bumping the browse version once per frame', async () => {
		vi.useFakeTimers();
		try {
			let made!: ReturnType<typeof makeDeviceLibrary>;
			const progressPerBatch: Array<{ pct: number; filesFound: number } | null> = [];
			const bumpsPerBatch: number[] = [];
			mocks.scanNativeLibrary.mockImplementation(async (_treeUri, _path, _size, _opts, onBatch) => {
				const batch = [nativeFile('a.mp3')];
				// The real plugin awaits a native call before its first batch; yield once
				// so the view's `libraryScanPromise` is assigned before onBatch runs.
				await Promise.resolve();
				// Three batches, all inside one frame.
				await onBatch?.(batch, { done: false, foldersScanned: 1, foldersQueued: 0, totalFiles: 3 });
				progressPerBatch.push(made.lib.scanProgress);
				bumpsPerBatch.push(made.bumpBrowseVersion.mock.calls.length);
				for (const name of ['b.mp3', 'c.mp3']) {
					await onBatch?.([nativeFile(name)], { done: false, foldersScanned: 1, foldersQueued: 0, totalFiles: 3 });
					progressPerBatch.push(made.lib.scanProgress);
					bumpsPerBatch.push(made.bumpBrowseVersion.mock.calls.length);
				}
				return walkResult([nativeFile('a.mp3'), nativeFile('b.mp3'), nativeFile('c.mp3')], [{ path: '', mtime: 9 }]);
			});
			made = makeDeviceLibrary();
			made.lib.nativeTreeUri = 'content://tree';
			const writes = trackAllFiles(made.view);

			made.lib.startLibraryScan('Library');
			// Drains the walk's microtasks and then the frame the bump waits for.
			await vi.advanceTimersByTimeAsync(20);
			expect(made.lib.libraryScanPromise).toBeNull();

			expect(mocks.scanNativeLibrary).toHaveBeenCalledWith('content://tree', [], 500, {}, expect.any(Function));
			// The files still land per batch, and so does the progress: only the bump moved.
			expect(writes.slice(0, 3).map((files) => files.map((f) => f.name))).toEqual([['a.mp3'], ['a.mp3', 'b.mp3'], ['a.mp3', 'b.mp3', 'c.mp3']]);
			expect(progressPerBatch).toEqual([
				{ pct: 99, filesFound: 1 },
				{ pct: 99, filesFound: 2 },
				{ pct: 99, filesFound: 3 },
			]);
			// No bump per batch (D8: the old shape), one bump for the whole frame.
			expect(bumpsPerBatch).toEqual([0, 0, 0]);
			expect(made.bumpBrowseVersion).toHaveBeenCalledTimes(1);
			expect(made.view.allFiles.map((f) => f.name)).toEqual(['a.mp3', 'b.mp3', 'c.mp3']);
			expect(made.hydrateTracksFromLibrary).toHaveBeenCalled();
			// The walk's own directory rows are stored, so the next start can skip them.
			expect(mocks.saveCachedLibrary).toHaveBeenCalledWith(
				'content://tree', 'Library', made.view.allFiles, undefined, [{ path: '', mtime: 9 }], { allowEmpty: true }
			);
		} finally {
			vi.useRealTimers();
		}
	});

	it('clears the existing list first when resetExistingFiles is set', async () => {
		const { lib, view, bumpBrowseVersion, bumpLibraryRevision } = makeDeviceLibrary();
		lib.rootDirHandle = {} as FileSystemDirectoryHandle;
		view.allFiles = [nativeFile('old.mp3')];

		lib.startLibraryScan('Library', { resetExistingFiles: true });

		expect(view.allFiles).toEqual([]);
		expect(bumpBrowseVersion).toHaveBeenCalledWith();
		// The clear is a publish, so the search index has to see it (D9).
		expect(bumpLibraryRevision).toHaveBeenCalledTimes(1);
		expect(lib.scanProgress).toEqual({ pct: 0, filesFound: 0 });
		await startScan(lib);
	});

	it('leaves the queue alone while trackListLockedByUser is set', async () => {
		const { lib, hydrateTracksFromLibrary } = makeDeviceLibrary();
		lib.rootDirHandle = {} as FileSystemDirectoryHandle;
		lib.trackListLockedByUser = true;
		mocks.collectStoredFilesFromDirHandle.mockResolvedValue([nativeFile('a.mp3')]);

		await startScan(lib);

		expect(hydrateTracksFromLibrary).not.toHaveBeenCalled();
	});

	it('a delta publishes the index once', async () => {
		const made = makeDeviceLibrary();
		const previousFile = nativeFile('a.mp3');
		made.view.allFiles = [previousFile];
		const writes = trackAllFiles(made.view);
		made.lib.nativeTreeUri = 'content://tree';
		mocks.scanNativeLibrary.mockResolvedValue(
			walkResult([nativeFile('a.mp3'), nativeFile('b.mp3')], [{ path: '', mtime: 6 }])
		);
		const previous: LibraryScanPrevious = {
			files: [previousFile],
			dirs: [{ path: '', mtime: 5 }],
			completedAt: Date.now(),
		};

		await startScan(made.lib, 'Music', { mode: 'delta', previous });

		// The walk was told what it may skip, and no batch callback is handed over:
		// a delta collects instead of streaming.
		expect(mocks.scanNativeLibrary).toHaveBeenCalledWith('content://tree', [], 500, { prevDirs: previous.dirs });
		// One assignment to `view.allFiles`, holding the merged index, and one bump:
		// a delta never streams batch by batch.
		expect(writes.map((files) => files.map((f) => f.name))).toEqual([['a.mp3', 'b.mp3']]);
		expect(made.bumpBrowseVersion).toHaveBeenCalledTimes(1);
		// One publish, one revision: the search index rebuilds off it (D9).
		expect(made.bumpLibraryRevision).toHaveBeenCalledTimes(1);
		expect(made.hydrateTracksFromLibrary).toHaveBeenCalledWith(writes[0]);
		expect(mocks.saveCachedLibrary).toHaveBeenCalledWith(
			'content://tree', 'Music', writes[0], undefined, [{ path: '', mtime: 6 }], { allowEmpty: true }
		);
	});

	it('skips the queue reload when a delta merged nothing new', async () => {
		const made = makeDeviceLibrary();
		const previousFile = nativeFile('a.mp3');
		made.view.allFiles = [previousFile];
		made.lib.nativeTreeUri = 'content://tree';
		// Same path, same (mtime, size): the merge keeps the previous object.
		mocks.scanNativeLibrary.mockResolvedValue(walkResult([nativeFile('a.mp3')], [{ path: '', mtime: 5 }]));

		await startScan(made.lib, 'Music', {
			mode: 'delta',
			previous: { files: [previousFile], dirs: [{ path: '', mtime: 5 }], completedAt: Date.now() },
		});

		expect(made.hydrateTracksFromLibrary).not.toHaveBeenCalled();
	});

	it('a completed delta that empties the library writes an empty payload', async () => {
		const made = makeDeviceLibrary();
		made.view.allFiles = [nativeFile('a.mp3')];
		const writes = trackAllFiles(made.view);
		made.lib.nativeTreeUri = 'content://tree';
		// Everything the previous walk had is gone from the device.
		mocks.scanNativeLibrary.mockResolvedValue(walkResult([], [{ path: '', mtime: 7 }]));

		await startScan(made.lib, 'Music', {
			mode: 'delta',
			previous: { files: [nativeFile('a.mp3')], dirs: [{ path: '', mtime: 5 }], completedAt: Date.now() },
		});

		expect(writes.map((files) => files.length)).toEqual([0]);
		// `allowEmpty` is what makes the completed empty walk reachable at all:
		// without it `saveCachedLibrary` returns before touching IndexedDB.
		expect(mocks.saveCachedLibrary).toHaveBeenCalledWith(
			'content://tree', 'Music', [], undefined, [{ path: '', mtime: 7 }], { allowEmpty: true }
		);
	});

	it('protects only the directories the walk actually skipped', async () => {
		const made = makeDeviceLibrary();
		made.lib.nativeTreeUri = 'content://tree';
		// Three previous directories: one the walker skipped, one it re-observed with
		// no change, and one the user removed from the device. The removed one is
		// absent from `dirs` *and* from the walk's skip report, which is the only way
		// to tell it apart from the skipped one.
		const skippedFile = nativeFile('Alpha/a.mp3');
		const observedFile = nativeFile('Beta/b.mp3');
		const removedFile = nativeFile('Zeta/z.mp3');
		// The warm start restores the payload into the live index before it schedules
		// the walk, so the live index is what the merge reads as `previous`.
		made.view.allFiles = [skippedFile, observedFile, removedFile];
		mocks.scanNativeLibrary.mockResolvedValue(
			walkResult([observedFile], [{ path: 'Beta', mtime: 20 }], ['Alpha'])
		);
		const previous: LibraryScanPrevious = {
			files: [skippedFile, observedFile, removedFile],
			dirs: [
				{ path: 'Alpha', mtime: 10 },
				{ path: 'Beta', mtime: 20 },
				{ path: 'Zeta', mtime: 30 },
			],
			completedAt: Date.now(),
		};

		await startScan(made.lib, 'Music', { mode: 'delta', previous });

		// Alpha's file survives because the walker said it skipped Alpha; Zeta's is
		// pruned because the walker never mentioned Zeta and the walk completed.
		expect(made.view.allFiles.map((f) => f.relativePath)).toEqual(['Beta/b.mp3', 'Alpha/a.mp3']);
	});

	it('prunes a file whose directory was removed from the device', async () => {
		const made = makeDeviceLibrary();
		made.lib.nativeTreeUri = 'content://tree';
		const keptFile = nativeFile('Alpha/a.mp3');
		const removedFile = nativeFile('Deleted/d.mp3');
		made.view.allFiles = [keptFile, removedFile];
		// The walk skips the unchanged Alpha folder and never mentions Deleted, which
		// is what deleting a whole folder looks like from the walk's side.
		mocks.scanNativeLibrary.mockResolvedValue(walkResult([], [], ['Alpha']));

		await startScan(made.lib, 'Music', {
			mode: 'delta',
			previous: {
				files: [keptFile, removedFile],
				dirs: [{ path: 'Alpha', mtime: 10 }, { path: 'Deleted', mtime: 20 }],
				completedAt: Date.now(),
			},
		});

		expect(made.view.allFiles.map((f) => f.relativePath)).toEqual(['Alpha/a.mp3']);
		// The pruned index is what gets written, so the folder does not come back on
		// the next start, and the removed row leaves the tree with it.
		expect(mocks.saveCachedLibrary).toHaveBeenCalledWith(
			'content://tree', 'Music', [keptFile], undefined, [{ path: 'Alpha', mtime: 10 }], { allowEmpty: true }
		);
	});

	it('keeps a file added after the restore when its directory was skipped', async () => {
		const made = makeDeviceLibrary();
		made.lib.nativeTreeUri = 'content://tree';
		// The restored payload the warm start holds, and the row the player's live
		// index gains while the walk runs: a Drive download writing its native copy
		// into Downloads and appending it to `view.allFiles`.
		const restoredFile = nativeFile('Alpha/a.mp3');
		const downloaded: StoredAudioFile = {
			source: 'native',
			name: 'song.mp3',
			relativePath: 'Downloads/song.mp3',
			path: '/sdcard/Downloads/song.mp3',
			mimeType: 'audio/mpeg',
			modifiedAt: Date.now()
		};
		made.view.allFiles = [restoredFile, downloaded];
		// Both directories were skipped on their mtime, so the walk observed no file at
		// all and neither file is in its output.
		mocks.scanNativeLibrary.mockResolvedValue(walkResult([], [], ['Alpha', 'Downloads']));
		const previous: LibraryScanPrevious = {
			files: [restoredFile],
			dirs: [{ path: 'Alpha', mtime: 10 }],
			completedAt: Date.now(),
		};

		await startScan(made.lib, 'Music', { mode: 'delta', previous });

		// The download is still on the device, so the publish must not drop it. Merging
		// against the restored list instead of the live index would lose it until the
		// next full walk.
		expect(made.view.allFiles.map((f) => f.relativePath)).toEqual(['Alpha/a.mp3', 'Downloads/song.mp3']);
		expect(made.view.allFiles[1]).toBe(downloaded);
	});

	it('prunes nothing when the walk reports skips without paths', async () => {
		const made = makeDeviceLibrary();
		made.lib.nativeTreeUri = 'content://tree';
		const keptFile = nativeFile('Music/Live/a.mp3');
		const alsoKeptFile = nativeFile('Music/Studio/b.mp3');
		made.view.allFiles = [keptFile, alsoKeptFile];
		// Two directories skipped and no path named, which is the payload of an APK
		// that predates `skippedPaths`. Nothing under them is verified.
		mocks.scanNativeLibrary.mockResolvedValue(
			walkResult([], [{ path: 'Music/Other', mtime: 20 }], [], { skippedDirs: 2 })
		);

		await startScan(made.lib, 'Music', {
			mode: 'delta',
			previous: {
				files: [keptFile, alsoKeptFile],
				dirs: [{ path: 'Music/Live', mtime: 10 }, { path: 'Music/Studio', mtime: 15 }],
				completedAt: Date.now(),
			},
		});

		expect(made.view.allFiles.map((f) => f.relativePath)).toEqual([
			'Music/Live/a.mp3',
			'Music/Studio/b.mp3',
		]);
		// The tree keeps only the row the walk observed: a row it cannot attribute to
		// a named skip is dropped, so the next walk descends it instead of trusting it.
		expect(mocks.saveCachedLibrary).toHaveBeenCalledWith(
			'content://tree', 'Music', [keptFile, alsoKeptFile], undefined,
			[{ path: 'Music/Other', mtime: 20 }],
			{ allowEmpty: true }
		);
	});

	it('prunes nothing when the walk did not complete', async () => {
		const made = makeDeviceLibrary();
		made.lib.nativeTreeUri = 'content://tree';
		const keptFile = nativeFile('Alpha/a.mp3');
		const unseenFile = nativeFile('Beta/b.mp3');
		made.view.allFiles = [keptFile, unseenFile];
		// A walk that stopped without a `done` batch: it re-observed Alpha and never
		// reached Beta, and it says so in its own result rather than by throwing.
		mocks.scanNativeLibrary.mockResolvedValue(
			walkResult([keptFile], [{ path: 'Alpha', mtime: 10 }], [], { completed: false })
		);

		await startScan(made.lib, 'Music', {
			mode: 'delta',
			previous: {
				files: [keptFile, unseenFile],
				dirs: [{ path: 'Alpha', mtime: 10 }, { path: 'Beta', mtime: 20 }],
				completedAt: Date.now(),
			},
		});

		// Beta was never reached and the walk admits it did not finish, so its file
		// stays even though the walk completed no skip report to protect it.
		expect(made.view.allFiles.map((f) => f.relativePath)).toEqual(['Alpha/a.mp3', 'Beta/b.mp3']);
	});

	it('a completed full walk that empties the library writes an empty payload', async () => {
		const made = makeDeviceLibrary();
		made.view.allFiles = [nativeFile('a.mp3')];
		const writes = trackAllFiles(made.view);
		made.lib.nativeTreeUri = 'content://tree';
		// A full walk of a folder the user emptied: no files, the root visited.
		mocks.scanNativeLibrary.mockResolvedValue(walkResult([], [{ path: '', mtime: 7 }]));

		await startScan(made.lib, 'Music');

		expect(writes.map((files) => files.length)).toEqual([0]);
		// A full walk owns the payload it produced too, so the stale one cannot
		// outlive the emptied folder until the next walk.
		expect(mocks.saveCachedLibrary).toHaveBeenCalledWith(
			'content://tree', 'Music', [], undefined, [{ path: '', mtime: 7 }], { allowEmpty: true }
		);
	});
});

// ─────────────────────────────────────────────────────────────
// rescanCurrentLibraryIndex
// ─────────────────────────────────────────────────────────────

describe('rescanCurrentLibraryIndex', () => {
	it('does not delete the cache before scanning', async () => {
		const { lib } = makeDeviceLibrary();
		lib.nativeTreeUri = 'content://tree';

		await lib.rescanCurrentLibraryIndex();

		expect(mocks.deleteCachedLibrary).not.toHaveBeenCalled();
		expect(mocks.scanNativeLibrary).toHaveBeenCalledTimes(1);
		await waitForScanToSettle(lib);
	});

	it('a rescan always walks in full', async () => {
		const made = makeDeviceLibrary();
		made.lib.nativeTreeUri = 'content://tree';
		// A payload a warm start would happily run a delta against.
		mocks.loadDeviceCachedLibrary.mockResolvedValue(usableCache());
		made.view.allFiles = [nativeFile('stale.mp3')];

		await made.lib.rescanCurrentLibraryIndex();
		await waitForScanToSettle(made.lib);

		// No decision is taken and no tree is handed over: `{}` means "descend
		// everything", and the walk streams into a list that was cleared first.
		expect(mocks.loadDeviceCachedLibrary).not.toHaveBeenCalled();
		expect(mocks.scanNativeLibrary).toHaveBeenCalledWith('content://tree', [], 500, {}, expect.any(Function));
		expect(made.view.allFiles).toEqual([]);
		// A completed full walk that found nothing writes the empty payload, so the
		// previous one cannot outlive a folder the user emptied.
		expect(mocks.saveCachedLibrary).toHaveBeenCalledWith(
			'content://tree', 'Library', [], undefined, [], { allowEmpty: true }
		);
	});

	it('keeps the stored payload when the rescan fails', async () => {
		const { lib } = makeDeviceLibrary();
		lib.rootDirHandle = {} as FileSystemDirectoryHandle;
		mocks.collectStoredFilesFromDirHandle.mockRejectedValue(new Error('walk failed'));
		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

		await lib.rescanCurrentLibraryIndex();
		await waitForScanToSettle(lib);

		// Nothing removed the key and nothing replaced it, so the previous payload
		// is still what the next start restores.
		expect(mocks.deleteCachedLibrary).not.toHaveBeenCalled();
		expect(mocks.saveCachedLibrary).not.toHaveBeenCalled();
		consoleError.mockRestore();
	});

	it('never deletes the last-library key', async () => {
		const { lib } = makeDeviceLibrary();
		musicSettings.lastFolderName = '';
		lib.nativeTreeUri = null;

		await lib.rescanCurrentLibraryIndex();

		// The derived folder key is no longer computed at all, and the mirror is
		// never a rescan's business: the completion write replaces the payload.
		expect(mocks.deleteCachedLibrary).not.toHaveBeenCalledWith('last-library');
		expect(mocks.deleteCachedLibrary).not.toHaveBeenCalledWith('device-folder:Library');
		// No tree URI or handle — nothing to scan.
		expect(lib.libraryScanPromise).toBeNull();
	});

	it('refreshes Drive instead of touching the device cache for the drive source', async () => {
		const { lib, refreshDriveLibrary } = makeDeviceLibrary();
		musicSettings.librarySource = 'drive';

		await lib.rescanCurrentLibraryIndex();

		expect(refreshDriveLibrary).toHaveBeenCalledTimes(1);
		expect(mocks.deleteCachedLibrary).not.toHaveBeenCalled();
	});
});

// ─────────────────────────────────────────────────────────────
// restoreLocalLibrary + openLocalSourceButton
// ─────────────────────────────────────────────────────────────

describe('restoreLocalLibrary', () => {
	it('returns false when there is nothing to restore', async () => {
		const { lib } = makeDeviceLibrary();

		await expect(lib.restoreLocalLibrary()).resolves.toBe(false);
	});

	it('restores the native SAF tree from cache, then walks in full when the payload has no tree', async () => {
		const { lib, view, hydrateTracksFromLibrary, bumpLibraryRevision } = makeDeviceLibrary({ isNativeApp: true });
		musicSettings.nativeTreeUri = 'content://tree';
		musicSettings.lastFolderName = 'Music';
		// The shape every device holds today: files, no schemaVersion, no rows.
		mocks.loadDeviceCachedLibrary.mockResolvedValue({ folderName: 'Music', files: [cachedNativeFile('a.mp3')] });
		const writes = trackAllFiles(view);

		await expect(lib.restoreLocalLibrary()).resolves.toBe(true);

		expect(lib.nativeTreeUri).toBe('content://tree');
		expect(lib.rootDirHandle).toBeNull();
		expect(hydrateTracksFromLibrary).toHaveBeenCalled();
		// The cache restore is a publish too, so the search index sees it (D9).
		expect(bumpLibraryRevision).toHaveBeenCalled();
		// The cached list is restored, then the background full walk publishes its
		// own result once (the mocked walk finds nothing).
		expect(writes.map((files) => files.map((f) => f.name))).toEqual([[], ['a.mp3'], []]);

		// Nothing to skip against, so the background walk is the full fallback: no
		// `prevDirs`, and no batch callback because it publishes once.
		await waitForWarmStartScan(lib);
		expect(mocks.scanNativeLibrary).toHaveBeenCalledWith('content://tree', [], 500, {}, undefined);
	});

	it('a warm start runs a delta walk without clearing the list', async () => {
		const made = makeDeviceLibrary({ isNativeApp: true });
		musicSettings.nativeTreeUri = 'content://tree';
		musicSettings.lastFolderName = 'Music';
		const cached = usableCache();
		mocks.loadDeviceCachedLibrary.mockResolvedValue(cached);
		const writes = trackAllFiles(made.view);
		mocks.scanNativeLibrary.mockResolvedValue(
			walkResult([nativeFile('a.mp3'), nativeFile('b.mp3')], [{ path: '', mtime: 6 }])
		);

		await expect(made.lib.restoreLocalLibrary()).resolves.toBe(true);
		await waitForWarmStartScan(made.lib);

		// The native branch's own clear, the cached list put back, and exactly one
		// delta publish holding the merged index: no clear and no partial batch in
		// between, whatever the walk's timing.
		expect(writes.map((files) => files.map((f) => f.name))).toEqual([[], ['a.mp3'], ['a.mp3', 'b.mp3']]);
		expect(mocks.scanNativeLibrary).toHaveBeenCalledWith('content://tree', [], 500, { prevDirs: cached.dirs });
	});

	it('starts a scan from the native branch on a cache miss', async () => {
		const { lib } = makeDeviceLibrary({ isNativeApp: true });
		musicSettings.nativeTreeUri = 'content://tree';
		musicSettings.lastFolderName = 'Music';
		mocks.loadDeviceCachedLibrary.mockResolvedValue(null);

		await expect(lib.restoreLocalLibrary()).resolves.toBe(true);

		// The scan fired; its promise is the module's own.
		expect(lib.libraryScanPromise).not.toBeNull();
		await startScan(lib);
	});

	it('reuses an in-memory web root handle', async () => {
		const { lib, view } = makeDeviceLibrary();
		const handle = { name: 'Web', kind: 'directory' } as unknown as FileSystemDirectoryHandle;
		lib.rootDirHandle = handle;
		musicSettings.lastFolderName = 'Web';

		await expect(lib.restoreLocalLibrary()).resolves.toBe(true);

		expect(view.allFiles).toEqual([]);
		expect(lib.deckFolderLabel).toBe('Web');
	});
});

describe('refreshWarmLibrary', () => {
	it('a mount restore starts a background delta', async () => {
		// The payload is what a completed walk wrote, so its tree is the one the walker
		// reports (the scan root row plus the directories it descended into).
		const cached = await cachedPayloadFromRealWalk(
			[nativeFile('a.mp3')],
			[{ path: '', mtime: 5 }, { path: 'Alpha', mtime: 6 }]
		);
		vi.clearAllMocks();
		mocks.loadDeviceCachedLibrary.mockResolvedValue(cached);
		mocks.scanNativeLibrary.mockResolvedValue(
			walkResult([nativeFile('a.mp3'), nativeFile('b.mp3')], cached.dirs)
		);

		// The mount effect's sequence, which is the path the real app takes: restore
		// the cache into the view, adopt the tree URI, then refresh. Nothing here calls
		// `restoreLocalLibrary`, which is only the header button's entry point.
		const made = makeDeviceLibrary({ isNativeApp: true });
		musicSettings.nativeTreeUri = 'content://tree';
		musicSettings.lastFolderName = 'Music';
		const loaded = await mocks.loadDeviceCachedLibrary('content://tree', 'Music');
		made.view.allFiles = mocks.restoreStoredFilesFromCache(loaded);
		made.lib.nativeTreeUri = musicSettings.nativeTreeUri;
		const writes = trackAllFiles(made.view);

		made.lib.refreshWarmLibrary(loaded.folderName, loaded, made.view.allFiles);
		await waitForWarmStartScan(made.lib);

		// A delta, not the full fallback: the restored file list survives untouched and
		// the walk is told what it may skip.
		expect(mocks.scanNativeLibrary).toHaveBeenCalledWith('content://tree', [], 500, { prevDirs: cached.dirs });
		expect(writes.map((files) => files.map((f) => f.name))).toEqual([['a.mp3', 'b.mp3']]);
	});

	it('a second warm refresh while a scan runs does not start another walk', async () => {
		const cached = await cachedPayloadFromRealWalk([nativeFile('a.mp3')], [{ path: '', mtime: 5 }]);
		vi.clearAllMocks();
		mocks.loadDeviceCachedLibrary.mockResolvedValue(cached);

		let release!: () => void;
		const gate = new Promise<void>((resolve) => { release = resolve; });
		mocks.scanNativeLibrary.mockImplementation(async () => {
			await gate;
			return walkResult([nativeFile('a.mp3')], cached.dirs);
		});

		const made = makeDeviceLibrary({ isNativeApp: true });
		made.lib.nativeTreeUri = 'content://tree';
		const restored = mocks.restoreStoredFilesFromCache(cached);

		// Two calls in one tick: the first is still a scheduled microtask here, so the
		// scan promise the guard also reads does not exist yet.
		made.lib.refreshWarmLibrary('Music', cached, restored);
		made.lib.refreshWarmLibrary('Music', cached, restored);
		await vi.waitFor(() => {
			if (!made.lib.libraryScanPromise) throw new Error('warm scan not started');
		});
		// And a third while the walk is in flight.
		made.lib.refreshWarmLibrary('Music', cached, restored);
		release();
		await waitForScanToSettle(made.lib);

		expect(mocks.scanNativeLibrary).toHaveBeenCalledTimes(1);
	});

	it('a library with only root files gets a usable tree', async () => {
		// Every file in the library sits in the tree root, so the walk sees the root and
		// no child directory. The row is what a real walk wrote, not a hand-written one.
		const cached = await cachedPayloadFromRealWalk([nativeFile('a.mp3')], [{ path: '', mtime: 9 }]);
		expect(cached.dirs).toEqual([{ path: '', mtime: 9 }]);
		expect(hasUsableDirectoryTree(cached)).toBe(true);

		vi.clearAllMocks();
		mocks.scanNativeLibrary.mockResolvedValue(walkResult([nativeFile('a.mp3')], cached.dirs));
		const made = makeDeviceLibrary({ isNativeApp: true });
		made.lib.nativeTreeUri = 'content://tree';
		made.view.allFiles = mocks.restoreStoredFilesFromCache(cached);

		made.lib.refreshWarmLibrary(cached.folderName, cached, made.view.allFiles);
		await waitForWarmStartScan(made.lib);

		// A root-only tree is a delta: the root row alone is enough to open the gate.
		expect(mocks.scanNativeLibrary).toHaveBeenCalledWith('content://tree', [], 500, { prevDirs: [{ path: '', mtime: 9 }] });
	});
});

describe('openLocalSourceButton', () => {
	it('opens the picker when nothing is restorable', async () => {
		const { lib, folderInputEl } = makeDeviceLibrary();
		// No tree/handle/folder name → restoreLocalLibrary returns false, then
		// openFolder falls through to the hidden input on the web.
		await lib.openLocalSourceButton();

		expect(folderInputEl.click).toHaveBeenCalledTimes(1);
	});
});

// ─────────────────────────────────────────────────────────────
// openFolder
// ─────────────────────────────────────────────────────────────

describe('openFolder', () => {
	it('uses the web directory picker and restores from cache', async () => {
		const { lib, view } = makeDeviceLibrary();
		const handle = { name: 'Web', kind: 'directory' } as unknown as FileSystemDirectoryHandle;
		(window as { showDirectoryPicker?: unknown }).showDirectoryPicker = vi.fn().mockResolvedValue(handle);
		mocks.loadDeviceCachedLibrary.mockResolvedValue({ folderName: 'Web', files: [{ source: 'native', name: 'a.mp3', relativePath: 'a.mp3', path: '/a.mp3' }] });

		await lib.openFolder();

		expect(lib.rootDirHandle).toEqual(handle);
		expect(lib.nativeTreeUri).toBeNull();
		expect(mocks.saveHandleToIDB).toHaveBeenCalledWith(handle);
		expect(view.allFiles.map((f) => f.name)).toEqual(['a.mp3']);
		expect(view.showQueue).toBe(true);
		expect(view.isLoading).toBe(false);
	});

	it('falls back to the hidden folder input when the web API is missing', async () => {
		const { lib, folderInputEl } = makeDeviceLibrary();

		await lib.openFolder();

		expect(folderInputEl.click).toHaveBeenCalledTimes(1);
	});

	it('opens the native SAF tree and remembers it', async () => {
		const { lib, view } = makeDeviceLibrary({ isNativeApp: true });
		mocks.loadDeviceCachedLibrary.mockResolvedValue({ folderName: 'Music', files: [{ source: 'native', name: 'a.mp3', relativePath: 'a.mp3', path: '/a.mp3' }] });

		await lib.openFolder();

		expect(mocks.pickNativeAudioDirectory).toHaveBeenCalledTimes(1);
		expect(lib.nativeTreeUri).toBe('tree');
		expect(musicSettings.nativeTreeUri).toBe('tree');
		expect(mocks.rememberTreeUri).toHaveBeenCalledWith({ treeUri: 'tree' });
		expect(view.allFiles.map((f) => f.name)).toEqual(['a.mp3']);
		expect(view.isLoading).toBe(false);
	});

	it('clicks the hidden native input when the native picker throws', async () => {
		const { lib, nativeFileInputEl, view } = makeDeviceLibrary({ isNativeApp: true });
		mocks.pickNativeAudioDirectory.mockRejectedValue(new Error('cancelled'));

		await lib.openFolder();

		expect(nativeFileInputEl.click).toHaveBeenCalledTimes(1);
		expect(view.isLoading).toBe(false);
	});

	it('alerts and stops when the native picker returns no tree URI', async () => {
		const { lib, nativeFileInputEl } = makeDeviceLibrary({ isNativeApp: true });
		mocks.pickNativeAudioDirectory.mockResolvedValue({ treeUri: '', folderName: 'Music' });
		const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});

		await lib.openFolder();

		expect(alertSpy).toHaveBeenCalledWith('No MP3 files were found in the selected folder.');
		expect(nativeFileInputEl.click).not.toHaveBeenCalled();
		expect(lib.nativeTreeUri).toBeNull();
		alertSpy.mockRestore();
	});
});

// ─────────────────────────────────────────────────────────────
// handleFolderInput / handleNativeFileInput
// ─────────────────────────────────────────────────────────────

describe('handleFolderInput', () => {
	it('saves the chosen files under the device cache key', () => {
		const { lib, hydrateTracksFromLibrary } = makeDeviceLibrary();
		const file = new File(['a'], 'a.mp3', { type: 'audio/mpeg' });
		const input = { files: [file], value: 'x' };
		const event = { target: input } as unknown as Event;

		lib.handleFolderInput(event);

		expect(mocks.saveCachedLibrary).toHaveBeenCalledWith(null, 'Selected Files', expect.any(Array));
		expect(hydrateTracksFromLibrary).toHaveBeenCalled();
		expect(input.value).toBe('');
	});

	it('alerts and leaves state untouched when nothing supported is picked', () => {
		const { lib } = makeDeviceLibrary();
		const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
		const event = { target: { files: [], value: '' } } as unknown as Event;

		lib.handleFolderInput(event);

		expect(alertSpy).toHaveBeenCalledWith('No supported audio files found in selected folder.');
		expect(mocks.saveCachedLibrary).not.toHaveBeenCalled();
		alertSpy.mockRestore();
	});
});

// ─────────────────────────────────────────────────────────────
// loadLocalFolderPicker / navigateLocalPickerInto
// ─────────────────────────────────────────────────────────────

describe('loadLocalFolderPicker', () => {
	it('no-ops without a tree URI', async () => {
		const { lib } = makeDeviceLibrary();

		await lib.loadLocalFolderPicker('');

		expect(mocks.listEntries).not.toHaveBeenCalled();
		expect(lib.localPickerLoading).toBe(false);
	});

	it('lists entries and toggles the loading flag', async () => {
		const { lib } = makeDeviceLibrary();
		lib.nativeTreeUri = 'tree';
		mocks.listEntries.mockResolvedValue({ entries: [nativeFolder('Albums')], folderName: 'Music' });

		await lib.loadLocalFolderPicker('sub');

		expect(mocks.listEntries).toHaveBeenCalledWith({ treeUri: 'tree', path: 'sub' });
		expect(lib.localPickerEntries.map((e) => e.name)).toEqual(['Albums']);
		expect(lib.localPickerLoading).toBe(false);
	});

	it('toasts on failure and clears the loading flag', async () => {
		const { lib } = makeDeviceLibrary();
		lib.nativeTreeUri = 'tree';
		mocks.listEntries.mockRejectedValue(new Error('boom'));

		await lib.loadLocalFolderPicker('');

		expect(mocks.addToast).toHaveBeenCalledWith({ message: 'Failed to list folders.', type: 'error' });
		expect(lib.localPickerLoading).toBe(false);
	});

	it('navigates into a folder by extending the path', async () => {
		const { lib } = makeDeviceLibrary();
		lib.nativeTreeUri = 'tree';

		lib.navigateLocalPickerInto(nativeFolder('Albums'));

		expect(lib.localPickerPath).toEqual(['Albums']);
		expect(mocks.listEntries).toHaveBeenCalledWith({ treeUri: 'tree', path: 'Albums' });
	});
});

// ─────────────────────────────────────────────────────────────
// reconnectFolder
// ─────────────────────────────────────────────────────────────

describe('reconnectFolder', () => {
	it('does nothing without a pending handle', async () => {
		const { lib } = makeDeviceLibrary();

		await lib.reconnectFolder();

		expect(mocks.loadDeviceCachedLibrary).not.toHaveBeenCalled();
	});

	it('promotes the pending handle to the root on granted permission', async () => {
		const { lib, view } = makeDeviceLibrary();
		const handle = {
			name: 'Web', kind: 'directory',
			requestPermission: vi.fn().mockResolvedValue('granted'),
		} as unknown as FileSystemDirectoryHandle;
		lib.pendingHandle = handle;
		mocks.loadDeviceCachedLibrary.mockResolvedValue({ folderName: 'Web', files: [{ source: 'native', name: 'a.mp3', relativePath: 'a.mp3', path: '/a.mp3' }] });

		await lib.reconnectFolder();

		expect(lib.rootDirHandle).toEqual(handle);
		expect(lib.pendingHandle).toBeNull();
		expect(mocks.saveHandleToIDB).toHaveBeenCalledWith(handle);
		expect(view.allFiles.map((f) => f.name)).toEqual(['a.mp3']);
	});

	it('leaves the pending handle in place when permission is denied', async () => {
		const { lib } = makeDeviceLibrary();
		const handle = { name: 'Web', requestPermission: vi.fn().mockResolvedValue('denied') } as unknown as FileSystemDirectoryHandle;
		lib.pendingHandle = handle;

		await lib.reconnectFolder();

		expect(lib.pendingHandle).toEqual(handle);
		expect(lib.rootDirHandle).toBeNull();
	});
});

// ─────────────────────────────────────────────────────────────
// download paths
// ─────────────────────────────────────────────────────────────

describe('selectLocalFolderAndDownload', () => {
	it('downloads a Drive file into the native picker path and lists it locally', async () => {
		const { lib, view, bumpBrowseVersion } = makeDeviceLibrary();
		lib.nativeTreeUri = 'tree';
		view.transferFile = driveStored('song.mp3');

		await lib.selectLocalFolderAndDownload();

		expect(mocks.downloadGoogleDriveFile).toHaveBeenCalledWith(expect.objectContaining({ accessToken: 'tok', fileId: 'id:song.mp3', fileName: 'song.mp3' }));
		expect(mocks.writeFile).toHaveBeenCalledWith(expect.objectContaining({ treeUri: 'tree', path: '', fileName: 'song.mp3' }));
		expect(view.allFiles.map((f) => f.name)).toEqual(['song.mp3']);
		expect(bumpBrowseVersion).toHaveBeenCalled();
		expect(view.transferPhase).toBe('downloading');
		expect(view.transferFile).toBeNull();
		expect(view.isTransferring).toBe(false);
	});

	it('does not inject a local copy while the Drive source is active', async () => {
		const { lib, view } = makeDeviceLibrary();
		musicSettings.librarySource = 'drive';
		lib.nativeTreeUri = 'tree';
		view.transferFile = driveStored('song.mp3');

		await lib.selectLocalFolderAndDownload();

		expect(view.allFiles).toEqual([]);
	});

	it('hands a pending file op to the view runner instead of downloading', async () => {
		const { lib, view, runPendingFileOp } = makeDeviceLibrary();
		lib.nativeTreeUri = 'tree';
		lib.localPickerPath = ['Albums'];
		view.pendingFileOp = { op: 'move' };

		await lib.selectLocalFolderAndDownload();

		expect(runPendingFileOp).toHaveBeenCalledWith({ localPath: 'Albums' });
		expect(mocks.downloadGoogleDriveFile).not.toHaveBeenCalled();
		expect(view.showLocalFolderPicker).toBe(false);
	});

	it('warns and stops when the Drive token is missing', async () => {
		const { lib, view, driveSession } = makeDeviceLibrary();
		lib.nativeTreeUri = 'tree';
		view.transferFile = driveStored('song.mp3');
		(driveSession.ensureDriveAccessToken as ReturnType<typeof vi.fn>).mockResolvedValue(null);

		await lib.selectLocalFolderAndDownload();

		expect(mocks.addToast).toHaveBeenCalledWith({ message: 'Drive session expired. Please reconnect.', type: 'warning' });
		expect(mocks.writeFile).not.toHaveBeenCalled();
	});
});

describe('downloadToLocalFolder', () => {
	it('warns when the browser has no directory picker and clears the busy flag', async () => {
		const { lib, view } = makeDeviceLibrary();

		await lib.downloadToLocalFolder(driveStored('song.mp3'));

		expect(mocks.addToast).toHaveBeenCalledWith(expect.objectContaining({ message: 'Folder picker not supported in this browser. Try Chrome or Edge.' }));
		expect(view.isTransferring).toBe(false);
	});

	it('writes the downloaded file through the web directory handle', async () => {
		const { lib, view } = makeDeviceLibrary();
		const writable = { write: vi.fn().mockResolvedValue(undefined), close: vi.fn().mockResolvedValue(undefined) };
		const handle = {
			name: 'Downloads',
			getFileHandle: vi.fn().mockResolvedValue({ createWritable: vi.fn().mockResolvedValue(writable) }),
		};
		(window as { showDirectoryPicker?: unknown }).showDirectoryPicker = vi.fn().mockResolvedValue(handle);

		await lib.downloadToLocalFolder(driveStored('song.mp3'));

		expect(mocks.downloadGoogleDriveFile).toHaveBeenCalledWith(expect.objectContaining({ fileName: 'song.mp3' }));
		expect(writable.write).toHaveBeenCalled();
		expect(writable.close).toHaveBeenCalled();
		expect(mocks.addToast).toHaveBeenCalledWith({ message: 'Downloaded "song.mp3" to phone.', type: 'info' });
		expect(view.transferPhase).toBe('downloading');
		expect(view.isTransferring).toBe(false);
	});
});

describe('openLocalDownloadFolderPicker', () => {
	it('opens the web download path when not native', async () => {
		const { lib } = makeDeviceLibrary();
		const writable = { write: vi.fn().mockResolvedValue(undefined), close: vi.fn().mockResolvedValue(undefined) };
		(window as { showDirectoryPicker?: unknown }).showDirectoryPicker = vi.fn().mockResolvedValue({
			name: 'Downloads',
			getFileHandle: vi.fn().mockResolvedValue({ createWritable: vi.fn().mockResolvedValue(writable) }),
		});

		await lib.openLocalDownloadFolderPicker(driveStored('song.mp3'));

		expect(mocks.writeFile).not.toHaveBeenCalled();
		expect(mocks.downloadGoogleDriveFile).toHaveBeenCalled();
	});

	it('opens the local picker when a native tree URI already exists', async () => {
		const { lib, view } = makeDeviceLibrary({ isNativeApp: true });
		lib.nativeTreeUri = 'tree';

		await lib.openLocalDownloadFolderPicker(driveStored('song.mp3'));

		expect(view.showLocalFolderPicker).toBe(true);
		expect(view.transferDirection).toBe('download');
		expect(mocks.listEntries).toHaveBeenCalledWith({ treeUri: 'tree', path: '' });
	});
});
