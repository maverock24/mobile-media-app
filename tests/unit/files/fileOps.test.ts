import { describe, it, expect, vi, beforeEach } from 'vitest';

// The module under test talks to the native SAF plugin (DirectoryReader) and
// the toast store. Both are replaced with vi.fn stand-ins so the delete /
// move / copy calls and every toast can be asserted without a device. The
// settings store is real: `reloadCurrentBrowse` branches on its source. The
// device library and browse navigation are plain fakes, since fileOps only
// reaches them through the injected accessor.
const mocks = vi.hoisted(() => ({
	deleteEntry: vi.fn(),
	copyEntry: vi.fn(),
	moveEntry: vi.fn(),
	addToast: vi.fn(),
}));

vi.mock('$lib/native/directory-reader', () => ({
	DirectoryReader: {
		deleteEntry: mocks.deleteEntry,
		copyEntry: mocks.copyEntry,
		moveEntry: mocks.moveEntry,
	},
}));

vi.mock('$lib/stores/toastStore.svelte', () => ({
	addToast: mocks.addToast,
}));

import {
	createFileOps,
	type FileOps,
	type FileOpsOptions,
	type FileOpsView,
	type PendingFileOp,
} from '$lib/files/fileOps';
import { musicSettings } from '$lib/stores/settings.svelte';
import type { StoredAudioFile } from '$lib/models/music';
import { LAST_LIBRARY_CACHE_KEY, saveCachedLibrary } from '$lib/browse/libraryCache';
import { loadCachedLibrary } from '$lib/utils/idb';

beforeEach(() => {
	vi.clearAllMocks();
	mocks.deleteEntry.mockResolvedValue(undefined);
	mocks.copyEntry.mockResolvedValue(undefined);
	mocks.moveEntry.mockResolvedValue(undefined);
	mocks.addToast.mockReturnValue('toast');
	musicSettings.librarySource = 'device';
});

// ── helpers ──────────────────────────────────────────────────

function makeView() {
	return {
		pendingFileOp: null as PendingFileOp | null,
		isFileOpRunning: false,
		showLocalFolderPicker: false,
		browsePath: ['Albums'] as string[],
		driveSearch: '' as string,
		allFiles: [] as StoredAudioFile[],
	};
}

const target = (name = 'song.mp3') => ({ name, isDrive: false, fileId: null, source: null });
const op = (op: 'move' | 'copy' | 'delete', name = 'song.mp3'): PendingFileOp => ({
	op, name, isDrive: false, fileId: null, source: null,
});

/** A fresh fileOps wired to inert stand-ins unless a test overrides them. */
function makeFileOps(overrides: Partial<FileOpsOptions> = {}) {
	const view = makeView();
	const deviceLibrary = {
		nativeTreeUri: 'content://tree' as string | null,
		openFolder: vi.fn().mockResolvedValue(undefined),
		loadLocalFolderPicker: vi.fn().mockResolvedValue(undefined),
	};
	const browseNavigation = { loadBrowseEntries: vi.fn().mockResolvedValue(undefined) };

	const fileOps: FileOps = createFileOps({
		deviceLibrary,
		browseNavigation,
		isNativeApp: true,
		view: view as FileOpsView,
		...overrides,
	});

	return { fileOps, view, deviceLibrary, browseNavigation };
}

// ─────────────────────────────────────────────────────────────
// runPendingFileOp — delete path
// ─────────────────────────────────────────────────────────────

describe('runPendingFileOp (delete)', () => {
	it('deletes the entry, toasts, reloads and clears the op', async () => {
		const { fileOps, view, browseNavigation } = makeFileOps();
		view.pendingFileOp = op('delete');

		await fileOps.runPendingFileOp(null);

		expect(mocks.deleteEntry).toHaveBeenCalledWith({ treeUri: 'content://tree', path: '', name: 'song.mp3' });
		expect(mocks.addToast).toHaveBeenCalledWith({ message: 'Deleted "song.mp3".', type: 'info' });
		expect(browseNavigation.loadBrowseEntries).toHaveBeenCalledWith(view.browsePath, undefined);
		expect(view.pendingFileOp).toBeNull();
		expect(view.isFileOpRunning).toBe(false);
	});

	it('toasts the per-op failure and still clears the op', async () => {
		const { fileOps, view, browseNavigation } = makeFileOps();
		view.pendingFileOp = op('delete');
		mocks.deleteEntry.mockRejectedValue(new Error('boom'));

		await fileOps.runPendingFileOp(null);

		expect(mocks.addToast).toHaveBeenCalledWith({ message: 'Delete failed: boom', type: 'error' });
		// The reload only runs on success.
		expect(browseNavigation.loadBrowseEntries).not.toHaveBeenCalled();
		expect(view.pendingFileOp).toBeNull();
		expect(view.isFileOpRunning).toBe(false);
	});
});

