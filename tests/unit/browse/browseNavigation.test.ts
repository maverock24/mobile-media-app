import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { StoredAudioFile } from '$lib/models/music';

// The module lists native folders through DirectoryReader. It is replaced with
// a vi.fn stand-in so the live-listing branches and the load-id bail can be
// driven without a device. Everything else is real: the sorts, the entry
// builder, the settings store, the favourites flag and the media engine.
const mocks = vi.hoisted(() => ({ listEntries: vi.fn() }));

vi.mock('$lib/native/directory-reader', () => ({
	DirectoryReader: { listEntries: mocks.listEntries },
}));

import {
	createBrowseNavigation,
	type BrowseNavigation,
	type BrowseNavigationDeviceLibrary,
	type BrowseNavigationView
} from '$lib/browse/browseNavigation.svelte';
import { musicSettings } from '$lib/stores/settings.svelte';
import { musicFavorites } from '$lib/stores/musicView.svelte';
import { mediaEngine } from '$lib/stores/mediaEngine.svelte';

beforeEach(() => {
	vi.clearAllMocks();
	musicSettings.librarySource = 'device';
	musicSettings.sortOrder = 'filename';
	musicFavorites.shown = false;
	mediaEngine.musicSelectionLoopActive = false;
	mocks.listEntries.mockResolvedValue({ folderName: '', entries: [] });
});

// ── helpers ──────────────────────────────────────────────────

const native = (name: string, relPath = name): StoredAudioFile => ({
	source: 'native', name, relativePath: relPath, path: `/sdcard/${relPath}`, mimeType: 'audio/mpeg',
});

const drive = (name: string, relPath = name): StoredAudioFile => ({
	source: 'drive', name, relativePath: relPath, fileId: `id:${relPath}`,
});

const nativeEntry = (name: string) => ({ kind: 'file' as const, name, path: `/sdcard/${name}`, relativePath: name });
const folderEntry = (name: string) => ({ kind: 'folder' as const, name });

/** jsdom has no FileSystemDirectoryHandle; a plain async-iterable stands in. */
function dirHandle(name: string, ...entries: [string, FileSystemHandle][]): FileSystemDirectoryHandle {
	return {
		kind: 'directory',
		name,
		async *[Symbol.asyncIterator]() {
			for (const entry of entries) yield entry;
		},
	} as unknown as FileSystemDirectoryHandle;
}

const fileHandle = (name: string): FileSystemFileHandle => ({
	kind: 'file',
	name,
	async getFile() { return new File(['bytes'], name); },
} as unknown as FileSystemFileHandle);

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((r) => { resolve = r; });
	return { promise, resolve };
}

function makeNav(overrides: {
	allFiles?: StoredAudioFile[];
	browsePath?: string[];
	fileSearchQuery?: string;
	selectedBrowseFileKeys?: string[];
	libraryScanPromise?: Promise<StoredAudioFile[]> | null;
	nativeTreeUri?: string | null;
	rootDirHandle?: FileSystemDirectoryHandle | null;
} = {}): { nav: BrowseNavigation; view: BrowseNavigationView; deviceLibrary: BrowseNavigationDeviceLibrary } {
	const view: BrowseNavigationView = {
		allFiles: overrides.allFiles ?? [],
		browsePath: overrides.browsePath ?? [],
		fileSearchQuery: overrides.fileSearchQuery ?? '',
		selectedBrowseFileKeys: overrides.selectedBrowseFileKeys ?? [],
	};
	const deviceLibrary: BrowseNavigationDeviceLibrary = {
		libraryScanPromise: overrides.libraryScanPromise ?? null,
		nativeTreeUri: overrides.nativeTreeUri ?? null,
		rootDirHandle: overrides.rootDirHandle ?? null,
	};
	return { nav: createBrowseNavigation({ deviceLibrary, view }), view, deviceLibrary };
}

// ─────────────────────────────────────────────────────────────
// loadBrowseEntries — drive branch
// ─────────────────────────────────────────────────────────────

