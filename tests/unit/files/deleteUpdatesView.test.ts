/**
 * Regression test for "the delete toast says it worked but the row is still in
 * the list".
 *
 * `runPendingFileOp` refreshed the browse list by calling `loadBrowseEntries`,
 * which rebuilds the entries from the deck's library index (`allFiles`), not
 * from the folder. The index still held the deleted file, so the reload put the
 * row straight back. The unit tests next door assert the delete call itself;
 * this one wires the real `createFileOps` to the real `createBrowseNavigation`
 * over one shared index and asserts on the list the user is looking at.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
	deleteEntry: vi.fn(),
	listEntries: vi.fn(),
	addToast: vi.fn(),
}));

vi.mock('$lib/native/directory-reader', () => ({
	DirectoryReader: {
		deleteEntry: mocks.deleteEntry,
		listEntries: mocks.listEntries,
	},
}));

vi.mock('$lib/stores/toastStore.svelte', () => ({
	addToast: mocks.addToast,
}));

import { createFileOps, type FileOpsView, type PendingFileOp } from '$lib/files/fileOps';
import { createBrowseNavigation, type BrowseNavigation } from '$lib/browse/browseNavigation.svelte';
import { musicSettings } from '$lib/stores/settings.svelte';
import type { StoredAudioFile } from '$lib/models/music';

beforeEach(() => {
	vi.clearAllMocks();
	mocks.deleteEntry.mockResolvedValue(undefined);
	mocks.listEntries.mockResolvedValue({ folderName: '', entries: [] });
	mocks.addToast.mockReturnValue('toast');
	musicSettings.librarySource = 'device';
	musicSettings.lastFolderName = 'Library';
	musicSettings.sortOrder = 'filename';
});

const song: StoredAudioFile = {
	source: 'native', name: 'song.mp3', relativePath: 'Albums/song.mp3', path: '/sdcard/Albums/song.mp3',
};
const keeper: StoredAudioFile = {
	source: 'native', name: 'keep.mp3', relativePath: 'Albums/keep.mp3', path: '/sdcard/Albums/keep.mp3',
};

/** One deck: a library index, a browse list over it, and the file ops. */
function makeDeck(options: { files: StoredAudioFile[]; browsePath: string[]; driveSearch?: string }) {
	let allFiles: StoredAudioFile[] = options.files;
	let pendingFileOp: PendingFileOp | null = null;
	const deviceLibrary = {
		nativeTreeUri: 'content://tree' as string | null,
		openFolder: vi.fn().mockResolvedValue(undefined),
		loadLocalFolderPicker: vi.fn().mockResolvedValue(undefined),
	};

	const browseNavigation: BrowseNavigation = createBrowseNavigation({
		deviceLibrary: { libraryScanPromise: null, nativeTreeUri: 'content://tree', rootDirHandle: null },
		view: {
			get allFiles() { return allFiles; },
			browsePath: options.browsePath,
			fileSearchQuery: '',
			selectedBrowseFileKeys: [],
		},
	});

	const view: FileOpsView = {
		get pendingFileOp() { return pendingFileOp; },
		set pendingFileOp(v) { pendingFileOp = v; },
		isFileOpRunning: false,
		showLocalFolderPicker: false,
		browsePath: options.browsePath,
		driveSearch: options.driveSearch ?? '',
		get allFiles() { return allFiles; },
		set allFiles(v) { allFiles = v; },
	};

	const fileOps = createFileOps({
		deviceLibrary,
		browseNavigation,
		isNativeApp: true,
		deleteDriveFile: vi.fn().mockResolvedValue(undefined),
		view,
	});

	return {
		fileOps,
		browseNavigation,
		get allFiles() { return allFiles; },
		queueDelete(file: StoredAudioFile) {
			pendingFileOp = { op: 'delete', name: file.name, isDrive: file.source === 'drive', fileId: null, source: file };
		},
	};
}

describe('a successful delete updates the browse list', () => {
	it('drops the deleted local row and keeps the rest', async () => {
		const deck = makeDeck({ files: [song, keeper], browsePath: ['Albums'] });
		await deck.browseNavigation.loadBrowseEntries(['Albums']);
		expect(deck.browseNavigation.browseEntries.map((entry) => entry.name)).toEqual(['keep.mp3', 'song.mp3']);

		deck.queueDelete(song);
		await deck.fileOps.runPendingFileOp(null);

		await vi.waitFor(() => {
			expect(deck.browseNavigation.browseEntries.map((entry) => entry.name)).toEqual(['keep.mp3']);
		});
		expect(deck.allFiles).toEqual([keeper]);
	});

	it('drops the deleted Drive row and leaves the Drive listing intact', async () => {
		musicSettings.librarySource = 'drive';
		const driveSong: StoredAudioFile = {
			source: 'drive', name: 'song.mp3', relativePath: 'Albums/song.mp3', fileId: 'drive-1',
		};
		const driveKeeper: StoredAudioFile = {
			source: 'drive', name: 'keep.mp3', relativePath: 'Albums/keep.mp3', fileId: 'drive-2',
		};
		const deck = makeDeck({ files: [driveSong, driveKeeper], browsePath: ['Albums'] });
		await deck.browseNavigation.loadBrowseEntries(['Albums']);
		expect(deck.browseNavigation.browseEntries.map((entry) => entry.name)).toEqual(['keep.mp3', 'song.mp3']);

		deck.queueDelete(driveSong);
		await deck.fileOps.runPendingFileOp(null);

		await vi.waitFor(() => {
			expect(deck.browseNavigation.browseEntries.map((entry) => entry.name)).toEqual(['keep.mp3']);
		});
		expect(deck.allFiles).toEqual([driveKeeper]);
	});
});
