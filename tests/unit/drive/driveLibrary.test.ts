import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { GoogleDriveFile, GoogleDriveUser } from '$lib/google-drive';
import type { StoredAudioFile } from '$lib/models/music';

// The module under test talks to Google Drive, the Drive-cache IndexedDB layer
// and the native file resolver. All are replaced with vi.fn stand-ins so the
// cache-then-stream load, the auth paths and the pickers can be driven without a
// network, a database or a device. The settings store is real: the source
// switches and folder ids live there.
const mocks = vi.hoisted(() => ({
	fetchGoogleDriveUser: vi.fn(),
	isGoogleDriveConfigured: vi.fn(() => true),
	listGoogleDriveFolders: vi.fn(),
	streamGoogleDriveMp3Files: vi.fn(),
	downloadGoogleDriveFile: vi.fn(),
	uploadGoogleDriveFile: vi.fn(),
	loadDriveCache: vi.fn(),
	saveDriveCache: vi.fn(),
	bustDriveCache: vi.fn(),
	blobFromNativePath: vi.fn(),
	addToast: vi.fn(),
	markPending: vi.fn(),
	clearPending: vi.fn(),
}));

vi.mock('$lib/google-drive', () => ({
	fetchGoogleDriveUser: mocks.fetchGoogleDriveUser,
	isGoogleDriveConfigured: mocks.isGoogleDriveConfigured,
	listGoogleDriveFolders: mocks.listGoogleDriveFolders,
	streamGoogleDriveMp3Files: mocks.streamGoogleDriveMp3Files,
	downloadGoogleDriveFile: mocks.downloadGoogleDriveFile,
	uploadGoogleDriveFile: mocks.uploadGoogleDriveFile,
}));

vi.mock('$lib/utils/idb', () => ({
	loadDriveCache: mocks.loadDriveCache,
	saveDriveCache: mocks.saveDriveCache,
	bustDriveCache: mocks.bustDriveCache,
}));

vi.mock('$lib/audio/fileResolver', () => ({
	blobFromNativePath: mocks.blobFromNativePath,
}));

vi.mock('$lib/stores/toastStore.svelte', () => ({
	addToast: mocks.addToast,
}));

vi.mock('$lib/drive/folderPicker.svelte', () => ({
	markDriveFolderPickerPending: mocks.markPending,
	clearPendingDriveFolderPickerIntent: mocks.clearPending,
}));

import {
	createDriveLibrary,
	type DriveLibraryBusy,
	type DriveLibraryView,
} from '$lib/drive/driveLibrary';
import type { DriveSession } from '$lib/drive/driveSession.svelte';
import type { FolderPicker } from '$lib/drive/folderPicker.svelte';
import { musicSettings } from '$lib/stores/settings.svelte';

beforeEach(() => {
	vi.clearAllMocks();
	mocks.isGoogleDriveConfigured.mockReturnValue(true);
	mocks.fetchGoogleDriveUser.mockResolvedValue(undefined);
	musicSettings.librarySource = 'device';
	musicSettings.nativeTreeUri = '';
	musicSettings.lastFolderName = '';
	musicSettings.driveFolderId = '';
	musicSettings.driveFolderName = '';
});

// ── helpers ──────────────────────────────────────────────────

const file = (name: string, id = `id:${name}`): GoogleDriveFile => ({
	id,
	name,
	mimeType: 'audio/mpeg',
});

const folder = (id: string, name = id) => ({
	id,
	name,
	mimeType: 'application/vnd.google-apps.folder',
});

const driveStored = (name: string): StoredAudioFile => ({
	source: 'drive',
	name,
	relativePath: name,
	fileId: `id:${name}`,
	mimeType: 'audio/mpeg',
});

const batch = (...files: GoogleDriveFile[]) => ({ files, foldersScanned: 1, foldersQueued: 0 });

/** An async iterable that yields the given batches, shaped like the real stream. */
function streamOf(...batches: { files: GoogleDriveFile[]; foldersScanned: number; foldersQueued: number }[]) {
	return (async function* () {
		for (const b of batches) yield b;
	})();
}