// ─────────────────────────────────────────────────────────────
// runPendingFileOp — move / copy path
// ─────────────────────────────────────────────────────────────

describe('runPendingFileOp (move / copy)', () => {
	it('moves the entry into the destination path', async () => {
		const { fileOps, view } = makeFileOps();
		view.pendingFileOp = op('move');

		await fileOps.runPendingFileOp({ localPath: 'Albums' });

		expect(mocks.moveEntry).toHaveBeenCalledWith({
			srcTreeUri: 'content://tree', srcPath: '', srcName: 'song.mp3',
			destTreeUri: 'content://tree', destPath: 'Albums', destName: 'song.mp3',
		});
		expect(mocks.addToast).toHaveBeenCalledWith({ message: 'Moved "song.mp3".', type: 'info' });
	});

	it('copies the entry and defaults the destination path to empty', async () => {
		const { fileOps, view } = makeFileOps();
		view.pendingFileOp = op('copy');

		await fileOps.runPendingFileOp({});

		expect(mocks.copyEntry).toHaveBeenCalledWith(expect.objectContaining({ destPath: '', srcName: 'song.mp3' }));
		expect(mocks.addToast).toHaveBeenCalledWith({ message: 'Copied "song.mp3".', type: 'info' });
	});

	it('toasts a "Move failed." when the move rejects', async () => {
		const { fileOps, view } = makeFileOps();
		view.pendingFileOp = op('move');
		mocks.moveEntry.mockRejectedValue(new Error('boom'));

		await fileOps.runPendingFileOp({ localPath: 'Albums' });

		expect(mocks.addToast).toHaveBeenCalledWith({ message: 'Move failed: boom', type: 'error' });
	});

	it('toasts a "Copy failed." when the copy rejects', async () => {
		const { fileOps, view } = makeFileOps();
		view.pendingFileOp = op('copy');
		mocks.copyEntry.mockRejectedValue(new Error('boom'));

		await fileOps.runPendingFileOp({ localPath: 'Albums' });

		expect(mocks.addToast).toHaveBeenCalledWith({ message: 'Copy failed: boom', type: 'error' });
	});

	it('does nothing without a pending op', async () => {
		const { fileOps } = makeFileOps();

		await fileOps.runPendingFileOp({ localPath: 'Albums' });

		expect(mocks.moveEntry).not.toHaveBeenCalled();
		expect(mocks.copyEntry).not.toHaveBeenCalled();
	});

	it('bails while another op is running', async () => {
		const { fileOps, view } = makeFileOps();
		view.pendingFileOp = op('delete');
		view.isFileOpRunning = true;

		await fileOps.runPendingFileOp(null);

		expect(mocks.deleteEntry).not.toHaveBeenCalled();
		expect(view.pendingFileOp).not.toBeNull();
	});

	it('does not move or copy when the op is move/copy but no destination is given', async () => {
		const { fileOps, view, browseNavigation } = makeFileOps();
		view.pendingFileOp = op('move');

		await fileOps.runPendingFileOp(null);

		expect(mocks.moveEntry).not.toHaveBeenCalled();
		// It still reloads and clears.
		expect(browseNavigation.loadBrowseEntries).toHaveBeenCalled();
		expect(view.pendingFileOp).toBeNull();
	});
});

// ─────────────────────────────────────────────────────────────
// deleteFileOp / moveOrCopyFileOp
// ─────────────────────────────────────────────────────────────