describe('loadBrowseEntries — drive source', () => {
	it('filters to drive files matching the name/title/artist haystack', async () => {
		musicSettings.librarySource = 'drive';
		const { nav } = makeNav({
			allFiles: [
				drive('Beta - song.mp3', 'a/Beta - song.mp3'),
				native('Beta - song.mp3', 'a/Beta - song.mp3'),
				drive('Other.mp3', 'a/Other.mp3'),
			],
		});
		await nav.loadBrowseEntries([], 'beta');
		expect(nav.browseEntries.map((e) => `${e.kind}:${e.name}`)).toEqual(['file:Beta - song.mp3']);
	});

	it('sorts the filtered drive files numerically', async () => {
		musicSettings.librarySource = 'drive';
		const { nav } = makeNav({
			allFiles: [drive('Track 10.mp3'), drive('Track 2.mp3'), drive('Track 1.mp3')],
		});
		await nav.loadBrowseEntries([], 'track');
		expect(nav.browseEntries.map((e) => e.name)).toEqual(['Track 1.mp3', 'Track 2.mp3', 'Track 10.mp3']);
	});

	it('does not enter the drive search branch without a drive filter', async () => {
		musicSettings.librarySource = 'drive';
		const { nav } = makeNav({ allFiles: [drive('a/x.mp3', 'a/x.mp3')] });
		await nav.loadBrowseEntries(['a'], '');
		// Falls through to the snapshot branch, which builds from the path.
		expect(nav.browseEntries.map((e) => `${e.kind}:${e.name}`)).toEqual(['file:x.mp3']);
	});
});

// ─────────────────────────────────────────────────────────────
// loadBrowseEntries — device branches
// ─────────────────────────────────────────────────────────────

describe('loadBrowseEntries — device snapshot branch', () => {
	it('builds entries from the file snapshot with folders before files, numerically sorted', async () => {
		const { nav } = makeNav({
			allFiles: [
				native('b.mp3', 'root/Beta/b.mp3'),
				native('a.mp3', 'root/Alpha/a.mp3'),
				native('Root 10.mp3', 'root/Root 10.mp3'),
				native('Root 2.mp3', 'root/Root 2.mp3'),
				native('Root 1.mp3', 'root/Root 1.mp3'),
			],
			browsePath: ['root'],
		});
		await nav.loadBrowseEntries(['root']);
		expect(nav.browseEntries.map((e) => `${e.kind}:${e.name}`)).toEqual([
			'folder:Alpha', 'folder:Beta',
			'file:Root 1.mp3', 'file:Root 2.mp3', 'file:Root 10.mp3',
		]);
	});

	it('uses the snapshot even while an index scan is in flight when it has entries for the path', async () => {
		const pending = deferred<StoredAudioFile[]>();
		const { nav } = makeNav({
			allFiles: [native('x.mp3', 'a/x.mp3')],
			libraryScanPromise: pending.promise,
			nativeTreeUri: 'content://tree',
		});
		await nav.loadBrowseEntries(['a']);
		expect(nav.browseEntries.map((e) => e.name)).toEqual(['x.mp3']);
		expect(mocks.listEntries).not.toHaveBeenCalled();
	});

	it('live-lists through the tree URI when the path is not yet indexed and a scan is in flight', async () => {
		const pending = deferred<StoredAudioFile[]>();
		mocks.listEntries.mockResolvedValue({
			folderName: 'sub',
			entries: [folderEntry('Zeta'), folderEntry('Alpha'), nativeEntry('10.mp3'), nativeEntry('2.mp3'), nativeEntry('1.mp3')],
		});
		const { nav } = makeNav({
			allFiles: [native('other.mp3', 'other/other.mp3')],
			libraryScanPromise: pending.promise,
			nativeTreeUri: 'content://tree',
		});
		await nav.loadBrowseEntries(['sub']);
		expect(mocks.listEntries).toHaveBeenCalledWith({ treeUri: 'content://tree', path: 'sub' });
		expect(nav.browseEntries.map((e) => `${e.kind}:${e.name}`)).toEqual([
			'folder:Alpha', 'folder:Zeta', 'file:1.mp3', 'file:2.mp3', 'file:10.mp3',
		]);
	});
});