function deferred<T = void>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((r) => { resolve = r; });
	return { promise, resolve };
}

function makeView(): DriveLibraryView {
	return {
		libraryScanPromise: null,
		rootDirHandle: null,
		nativeTreeUri: null,
		pendingHandle: null,
		browsePath: [],
		showQueue: false,
		showPanel: 'none',
		allFiles: [],
		switchingToFavId: null,
		drivePickerLoading: false,
		drivePickerFolders: [],
		showDriveFolderPicker: false,
		transferFile: null,
		transferDirection: 'upload',
		isTransferring: false,
		isFileOpRunning: false,
	};
}

function makeFolderPicker() {
	return {
		folderPickerToken: '',
		folderPickerStack: [] as { id: string; name: string }[],
		folderPickerFolders: [] as ReturnType<typeof folder>[],
		folderPickerError: '',
		showFolderPicker: false,
		schedulePendingDriveFolderPickerRestore: vi.fn(),
		openFolderPicker: vi.fn().mockResolvedValue(undefined),
		loadFolderPickerLevel: vi.fn().mockResolvedValue(undefined),
	};
}

/** A fresh Drive library wired to inert stand-ins unless a test overrides them. */
function makeLibrary() {
	const view = makeView();
	const busy: DriveLibraryBusy = { isLoading: false, isAuthenticating: false, abort: null };
	const driveSession = {
		accessToken: 'tok',
		expiresAt: 0,
		user: null as GoogleDriveUser | null,
		error: '',
		hasValidDriveToken: vi.fn(() => true),
		ensureDriveAccessToken: vi.fn().mockResolvedValue('tok'),
	} as unknown as DriveSession;
	const folderPicker = makeFolderPicker();
	const clearPlayer = vi.fn();
	const bumpBrowseVersion = vi.fn();
	const activateDeviceLibrary = vi.fn();
	const confirmDriveFolderSelection = vi.fn();
	const hydrateTracksFromLibrary = vi.fn();

	const library = createDriveLibrary({
		driveSession,
		folderPicker: folderPicker as unknown as FolderPicker,
		busy,
		view,
		clearPlayer,
		bumpBrowseVersion,
		activateDeviceLibrary,
		confirmDriveFolderSelection,
		hydrateTracksFromLibrary,
	});

	return {
		library, view, busy, driveSession, folderPicker,
		clearPlayer, bumpBrowseVersion, activateDeviceLibrary, confirmDriveFolderSelection, hydrateTracksFromLibrary,
	};
}

// ─────────────────────────────────────────────────────────────
// activateDriveLibrary
// ─────────────────────────────────────────────────────────────

describe('activateDriveLibrary', () => {
	it('writes the Drive source settings and resets every device-side field', () => {
		const { library, view, bumpBrowseVersion } = makeLibrary();
		musicSettings.librarySource = 'device';
		musicSettings.nativeTreeUri = 'content://old';
		musicSettings.lastFolderName = 'Old';
		view.libraryScanPromise = Promise.resolve([]);
		view.rootDirHandle = {} as FileSystemDirectoryHandle;
		view.nativeTreeUri = 'content://old';
		view.pendingHandle = {} as FileSystemDirectoryHandle;
		view.browsePath = ['a'];
		view.showQueue = false;
		view.showPanel = 'eq';

		library.activateDriveLibrary();

		expect(musicSettings.librarySource).toBe('drive');
		expect(musicSettings.nativeTreeUri).toBe('');
		expect(musicSettings.lastFolderName).toBe('Google Drive');
		expect(view.libraryScanPromise).toBeNull();
		expect(view.rootDirHandle).toBeNull();
		expect(view.nativeTreeUri).toBeNull();
		expect(view.pendingHandle).toBeNull();
		expect(view.browsePath).toEqual([]);
		expect(view.showQueue).toBe(true);
		expect(view.showPanel).toBe('none');
		expect(bumpBrowseVersion).toHaveBeenCalledTimes(1);
	});
});