describe('deleteFileOp', () => {
	it('throws without a SAF tree URI', async () => {
		const { fileOps, deviceLibrary } = makeFileOps();
		deviceLibrary.nativeTreeUri = null;

		await expect(fileOps.deleteFileOp(op('delete'))).rejects.toThrow('no tree');
		expect(mocks.deleteEntry).not.toHaveBeenCalled();
	});

	it('calls DirectoryReader.deleteEntry at the tree root', async () => {
		const { fileOps } = makeFileOps();

		await fileOps.deleteFileOp(op('delete'));

		expect(mocks.deleteEntry).toHaveBeenCalledWith({ treeUri: 'content://tree', path: '', name: 'song.mp3' });
	});

	it('resolves the subfolder from the file relative path', async () => {
		const { fileOps } = makeFileOps();
		const source: StoredAudioFile = {
			source: 'native', name: 'song.mp3', relativePath: 'Albums/Sub/song.mp3', path: '/x',
		};

		await fileOps.deleteFileOp({ ...op('delete'), source });

		expect(mocks.deleteEntry).toHaveBeenCalledWith({
			treeUri: 'content://tree', path: 'Albums/Sub', name: 'song.mp3',
		});
	});

	it('routes a Drive row to deleteDriveFile and never to the local SAF delete', async () => {
		const deleteDriveFile = vi.fn().mockResolvedValue(undefined);
		const { fileOps } = makeFileOps({ deleteDriveFile });
		const source: StoredAudioFile = {
			source: 'drive', name: 'song.mp3', relativePath: 'song.mp3', fileId: 'drive-1',
		};

		await fileOps.deleteFileOp({ ...op('delete'), isDrive: true, fileId: 'drive-1', source });

		expect(deleteDriveFile).toHaveBeenCalledWith(source);
		expect(mocks.deleteEntry).not.toHaveBeenCalled();
		expect(mocks.addToast).toHaveBeenCalledWith({ message: 'Deleted "song.mp3" from Google Drive.', type: 'info' });
	});

	it('rejects a Drive row when no Drive delete is wired', async () => {
		const { fileOps } = makeFileOps();
		const source: StoredAudioFile = {
			source: 'drive', name: 'song.mp3', relativePath: 'song.mp3', fileId: 'drive-1',
		};

		await expect(fileOps.deleteFileOp({ ...op('delete'), isDrive: true, fileId: 'drive-1', source }))
			.rejects.toThrow('not available');
		expect(mocks.deleteEntry).not.toHaveBeenCalled();
	});
});

// ─────────────────────────────────────────────────────────────
// deleteFileOp — library index and cache
// ─────────────────────────────────────────────────────────────

describe('deleteFileOp (library index)', () => {
	const song: StoredAudioFile = {
		source: 'native', name: 'song.mp3', relativePath: 'Albums/song.mp3', path: '/x/song.mp3',
	};
	const keeper: StoredAudioFile = {
		source: 'native', name: 'keep.mp3', relativePath: 'Albums/keep.mp3', path: '/x/keep.mp3',
	};
	const driveSong: StoredAudioFile = {
		source: 'drive', name: 'song.mp3', relativePath: 'song.mp3', fileId: 'drive-1',
	};

	beforeEach(() => {
		musicSettings.lastFolderName = 'Library';
	});

	it('drops the deleted file from the index so the reload cannot restore the row', async () => {
		const { fileOps, view } = makeFileOps();
		view.allFiles = [song, keeper];

		await fileOps.deleteFileOp({ ...op('delete'), source: song });

		expect(view.allFiles).toEqual([keeper]);
	});

	it('rewrites the device cache without the deleted file', async () => {
		const { fileOps, view } = makeFileOps();
		view.allFiles = [song, keeper];

		await fileOps.deleteFileOp({ ...op('delete'), source: song });

		const cached = await loadCachedLibrary('device:content://tree');
		expect(cached?.files.map((file) => file.name)).toEqual(['keep.mp3']);
	});

	it('keeps the directory rows when a delete rewrites the cache', async () => {
		const dirs = [{ path: '', mtime: 5 }, { path: 'Albums', mtime: 6 }];
		await saveCachedLibrary('content://tree', 'Library', [song, keeper], undefined, dirs);
		const { fileOps, view } = makeFileOps();
		view.allFiles = [song, keeper];

		await fileOps.deleteFileOp({ ...op('delete'), source: song });

		const cached = await loadCachedLibrary('device:content://tree');
		expect(cached?.files.map((file) => file.name)).toEqual(['keep.mp3']);
		expect(cached?.dirs).toEqual(dirs);
		expect(cached?.schemaVersion).toBe(1);
	});

	it('writes a completed empty payload when the last file is deleted', async () => {
		const dirs = [{ path: '', mtime: 5 }];
		await saveCachedLibrary('content://tree', 'Library', [song], undefined, dirs);
		const { fileOps, view } = makeFileOps();
		view.allFiles = [song];

		await fileOps.deleteFileOp({ ...op('delete'), source: song });

		// An emptied folder is a legitimate payload (D6 amendment), so both keys
		// carry a completed empty index instead of disappearing.
		for (const key of ['device:content://tree', LAST_LIBRARY_CACHE_KEY]) {
			const cached = await loadCachedLibrary(key);
			expect(cached?.files).toEqual([]);
			expect(cached?.schemaVersion).toBe(1);
			expect(cached?.dirs).toEqual(dirs);
		}
	});

	it('keeps the previous completedAt when a delete rewrites the cache', async () => {
		// A delete walks nothing. Stamping the write's clock would claim the tree
		// was just verified and let a delta skip a subtree that changed since.
		const completedAt = 1_600_000_000_000;
		await saveCachedLibrary('content://tree', 'Library', [song, keeper], undefined, [{ path: '', mtime: 5 }], { completedAt });
		const { fileOps, view } = makeFileOps();
		view.allFiles = [song, keeper];

		await fileOps.deleteFileOp({ ...op('delete'), source: song });

		const cached = await loadCachedLibrary('device:content://tree');
		expect(cached?.files.map((file) => file.name)).toEqual(['keep.mp3']);
		expect(cached?.completedAt).toBe(completedAt);
	});

	it('leaves the index alone when the file was never indexed', async () => {
		const { fileOps, view } = makeFileOps();
		view.allFiles = [keeper];

		await fileOps.deleteFileOp({ ...op('delete'), source: song });

		expect(view.allFiles).toEqual([keeper]);
	});

	it('drops a Drive row from the index and leaves the device cache alone', async () => {
		await saveCachedLibrary('content://tree', 'Library', [song]);
		const deleteDriveFile = vi.fn().mockResolvedValue(undefined);
		const { fileOps, view } = makeFileOps({ deleteDriveFile });
		view.allFiles = [driveSong, song];

		await fileOps.deleteFileOp({ ...op('delete'), isDrive: true, fileId: 'drive-1', source: driveSong });

		expect(view.allFiles).toEqual([song]);
		const cached = await loadCachedLibrary('device:content://tree');
		expect(cached?.files.map((file) => file.name)).toEqual(['song.mp3']);
	});
});