describe('loadBrowseEntries — device live branches', () => {
	it('walks a File System Access root handle, counting files and wrapping audio', async () => {
		const sub = dirHandle('sub', ['inner.mp3', fileHandle('inner.mp3')], ['notes.txt', fileHandle('notes.txt')]);
		const root = dirHandle('root',
			['sub', sub],
			['top.mp3', fileHandle('top.mp3')],
			['readme.txt', fileHandle('readme.txt')],
		);
		const { nav } = makeNav({ rootDirHandle: root });
		await nav.loadBrowseEntries([]);
		expect(nav.browseEntries.map((e) => `${e.kind}:${e.name}:${e.kind === 'folder' ? e.count : ''}`)).toEqual([
			'folder:sub:1', 'file:top.mp3:',
		]);
	});

	it('lists native audio through the tree URI when allFiles is empty', async () => {
		mocks.listEntries.mockResolvedValue({
			folderName: 'Music',
			entries: [nativeEntry('Track 10.mp3'), nativeEntry('Track 2.mp3'), nativeEntry('Track 1.mp3')],
		});
		const { nav } = makeNav({ nativeTreeUri: 'content://tree' });
		await nav.loadBrowseEntries(['Music']);
		expect(mocks.listEntries).toHaveBeenCalledWith({ treeUri: 'content://tree', path: 'Music' });
		expect(nav.browseEntries.map((e) => e.name)).toEqual(['Track 1.mp3', 'Track 2.mp3', 'Track 10.mp3']);
	});

	it('returns an empty list when no source is available', async () => {
		const { nav } = makeNav();
		await nav.loadBrowseEntries([]);
		expect(nav.browseEntries).toEqual([]);
	});
});

describe('loadBrowseEntries — loading flag and errors', () => {
	it('sets browseLoading true while loading and false when done', async () => {
		const pending = deferred<{ folderName: string; entries: ReturnType<typeof nativeEntry>[] }>();
		mocks.listEntries.mockReturnValue(pending.promise);
		const { nav } = makeNav({ nativeTreeUri: 'content://tree' });
		expect(nav.browseLoading).toBe(false);
		const load = nav.loadBrowseEntries([]);
		expect(nav.browseLoading).toBe(true);
		pending.resolve({ folderName: '', entries: [] });
		await load;
		expect(nav.browseLoading).toBe(false);
	});

	it('clears browseEntries and browseLoading when the listing throws', async () => {
		mocks.listEntries.mockRejectedValue(new Error('device gone'));
		const { nav } = makeNav({ nativeTreeUri: 'content://tree' });
		await nav.loadBrowseEntries([]);
		expect(nav.browseEntries).toEqual([]);
		expect(nav.browseLoading).toBe(false);
	});
});