// ─────────────────────────────────────────────────────────────
// finishDriveLoad
// ─────────────────────────────────────────────────────────────

describe('finishDriveLoad', () => {
	it('restores from the cache immediately, then refreshes in the background', async () => {
		mocks.loadDriveCache.mockResolvedValue([file('a'), file('b')]);
		mocks.streamGoogleDriveMp3Files.mockReturnValue(streamOf(batch(file('a'), file('b'), file('c'))));
		mocks.saveDriveCache.mockResolvedValue(undefined);
		const { library, view, busy, clearPlayer, bumpBrowseVersion } = makeLibrary();

		await library.finishDriveLoad('tok', 'fid');

		// Cached list is used at once, playback stops, the library activates.
		expect(clearPlayer).toHaveBeenCalledTimes(1);
		expect(view.allFiles.map((f) => f.name)).toEqual(['a', 'b']);
		expect(musicSettings.librarySource).toBe('drive');
		expect(busy.isLoading).toBe(false);
		expect(mocks.loadDriveCache).toHaveBeenCalledWith('fid');
		expect(bumpBrowseVersion).toHaveBeenCalledTimes(1); // activation only

		// The background refresh then replaces the list and persists it.
		await vi.waitFor(() => expect(mocks.saveDriveCache).toHaveBeenCalled());
		expect(view.allFiles.map((f) => f.name)).toEqual(['a', 'b', 'c']);
		expect(mocks.saveDriveCache).toHaveBeenCalledWith('fid', [file('a'), file('b'), file('c')]);
		expect(bumpBrowseVersion).toHaveBeenCalledTimes(2);
	});

	it('streams a fresh scan batch by batch when the cache misses', async () => {
		mocks.loadDriveCache.mockResolvedValue(null);
		mocks.streamGoogleDriveMp3Files.mockReturnValue(streamOf(batch(file('a')), batch(file('b'))));
		mocks.saveDriveCache.mockResolvedValue(undefined);
		const { library, view, busy, clearPlayer, bumpBrowseVersion } = makeLibrary();

		await library.finishDriveLoad('tok');

		expect(clearPlayer).toHaveBeenCalledTimes(1);
		expect(view.allFiles.map((f) => f.name)).toEqual(['a', 'b']);
		// One bump per batch plus the activation bump after the first batch.
		expect(bumpBrowseVersion).toHaveBeenCalledTimes(3);
		expect(musicSettings.librarySource).toBe('drive');
		expect(mocks.saveDriveCache).toHaveBeenCalledWith('_all', [file('a'), file('b')]);
		expect(busy.isLoading).toBe(false);
		expect(busy.abort).toBeNull();
	});

	it('skips the cache read when forceRefresh is set', async () => {
		mocks.streamGoogleDriveMp3Files.mockReturnValue(streamOf(batch(file('a'))));
		mocks.saveDriveCache.mockResolvedValue(undefined);
		const { library } = makeLibrary();

		await library.finishDriveLoad('tok', 'fid', true);

		expect(mocks.loadDriveCache).not.toHaveBeenCalled();
		expect(mocks.streamGoogleDriveMp3Files).toHaveBeenCalled();
	});

	it('surfaces a stream error, unless the load was aborted', async () => {
		mocks.loadDriveCache.mockResolvedValue(null);
		mocks.streamGoogleDriveMp3Files.mockImplementation(() => {
			return (async function* () { throw new Error('stream exploded'); })();
		});
		const { library, driveSession, busy } = makeLibrary();

		await library.finishDriveLoad('tok');

		expect(driveSession.error).toBe('stream exploded');
		expect(busy.isLoading).toBe(false);
	});

	it('lets a new load abort the old one and keep ownership of the busy flag', async () => {
		mocks.loadDriveCache.mockResolvedValue(null);
		mocks.saveDriveCache.mockResolvedValue(undefined);

		const first = deferred();
		const firstStarted = deferred();
		const firstStream = (async function* () {
			yield batch(file('one'));
			firstStarted.resolve();
			await first.promise;
			yield batch(file('two'));
		})();
		const secondStarted = deferred();
		const second = deferred();
		const secondStream = (async function* () {
			yield batch(file('three'));
			secondStarted.resolve();
			await second.promise;
			yield batch(file('four'));
		})();
		mocks.streamGoogleDriveMp3Files
			.mockReturnValueOnce(firstStream)
			.mockReturnValueOnce(secondStream);

		const { library, busy } = makeLibrary();

		const p1 = library.finishDriveLoad('tok');
		await firstStarted.promise;
		// Replacing the load aborts the first controller.
		const p2 = library.finishDriveLoad('tok');
		first.resolve();
		await p1;

		// The first load must not clear the flag the second now owns, and must not
		// have persisted its truncated list.
		expect(busy.isLoading).toBe(true);
		expect(mocks.saveDriveCache).not.toHaveBeenCalled();

		second.resolve();
		await p2;
		expect(busy.isLoading).toBe(false);
		expect(busy.abort).toBeNull();
	});
});