describe('moveOrCopyFileOp', () => {
	it('throws without a SAF tree URI', async () => {
		const { fileOps, deviceLibrary } = makeFileOps();
		deviceLibrary.nativeTreeUri = null;

		await expect(fileOps.moveOrCopyFileOp(op('move'), { localPath: 'x' })).rejects.toThrow('no tree');
	});

	it('routes copy ops to DirectoryReader.copyEntry', async () => {
		const { fileOps } = makeFileOps();

		await fileOps.moveOrCopyFileOp(op('copy'), { localPath: 'Dest/Sub' });

		expect(mocks.copyEntry).toHaveBeenCalledWith(expect.objectContaining({ destPath: 'Dest/Sub' }));
		expect(mocks.moveEntry).not.toHaveBeenCalled();
	});
});

// ─────────────────────────────────────────────────────────────
// handlers set pendingFileOp before the picker opens
// ─────────────────────────────────────────────────────────────

describe('handlers', () => {
	it('handleMoveEntry sets a move op and opens the picker', () => {
		const { fileOps, view, deviceLibrary } = makeFileOps({ isNativeApp: false });

		fileOps.handleMoveEntry(target());

		expect(view.pendingFileOp).toMatchObject({ op: 'move', name: 'song.mp3' });
		expect(mocks.addToast).toHaveBeenCalledWith({ message: 'Local destination requires the Android app.', type: 'warning' });
		expect(deviceLibrary.loadLocalFolderPicker).not.toHaveBeenCalled();
	});

	it('handleCopyEntry sets a copy op and opens the picker', () => {
		const { fileOps, view } = makeFileOps({ isNativeApp: false });

		fileOps.handleCopyEntry(target());

		expect(view.pendingFileOp).toMatchObject({ op: 'copy', name: 'song.mp3' });
	});

	it('handleDeleteEntry sets a delete op and confirms without opening the picker', () => {
		const { fileOps, view, deviceLibrary } = makeFileOps({ isNativeApp: false });

		fileOps.handleDeleteEntry(target());

		expect(view.pendingFileOp).toMatchObject({ op: 'delete', name: 'song.mp3' });
		expect(mocks.addToast).toHaveBeenCalledWith(expect.objectContaining({ message: 'Delete song.mp3?', type: 'warning', autoDismissMs: 0 }));
		expect(deviceLibrary.openFolder).not.toHaveBeenCalled();
	});
});

// ─────────────────────────────────────────────────────────────
// confirmAndDelete
// ─────────────────────────────────────────────────────────────

describe('confirmAndDelete', () => {
	it('toasts a sticky confirm whose Delete action runs the op', async () => {
		const { fileOps, view } = makeFileOps();
		fileOps.confirmAndDelete(target());

		expect(view.pendingFileOp).toMatchObject({ op: 'delete', name: 'song.mp3' });
		const toast = mocks.addToast.mock.calls.at(-1)![0];
		expect(toast).toMatchObject({ message: 'Delete song.mp3?', type: 'warning', autoDismissMs: 0 });
		expect(toast.action.label).toBe('Delete');

		toast.action.handler();
		await vi.waitFor(() => expect(mocks.deleteEntry).toHaveBeenCalledWith({ treeUri: 'content://tree', path: '', name: 'song.mp3' }));
	});
});

