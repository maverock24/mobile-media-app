import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { StoredAudioFile } from '$lib/models/music';

// The module under test talks to the native SAF plugin, the FilePicker plugin,
// the device library cache and Google Drive. All are replaced with vi.fn
// stand-ins so the folder-open branches, the scan, the cache deletes and the two
// download paths can be driven without a device, a database or a network. The
// settings store is real: the source, folder names and tree URI live there.
const mocks = vi.hoisted(() => ({
	pickNativeAudioDirectory: vi.fn(),
	scanNativeAudioFiles: vi.fn(),
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
	isPluginAvailable: vi.fn(() => true),
	addToast: vi.fn(),
}));

vi.mock('$lib/browse/folderScan', () => ({
	pickNativeAudioDirectory: mocks.pickNativeAudioDirectory,
	scanNativeAudioFiles: mocks.scanNativeAudioFiles,
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
}));

vi.mock('$lib/browse/libraryCache', () => ({
	LAST_LIBRARY_CACHE_KEY: 'last-library',
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
} from '$lib/device/deviceLibrary.svelte';
import type { DriveSession } from '$lib/drive/driveSession.svelte';
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
	mocks.scanNativeAudioFiles.mockResolvedValue([]);
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
		hydrateTracksFromLibrary,
		runPendingFileOp,
		refreshDriveLibrary,
		...overrides,
	});

	return {
		lib, view, driveSession, bumpBrowseVersion, hydrateTracksFromLibrary,
		runPendingFileOp, refreshDriveLibrary, folderInputEl, nativeFileInputEl,
	};
}

/** Run a scan and wait for the fired-and-forgotten promise chain to settle. */
function startScan(lib: DeviceLibrary, folderName = 'Library', options: { resetExistingFiles?: boolean } = {}) {
	lib.startLibraryScan(folderName, options);
	return vi.waitFor(() => {
		if (lib.libraryScanPromise) throw new Error('scan still running');
	});
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
		expect(mocks.saveCachedLibrary).toHaveBeenCalledWith(null, 'Music', view.allFiles);
		expect(lib.scanProgress).toBeNull();
		expect(lib.libraryScanPromise).toBeNull();
	});

	it('streams a native scan batch by batch, bumping the browse version and progress', async () => {
		let lib!: DeviceLibrary;
		const progressAtFirstBatch: Array<{ pct: number; filesFound: number } | null> = [];
		mocks.scanNativeAudioFiles.mockImplementation(async (_treeUri, _path, _size, _opts, onBatch) => {
			const batch = [nativeFile('a.mp3')];
			// The real plugin awaits a native call before its first batch; yield once
			// so the view's `libraryScanPromise` is assigned before onBatch runs.
			await Promise.resolve();
			await onBatch?.(batch, { done: true, foldersScanned: 1, foldersQueued: 0, totalFiles: 1 });
			progressAtFirstBatch.push(lib.scanProgress);
			return batch;
		});
		const made = makeDeviceLibrary();
		lib = made.lib;
		lib.nativeTreeUri = 'content://tree';

		await startScan(lib);

		expect(mocks.scanNativeAudioFiles).toHaveBeenCalledWith('content://tree', [], 500, {}, expect.any(Function));
		expect(progressAtFirstBatch[0]).toEqual({ pct: 99, filesFound: 1 });
		expect(made.view.allFiles.map((f) => f.name)).toEqual(['a.mp3']);
		expect(made.hydrateTracksFromLibrary).toHaveBeenCalled();
		expect(made.bumpBrowseVersion).toHaveBeenCalled();
	});

	it('clears the existing list first when resetExistingFiles is set', async () => {
		const { lib, view, bumpBrowseVersion } = makeDeviceLibrary();
		lib.rootDirHandle = {} as FileSystemDirectoryHandle;
		view.allFiles = [nativeFile('old.mp3')];

		lib.startLibraryScan('Library', { resetExistingFiles: true });

		expect(view.allFiles).toEqual([]);
		expect(bumpBrowseVersion).toHaveBeenCalledWith();
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
});

// ─────────────────────────────────────────────────────────────
// rescanCurrentLibraryIndex
// ─────────────────────────────────────────────────────────────

describe('rescanCurrentLibraryIndex', () => {
	it('deletes the device cache key and the last-library key before rescanning', async () => {
		const { lib } = makeDeviceLibrary();
		lib.nativeTreeUri = 'content://tree';

		await lib.rescanCurrentLibraryIndex();

		expect(mocks.getDeviceLibraryCacheKey).toHaveBeenCalledWith({ treeUri: 'content://tree', folderName: 'Library' });
		expect(mocks.deleteCachedLibrary.mock.calls.map((c) => c[0])).toEqual(['device:content://tree', 'last-library']);
		expect(lib.libraryScanPromise).not.toBeNull();
		await startScan(lib);
	});

	it('deletes the last-library key as well as the folder key', async () => {
		const { lib } = makeDeviceLibrary();
		musicSettings.lastFolderName = '';
		lib.nativeTreeUri = null;

		await lib.rescanCurrentLibraryIndex();

		// `lastFolderName || 'Library'` is always truthy, so the folder key is
		// never the last-library key and both deletes always run.
		expect(mocks.deleteCachedLibrary.mock.calls.map((c) => c[0])).toEqual(['device-folder:Library', 'last-library']);
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

	it('restores the native SAF tree from cache', async () => {
		const { lib, view, hydrateTracksFromLibrary } = makeDeviceLibrary({ isNativeApp: true });
		musicSettings.nativeTreeUri = 'content://tree';
		musicSettings.lastFolderName = 'Music';
		mocks.loadDeviceCachedLibrary.mockResolvedValue({ folderName: 'Music', files: [{ source: 'native', name: 'a.mp3', relativePath: 'a.mp3', path: '/a.mp3' }] });

		await expect(lib.restoreLocalLibrary()).resolves.toBe(true);

		expect(lib.nativeTreeUri).toBe('content://tree');
		expect(lib.rootDirHandle).toBeNull();
		expect(view.allFiles.map((f) => f.name)).toEqual(['a.mp3']);
		expect(hydrateTracksFromLibrary).toHaveBeenCalled();
		expect(mocks.saveCachedLibrary).not.toHaveBeenCalled();
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