// ─────────────────────────────────────────────────────────────
// loadDriveLibrary + entry points
// ─────────────────────────────────────────────────────────────

describe('connectGoogleDrive / loadDriveLibrary', () => {
	it('runs the interactive auth flow and reuses the saved folder', async () => {
		musicSettings.driveFolderId = 'saved';
		musicSettings.driveFolderName = 'Saved';
		const { library, busy, driveSession, folderPicker, confirmDriveFolderSelection } = makeLibrary();

		await library.connectGoogleDrive();

		expect(mocks.markPending).toHaveBeenCalledTimes(1);
		expect(folderPicker.schedulePendingDriveFolderPickerRestore).toHaveBeenCalledTimes(1);
		expect(driveSession.ensureDriveAccessToken).toHaveBeenCalledWith(true);
		expect(folderPicker.folderPickerToken).toBe('tok');
		expect(confirmDriveFolderSelection).toHaveBeenCalledWith('saved', 'Saved');
		expect(busy.isAuthenticating).toBe(false);
		expect(busy.isLoading).toBe(false);
	});

	it('opens the folder picker on a first connection with no saved folder', async () => {
		const { library, folderPicker, confirmDriveFolderSelection } = makeLibrary();

		await library.connectGoogleDrive();

		expect(confirmDriveFolderSelection).not.toHaveBeenCalled();
		expect(folderPicker.openFolderPicker).toHaveBeenCalledTimes(1);
	});

	it('bails when Drive is not configured', async () => {
		mocks.isGoogleDriveConfigured.mockReturnValue(false);
		const { library, driveSession, folderPicker } = makeLibrary();

		await library.connectGoogleDrive();

		expect(driveSession.error).toContain('not configured');
		expect(mocks.clearPending).toHaveBeenCalledTimes(1);
		expect(folderPicker.openFolderPicker).not.toHaveBeenCalled();
	});

	it('clears the pending intent and stops when auth returns no token', async () => {
		const { library, driveSession, busy } = makeLibrary();
		(driveSession.ensureDriveAccessToken as ReturnType<typeof vi.fn>).mockResolvedValue(null);

		await library.connectGoogleDrive();

		expect(mocks.clearPending).toHaveBeenCalled();
		expect(busy.isAuthenticating).toBe(false);
		expect(busy.isLoading).toBe(false);
	});
});