// ─────────────────────────────────────────────────────────────
// openDestinationForOp
// ─────────────────────────────────────────────────────────────

describe('openDestinationForOp', () => {
	it('sets the op then opens the native local picker', async () => {
		const { fileOps, view, deviceLibrary } = makeFileOps();

		fileOps.openDestinationForOp('copy', target());

		expect(view.pendingFileOp).toMatchObject({ op: 'copy', name: 'song.mp3' });
		await vi.waitFor(() => expect(deviceLibrary.loadLocalFolderPicker).toHaveBeenCalledWith(''));
		expect(view.showLocalFolderPicker).toBe(true);
	});
});

// ─────────────────────────────────────────────────────────────
// folderOpNotice
// ─────────────────────────────────────────────────────────────

describe('folderOpNotice', () => {
	it('toasts the not-wired notice with the op name', () => {
		const { fileOps } = makeFileOps();

		fileOps.folderOpNotice('Move');

		expect(mocks.addToast).toHaveBeenCalledWith({ message: 'Move on folders is not wired yet.', type: 'info' });
	});
});

// ─────────────────────────────────────────────────────────────
// reloadCurrentBrowse
// ─────────────────────────────────────────────────────────────

describe('reloadCurrentBrowse', () => {
	it('re-runs the live Drive search query when the Drive source is active', async () => {
		const { fileOps, view, browseNavigation } = makeFileOps();
		musicSettings.librarySource = 'drive';
		view.driveSearch = '  Bach  ';

		await fileOps.reloadCurrentBrowse();

		expect(browseNavigation.loadBrowseEntries).toHaveBeenCalledWith(view.browsePath, 'bach');
	});

	it('reloads the Drive folder listing when the Drive source has no query', async () => {
		const { fileOps, view, browseNavigation } = makeFileOps();
		musicSettings.librarySource = 'drive';
		view.driveSearch = '';

		await fileOps.reloadCurrentBrowse();

		expect(browseNavigation.loadBrowseEntries).toHaveBeenCalledWith(view.browsePath, '');
	});

	it('reloads with an undefined filter for any other source', async () => {
		const { fileOps, view, browseNavigation } = makeFileOps();
		musicSettings.librarySource = 'device';

		await fileOps.reloadCurrentBrowse();

		expect(browseNavigation.loadBrowseEntries).toHaveBeenCalledWith(view.browsePath, undefined);
	});
});

// ─────────────────────────────────────────────────────────────
// openLocalDestinationPicker branches
// ─────────────────────────────────────────────────────────────

describe('openLocalDestinationPicker', () => {
	it('warns and stops on the web (no native destination)', async () => {
		const { fileOps, view, deviceLibrary } = makeFileOps({ isNativeApp: false });

		await fileOps.openLocalDestinationPicker();

		expect(mocks.addToast).toHaveBeenCalledWith({ message: 'Local destination requires the Android app.', type: 'warning' });
		expect(deviceLibrary.openFolder).not.toHaveBeenCalled();
		expect(view.showLocalFolderPicker).toBe(false);
	});

	it('opens the folder, lists it and shows the picker when native', async () => {
		const { fileOps, view, deviceLibrary } = makeFileOps();
		deviceLibrary.nativeTreeUri = null;
		deviceLibrary.openFolder.mockImplementation(async () => { deviceLibrary.nativeTreeUri = 'content://picked'; });

		await fileOps.openLocalDestinationPicker();

		expect(deviceLibrary.openFolder).toHaveBeenCalledTimes(1);
		expect(deviceLibrary.loadLocalFolderPicker).toHaveBeenCalledWith('');
		expect(view.showLocalFolderPicker).toBe(true);
	});

	it('warns when the folder open leaves no tree URI', async () => {
		const { fileOps, view, deviceLibrary } = makeFileOps();
		deviceLibrary.nativeTreeUri = null;
		deviceLibrary.openFolder.mockResolvedValue(undefined);

		await fileOps.openLocalDestinationPicker();

		expect(mocks.addToast).toHaveBeenCalledWith({ message: 'No local folder selected.', type: 'warning' });
		expect(view.showLocalFolderPicker).toBe(false);
		expect(deviceLibrary.loadLocalFolderPicker).not.toHaveBeenCalled();
	});
});
