import { describe, it, expect, beforeEach } from 'vitest';
import {
	LAST_LIBRARY_CACHE_KEY,
	getDeviceLibraryCacheKey,
	saveCachedLibrary,
	loadDeviceCachedLibrary,
	restoreStoredFilesFromCache,
	collectStoredFilesFromSnapshot,
	pathToString,
	collectFilesFromDirHandle,
	collectStoredFilesFromDirHandle,
	resolveDirAtPath,
} from '$lib/browse/libraryCache';
import type { CachedLibrary, CachedLibraryFile, StoredAudioFile } from '$lib/models/music';
import { loadCachedLibrary } from '$lib/utils/idb';

beforeEach(async () => {
	// Wipe the db between tests so the last-library mirror cannot leak across.
	await new Promise<void>((res) => {
		const req = indexedDB.deleteDatabase('music-app');
		req.onsuccess = () => res();
		req.onerror = () => res();
		req.onblocked = () => res();
	});
});

// ── helpers ──────────────────────────────────────────────────

const native = (name: string, relPath = name): StoredAudioFile => ({
	source: 'native',
	name,
	relativePath: relPath,
	path: `/sdcard/${relPath}`,
	mimeType: 'audio/mpeg',
});

const web = (name: string, relPath = name): StoredAudioFile => ({
	source: 'web',
	name,
	relativePath: relPath,
	file: new File([], name),
});

// jsdom has no FileSystemDirectoryHandle constructor, so the walkers are driven
// by plain objects that implement only what they read: async iteration of
// [name, handle] pairs, and getFile() on files. Same stand-in approach
// tests/unit/utils/idb.test.ts uses for handle persistence.

function fileHandle(name: string): FileSystemFileHandle {
	return {
		kind: 'file',
		name,
		async getFile() { return new File(['bytes'], name); },
	} as unknown as FileSystemFileHandle;
}

function dirHandle(name: string, ...entries: [string, FileSystemHandle][]): FileSystemDirectoryHandle {
	return {
		kind: 'directory',
		name,
		async *[Symbol.asyncIterator]() {
			for (const entry of entries) yield entry;
		},
	} as unknown as FileSystemDirectoryHandle;
}

// ─────────────────────────────────────────────────────────────
// getDeviceLibraryCacheKey
// ─────────────────────────────────────────────────────────────

describe('getDeviceLibraryCacheKey', () => {
	it('derives the key from the tree URI when one is given', () => {
		expect(getDeviceLibraryCacheKey({ treeUri: 'content://tree/1' })).toBe('device:content://tree/1');
	});

	it('prefers the tree URI over the folder name when both are given', () => {
		expect(getDeviceLibraryCacheKey({ treeUri: 'content://tree/1', folderName: 'Music' })).toBe('device:content://tree/1');
	});

	it('falls back to the folder name when there is no tree URI', () => {
		expect(getDeviceLibraryCacheKey({ folderName: 'Music' })).toBe('device-folder:Music');
	});

	it('falls back to the folder name for null and empty tree URIs', () => {
		expect(getDeviceLibraryCacheKey({ treeUri: null, folderName: 'Music' })).toBe('device-folder:Music');
		expect(getDeviceLibraryCacheKey({ treeUri: '', folderName: 'Music' })).toBe('device-folder:Music');
	});

	it('returns the last-library key when nothing identifies the folder', () => {
		expect(getDeviceLibraryCacheKey({})).toBe(LAST_LIBRARY_CACHE_KEY);
		expect(getDeviceLibraryCacheKey()).toBe(LAST_LIBRARY_CACHE_KEY);
		expect(getDeviceLibraryCacheKey({ treeUri: null, folderName: null })).toBe(LAST_LIBRARY_CACHE_KEY);
	});
});

// ─────────────────────────────────────────────────────────────
// pathToString
// ─────────────────────────────────────────────────────────────