describe('refreshGoogleDrive', () => {
	it('busts the cache then reloads the saved folder with forceRefresh', async () => {
		musicSettings.driveFolderId = 'fid';
		mocks.loadDriveCache.mockResolvedValue(null);
		mocks.streamGoogleDriveMp3Files.mockReturnValue(streamOf(batch(file('a'))));
		mocks.saveDriveCache.mockResolvedValue(undefined);
		mocks.bustDriveCache.mockResolvedValue(undefined);
		const { library, driveSession } = makeLibrary();

		await library.refreshGoogleDrive();

		expect(mocks.bustDriveCache).toHaveBeenCalledWith('fid');
		expect(driveSession.ensureDriveAccessToken).toHaveBeenCalledWith(true);
		// forceRefresh means the stale cache is never read.
		expect(mocks.loadDriveCache).not.toHaveBeenCalled();
		expect(mocks.streamGoogleDriveMp3Files).toHaveBeenCalled();
	});

	it('does nothing without a token', async () => {
		const { library, driveSession } = makeLibrary();
		(driveSession.ensureDriveAccessToken as ReturnType<typeof vi.fn>).mockResolvedValue(null);

		await library.refreshGoogleDrive();

		expect(mocks.bustDriveCache).not.toHaveBeenCalled();
	});
});

describe('changeDriveFolder', () => {
	it('marks the intent and opens the picker with a silent token', async () => {
		const { library, driveSession, folderPicker } = makeLibrary();

		await library.changeDriveFolder();

		expect(mocks.markPending).toHaveBeenCalledTimes(1);
		expect(driveSession.ensureDriveAccessToken).toHaveBeenCalledWith(false);
		expect(folderPicker.folderPickerToken).toBe('tok');
		expect(folderPicker.openFolderPicker).toHaveBeenCalledTimes(1);
	});

	it('falls back to the interactive flow without a silent token', async () => {
		const { library, driveSession, folderPicker } = makeLibrary();
		(driveSession.ensureDriveAccessToken as ReturnType<typeof vi.fn>).mockResolvedValue(null);

		await library.changeDriveFolder();

		expect(folderPicker.openFolderPicker).not.toHaveBeenCalled();
		expect(driveSession.ensureDriveAccessToken).toHaveBeenCalledWith(true);
	});
});

// ─────────────────────────────────────────────────────────────
// materializeStoredFile
// ─────────────────────────────────────────────────────────────

describe('materializeStoredFile', () => {
	it('returns the File of a web entry untouched', async () => {
		const { library } = makeLibrary();
		const webFile = new File(['web'], 'web.mp3');

		await expect(library.materializeStoredFile({ source: 'web', name: 'web.mp3', relativePath: 'web.mp3', file: webFile }))
			.resolves.toBe(webFile);
	});

	it('downloads a Drive entry with the given onProgress callback', async () => {
		const { library, driveSession } = makeLibrary();
		const downloaded = new File(['drive'], 'd.mp3');
		mocks.downloadGoogleDriveFile.mockResolvedValue(downloaded);
		const onProgress = vi.fn();

		const result = await library.materializeStoredFile(driveStored('d.mp3'), true, onProgress);

		expect(driveSession.ensureDriveAccessToken).toHaveBeenCalledWith(true);
		expect(mocks.downloadGoogleDriveFile).toHaveBeenCalledWith({
			accessToken: 'tok',
			fileId: 'id:d.mp3',
			fileName: 'd.mp3',
			mimeType: 'audio/mpeg',
			modifiedAt: undefined,
			onProgress,
		});
		expect(result).toBe(downloaded);
	});

	it('throws when a Drive entry has no token', async () => {
		const { library, driveSession } = makeLibrary();
		(driveSession.ensureDriveAccessToken as ReturnType<typeof vi.fn>).mockResolvedValue(null);

		await expect(library.materializeStoredFile(driveStored('d.mp3'))).rejects.toThrow(/session has expired/i);
		expect(mocks.downloadGoogleDriveFile).not.toHaveBeenCalled();
	});

	it('wraps a native entry through the resolver', async () => {
		const { library } = makeLibrary();
		mocks.blobFromNativePath.mockResolvedValue(new Blob(['native'], { type: 'audio/mpeg' }));

		const result = await library.materializeStoredFile({
			source: 'native', name: 'n.mp3', relativePath: 'n.mp3', path: '/n.mp3', modifiedAt: 123,
		});

		expect(mocks.blobFromNativePath).toHaveBeenCalledWith('/n.mp3', undefined);
		expect(result.name).toBe('n.mp3');
		expect(result.type).toBe('audio/mpeg');
	});
});