describe('loadBrowseEntries — load-id bail', () => {
	it('drops a superseded load: the newer listing wins and the older does not clear loading', async () => {
		const first = deferred<{ folderName: string; entries: ReturnType<typeof nativeEntry>[] }>();
		const second = deferred<{ folderName: string; entries: ReturnType<typeof nativeEntry>[] }>();
		mocks.listEntries.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
		const { nav } = makeNav({ nativeTreeUri: 'content://tree' });

		const loadA = nav.loadBrowseEntries(['a']);
		const loadB = nav.loadBrowseEntries(['b']);
		// Resolve the newer load first; the older then resolves and must bail.
		second.resolve({ folderName: '', entries: [nativeEntry('newer.mp3')] });
		await loadB;
		first.resolve({ folderName: '', entries: [nativeEntry('older.mp3')] });
		await loadA;

		expect(nav.browseEntries.map((e) => e.name)).toEqual(['newer.mp3']);
		expect(nav.browseLoading).toBe(false);
	});

	it('keeps the load-id counter per instance, so one deck does not cancel the other', async () => {
		const first = deferred<{ folderName: string; entries: ReturnType<typeof nativeEntry>[] }>();
		const second = deferred<{ folderName: string; entries: ReturnType<typeof nativeEntry>[] }>();
		mocks.listEntries.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
		const a = makeNav({ nativeTreeUri: 'content://a' });
		const b = makeNav({ nativeTreeUri: 'content://b' });

		const loadA = a.nav.loadBrowseEntries([]);
		const loadB = b.nav.loadBrowseEntries([]);
		// Deck B's load must not bump deck A's counter: A still applies its result.
		first.resolve({ folderName: '', entries: [nativeEntry('a.mp3')] });
		await loadA;
		expect(a.nav.browseEntries.map((e) => e.name)).toEqual(['a.mp3']);
		expect(a.nav.browseLoading).toBe(false);

		second.resolve({ folderName: '', entries: [nativeEntry('b.mp3')] });
		await loadB;
		expect(b.nav.browseEntries.map((e) => e.name)).toEqual(['b.mp3']);
	});
});

// ─────────────────────────────────────────────────────────────
// navigation functions
// ─────────────────────────────────────────────────────────────

describe('navigateInto', () => {
	it('clears the favourites view and appends the folder to the path', () => {
		musicFavorites.shown = true;
		const { nav, view } = makeNav({ browsePath: ['root'] });
		nav.navigateInto('sub');
		expect(view.browsePath).toEqual(['root', 'sub']);
		expect(musicFavorites.shown).toBe(false);
	});
});

describe('goToFileFolder', () => {
	it('sets the path to the file folder and clears search, selection and the loop flag', () => {
		musicFavorites.shown = true;
		mediaEngine.musicSelectionLoopActive = true;
		const { nav, view } = makeNav({ selectedBrowseFileKeys: ['k1', 'k2'], fileSearchQuery: 'q' });
		nav.goToFileFolder(native('song.mp3', 'root/Sub/song.mp3'));
		expect(view.browsePath).toEqual(['root', 'Sub']);
		expect(view.fileSearchQuery).toBe('');
		expect(view.selectedBrowseFileKeys).toEqual([]);
		expect(musicFavorites.shown).toBe(false);
		expect(mediaEngine.musicSelectionLoopActive).toBe(false);
	});

	it('sets the path to the root for a file with no folder', () => {
		const { nav, view } = makeNav({ browsePath: ['stale'] });
		nav.goToFileFolder(native('song.mp3', 'song.mp3'));
		expect(view.browsePath).toEqual([]);
	});
});

describe('navigateToParentFolderFromSwipe', () => {
	it('does nothing at the root', () => {
		musicFavorites.shown = true;
		const { nav, view } = makeNav({ browsePath: [] });
		nav.navigateToParentFolderFromSwipe();
		expect(view.browsePath).toEqual([]);
		expect(musicFavorites.shown).toBe(true);
	});

	it('pops one segment and clears the favourites view', () => {
		musicFavorites.shown = true;
		const { nav, view } = makeNav({ browsePath: ['a', 'b'] });
		nav.navigateToParentFolderFromSwipe();
		expect(view.browsePath).toEqual(['a']);
		expect(musicFavorites.shown).toBe(false);
	});
});

describe('navigateUp', () => {
	it('leaves the favourites view first without changing the path', () => {
		musicFavorites.shown = true;
		const { nav, view } = makeNav({ browsePath: ['a'] });
		nav.navigateUp();
		expect(musicFavorites.shown).toBe(false);
		expect(view.browsePath).toEqual(['a']);
	});

	it('pops one segment when not in the favourites view', () => {
		const { nav, view } = makeNav({ browsePath: ['a', 'b'] });
		nav.navigateUp();
		expect(view.browsePath).toEqual(['a']);
	});

	it('does nothing at the root', () => {
		const { nav, view } = makeNav({ browsePath: [] });
		nav.navigateUp();
		expect(view.browsePath).toEqual([]);
	});
});