describe('pathToString', () => {
	it('returns undefined at the root', () => {
		expect(pathToString([])).toBeUndefined();
	});

	it('joins a single segment', () => {
		expect(pathToString(['Music'])).toBe('Music');
	});

	it('joins nested segments with a slash', () => {
		expect(pathToString(['Music', 'Albums', 'Live'])).toBe('Music/Albums/Live');
	});
});

// ─────────────────────────────────────────────────────────────
// collectStoredFilesFromSnapshot
// ─────────────────────────────────────────────────────────────

describe('collectStoredFilesFromSnapshot', () => {
	it('returns every file at the root, sorted by filename', () => {
		const files = [native('10.mp3'), native('2.mp3'), native('1.mp3')];
		expect(collectStoredFilesFromSnapshot(files, [], 'filename').map((f) => f.name)).toEqual(['1.mp3', '2.mp3', '10.mp3']);
	});

	it('keeps only files under the prefix', () => {
		const files = [native('x.mp3', 'a/x.mp3'), native('y.mp3', 'a/y.mp3'), native('z.mp3', 'b/z.mp3')];
		expect(collectStoredFilesFromSnapshot(files, ['a'], 'filename').map((f) => f.name)).toEqual(['x.mp3', 'y.mp3']);
	});

	it('excludes a file whose relativePath only shares the prefix text', () => {
		// 'ab/x.mp3' must not match path ['a']; the scan appends its own slash.
		const files = [native('x.mp3', 'ab/x.mp3'), native('keep.mp3', 'a/keep.mp3')];
		expect(collectStoredFilesFromSnapshot(files, ['a'], 'filename').map((f) => f.name)).toEqual(['keep.mp3']);
	});

	it('walks nested prefixes', () => {
		const files = [native('d.mp3', 'a/b/c/d.mp3'), native('e.mp3', 'a/b/c/e.mp3'), native('f.mp3', 'a/b/f.mp3')];
		expect(collectStoredFilesFromSnapshot(files, ['a', 'b', 'c'], 'filename').map((f) => f.name)).toEqual(['d.mp3', 'e.mp3']);
	});

	it('returns an empty list when nothing matches', () => {
		expect(collectStoredFilesFromSnapshot([native('a.mp3')], ['nope'], 'filename')).toEqual([]);
	});

	it('returns an empty list for an empty snapshot', () => {
		expect(collectStoredFilesFromSnapshot([], [], 'filename')).toEqual([]);
	});

	it('honours the title sort order instead of the filename order', () => {
		// Parsed titles are 'a' and 'z', so title order reverses the filename order.
		const files = [native('B - a.mp3'), native('A - z.mp3')];
		expect(collectStoredFilesFromSnapshot(files, [], 'title').map((f) => f.name)).toEqual(['B - a.mp3', 'A - z.mp3']);
		expect(collectStoredFilesFromSnapshot(files, [], 'filename').map((f) => f.name)).toEqual(['A - z.mp3', 'B - a.mp3']);
	});

	it('does not mutate the input array', () => {
		const files = [native('10.mp3'), native('2.mp3')];
		collectStoredFilesFromSnapshot(files, [], 'filename');
		expect(files.map((f) => f.name)).toEqual(['10.mp3', '2.mp3']);
	});

	it('filters files with no relativePath by their name', () => {
		const orphan: StoredAudioFile = { source: 'native', name: 'orphan.mp3', relativePath: '', path: '/x' };
		expect(collectStoredFilesFromSnapshot([orphan], ['sub'], 'filename')).toEqual([]);
		expect(collectStoredFilesFromSnapshot([orphan], [], 'filename').map((f) => f.name)).toEqual(['orphan.mp3']);
	});
});

// ─────────────────────────────────────────────────────────────
// restoreStoredFilesFromCache
// ─────────────────────────────────────────────────────────────