// ─────────────────────────────────────────────────────────────
// loadDriveFolderPicker + openDriveUploadFolderPicker + upload
// ─────────────────────────────────────────────────────────────

describe('loadDriveFolderPicker', () => {
	it('lists folders and toggles the loading flag around the call', async () => {
		mocks.listGoogleDriveFolders.mockResolvedValue([folder('a')]);
		const { library, view, driveSession } = makeLibrary();
		driveSession.accessToken = 'access';

		await library.loadDriveFolderPicker('root');

		expect(mocks.listGoogleDriveFolders).toHaveBeenCalledWith('access', 'root');
		expect(view.drivePickerFolders.map((f) => f.id)).toEqual(['a']);
		expect(view.drivePickerLoading).toBe(false);
	});

	it('toasts and leaves the list when the listing rejects', async () => {
		mocks.listGoogleDriveFolders.mockRejectedValue(new Error('boom'));
		const { library, view } = makeLibrary();

		await library.loadDriveFolderPicker('root');

		expect(mocks.addToast).toHaveBeenCalledWith({ message: 'Failed to list Drive folders.', type: 'error' });
		expect(view.drivePickerFolders).toEqual([]);
		expect(view.drivePickerLoading).toBe(false);
	});
});

describe('selectDriveFolderAndUpload / openDriveUploadFolderPicker', () => {
	it('uploads the staged transfer file and clears it afterwards', async () => {
		const { library, view } = makeLibrary();
		view.transferFile = driveStored('song.mp3');
		const uploaded = new File(['bytes'], 'song.mp3');
		mocks.downloadGoogleDriveFile.mockResolvedValue(uploaded);
		mocks.uploadGoogleDriveFile.mockResolvedValue(undefined);

		await library.selectDriveFolderAndUpload(folder('dest', 'Dest'));

		expect(mocks.uploadGoogleDriveFile).toHaveBeenCalledWith({
			accessToken: 'tok',
			parentFolderId: 'dest',
			fileName: 'song.mp3',
			blob: expect.any(Blob),
		});
		expect(mocks.addToast).toHaveBeenCalledWith({ message: expect.stringContaining('Uploaded "song.mp3"'), type: 'info' });
		expect(view.isTransferring).toBe(false);
		expect(view.transferFile).toBeNull();
	});

	it('refuses to start while another transfer is running', async () => {
		const { library, view } = makeLibrary();
		view.transferFile = driveStored('song.mp3');
		view.isTransferring = true;

		await library.selectDriveFolderAndUpload(folder('dest'));

		expect(mocks.uploadGoogleDriveFile).not.toHaveBeenCalled();
	});

	it('stages the file and opens the Drive upload picker', async () => {
		const { library, view } = makeLibrary();
		view.drivePickerLoading = true;
		mocks.listGoogleDriveFolders.mockResolvedValue([]);

		await library.openDriveUploadFolderPicker(driveStored('song.mp3'));

		expect(view.transferFile?.name).toBe('song.mp3');
		expect(view.transferDirection).toBe('upload');
		expect(view.showDriveFolderPicker).toBe(true);
		expect(view.drivePickerLoading).toBe(false);
		expect(mocks.listGoogleDriveFolders).toHaveBeenCalledWith('tok', 'root');
	});

	it('warns instead of staging when there is no Drive token', async () => {
		const { library, view, driveSession } = makeLibrary();
		(driveSession.ensureDriveAccessToken as ReturnType<typeof vi.fn>).mockResolvedValue(null);

		await library.openDriveUploadFolderPicker(driveStored('song.mp3'));

		expect(mocks.addToast).toHaveBeenCalledWith({ message: 'Connect to Google Drive first.', type: 'warning' });
		expect(view.showDriveFolderPicker).toBe(false);
	});
});