describe('restoreStoredFilesFromCache', () => {
	const cached: CachedLibrary = {
		folderName: 'Music',
		savedAt: 1,
		cacheKey: 'device:tree',
		files: [
			{ source: 'native', name: 'n.mp3', relativePath: 'sub/n.mp3', path: '/sdcard/sub/n.mp3', mimeType: 'audio/mpeg', modifiedAt: 7 },
			{ source: 'web', name: 'w.mp3', relativePath: 'sub/w.mp3', file: new File([], 'w.mp3') },
		] as CachedLibraryFile[],
	};

	it('rehydrates native entries as stored native files', () => {
		const [entry] = restoreStoredFilesFromCache(cached);
		expect(entry).toEqual({
			source: 'native',
			name: 'n.mp3',
			relativePath: 'sub/n.mp3',
			path: '/sdcard/sub/n.mp3',
			mimeType: 'audio/mpeg',
			modifiedAt: 7,
		});
	});

	it('re-wraps web entries around their cached File', () => {
		const restored = restoreStoredFilesFromCache(cached);
		expect(restored[1].source).toBe('web');
		expect(restored[1].name).toBe('w.mp3');
		expect(restored[1].relativePath).toBe('sub/w.mp3');
	});

	it('returns an empty list for an empty cache', () => {
		expect(restoreStoredFilesFromCache({ folderName: 'x', files: [], savedAt: 0 })).toEqual([]);
	});
});

// ─────────────────────────────────────────────────────────────
// saveCachedLibrary / loadDeviceCachedLibrary
// ─────────────────────────────────────────────────────────────

describe('saveCachedLibrary / loadDeviceCachedLibrary', () => {
	it('round-trips a native library under its tree-URI key', async () => {
		await saveCachedLibrary('content://tree/1', 'Music', [native('a.mp3', 'sub/a.mp3')]);
		const loaded = await loadDeviceCachedLibrary('content://tree/1', 'Music');
		expect(loaded?.folderName).toBe('Music');
		expect(loaded?.files).toEqual([
			{ source: 'native', name: 'a.mp3', relativePath: 'sub/a.mp3', path: '/sdcard/sub/a.mp3', mimeType: 'audio/mpeg', modifiedAt: undefined },
		]);
	});

	it('mirrors the write under the last-library key', async () => {
		await saveCachedLibrary('content://tree/1', 'Music', [native('a.mp3')]);
		// No tree URI or folder-name key match, so only the mirror can answer.
		const loaded = await loadDeviceCachedLibrary(null, 'Music');
		expect(loaded?.folderName).toBe('Music');
		expect(loaded?.files).toHaveLength(1);
	});

	it('rejects the last-library mirror when the folder name differs', async () => {
		await saveCachedLibrary('content://tree/1', 'Music', [native('a.mp3')]);
		expect(await loadDeviceCachedLibrary(null, 'Other')).toBeNull();
	});

	it('writes nothing for an empty library', async () => {
		await saveCachedLibrary('content://tree/1', 'Music', []);
		expect(await loadDeviceCachedLibrary('content://tree/1', 'Music')).toBeNull();
	});

	it('drops drive entries, so a drive-only library writes nothing', async () => {
		const drive: StoredAudioFile = { source: 'drive', name: 'd.mp3', relativePath: 'd.mp3', fileId: 'f1' };
		await saveCachedLibrary('content://tree/1', 'Music', [drive]);
		expect(await loadDeviceCachedLibrary('content://tree/1', 'Music')).toBeNull();
	});

	it('loads nothing for a folder that was never cached', async () => {
		expect(await loadDeviceCachedLibrary('content://tree/1', 'Music')).toBeNull();
	});

	it('uses an explicit cache key when one is passed', async () => {
		await saveCachedLibrary('content://tree/1', 'Music', [native('a.mp3')], 'custom-key');
		expect(await loadCachedLibrary('custom-key')).not.toBeNull();
		expect(await loadCachedLibrary('device:content://tree/1')).toBeNull();
		// The last-library mirror is written alongside any non-last key.
		expect(await loadCachedLibrary(LAST_LIBRARY_CACHE_KEY)).not.toBeNull();
	});
});

// ─────────────────────────────────────────────────────────────
// directory-handle walking
// ─────────────────────────────────────────────────────────────

describe('collectFilesFromDirHandle', () => {
	it('collects supported files recursively', async () => {
		const root = dirHandle(
			'root',
			['a.mp3', fileHandle('a.mp3')],
			['notes.txt', fileHandle('notes.txt')],
			[
				'sub',
				dirHandle(
					'sub',
					['b.m4a', fileHandle('b.m4a')],
					['deep', dirHandle('deep', ['c.mp3', fileHandle('c.mp3')])],
				),
			],
		);
		const files = await collectFilesFromDirHandle(root);
		expect(files.map((f) => f.name).sort()).toEqual(['a.mp3', 'b.m4a', 'c.mp3']);
	});

	it('returns an empty list for an empty directory', async () => {
		expect(await collectFilesFromDirHandle(dirHandle('empty'))).toEqual([]);
	});

	it('ignores unsupported extensions', async () => {
		const root = dirHandle('root', ['cover.jpg', fileHandle('cover.jpg')], ['x.MP3', fileHandle('x.MP3')]);
		// Extension matching is case-insensitive, so x.MP3 is kept.
		expect((await collectFilesFromDirHandle(root)).map((f) => f.name)).toEqual(['x.MP3']);
	});
});

describe('collectStoredFilesFromDirHandle', () => {
	it('builds relativePath from the walked segments', async () => {
		const root = dirHandle(
			'root',
			['top.mp3', fileHandle('top.mp3')],
			['sub', dirHandle('sub', ['inner.m4a', fileHandle('inner.m4a')])],
		);
		const stored = await collectStoredFilesFromDirHandle(root);
		expect(stored.map((f) => `${f.source}:${f.relativePath}`).sort()).toEqual(['web:sub/inner.m4a', 'web:top.mp3']);
	});

	it('honours a starting path prefix', async () => {
		const root = dirHandle('root', ['inner.mp3', fileHandle('inner.mp3')]);
		const stored = await collectStoredFilesFromDirHandle(root, ['a', 'b']);
		expect(stored[0].relativePath).toBe('a/b/inner.mp3');
	});

	it('carries the File through on each entry', async () => {
		const root = dirHandle('root', ['one.mp3', fileHandle('one.mp3')]);
		const [entry] = await collectStoredFilesFromDirHandle(root);
		expect(entry.source).toBe('web');
		if (entry.source === 'web') expect(entry.file.name).toBe('one.mp3');
	});

	it('returns an empty list for an empty directory', async () => {
		expect(await collectStoredFilesFromDirHandle(dirHandle('empty'))).toEqual([]);
	});
});

describe('resolveDirAtPath', () => {
	const sub = dirHandle('sub', ['x.mp3', fileHandle('x.mp3')]);
	const root = dirHandle('root', ['sub', sub], ['other', dirHandle('other')]);

	it('returns null for a missing root handle', async () => {
		expect(await resolveDirAtPath(null, [])).toBeNull();
	});

	it('returns the root itself for an empty path', async () => {
		expect(await resolveDirAtPath(root, [])).toBe(root);
	});

	it('descends into a named segment', async () => {
		expect(await resolveDirAtPath(root, ['sub'])).toBe(sub);
	});

	it('returns null when a segment is missing', async () => {
		expect(await resolveDirAtPath(root, ['nope'])).toBeNull();
	});

	it('returns null when a later segment is missing', async () => {
		expect(await resolveDirAtPath(root, ['sub', 'nope'])).toBeNull();
	});

	it('does not descend into a file that shares the segment name', async () => {
		const withFile = dirHandle('root', ['sub', fileHandle('sub')]);
		expect(await resolveDirAtPath(withFile, ['sub'])).toBeNull();
	});
});
