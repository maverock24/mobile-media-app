import { describe, it, expect, beforeEach } from 'vitest';
import {
	idbGet, idbPut, idbDelete, openIDB, openDriveCacheIDB,
	saveHandleToIDB, loadHandleFromIDB,
	loadCachedLibrary, deleteCachedLibrary,
	saveDriveCache, loadDriveCache, bustDriveCache,
} from '$lib/utils/idb';

beforeEach(async () => {
	// Wipe both databases between tests for isolation.
	const dbs = ['music-app', 'music-app-drive-cache'];
	await Promise.all(dbs.map((name) => new Promise<void>((res) => {
		const req = indexedDB.deleteDatabase(name);
		req.onsuccess = () => res();
		req.onerror = () => res();
		req.onblocked = () => res();
	})));
});

describe('generic idb helpers', () => {
	it('put / get / delete round-trip', async () => {
		const db = await openIDB();
		await idbPut(db, 'libraries', { a: 1 }, 'k1');
		expect(await idbGet(db, 'libraries', 'k1')).toEqual({ a: 1 });
		await idbDelete(db, 'libraries', 'k1');
		expect(await idbGet(db, 'libraries', 'k1')).toBeNull();
		db.close();
	});

	it('get returns null for missing keys', async () => {
		const db = await openIDB();
		expect(await idbGet(db, 'libraries', 'nope')).toBeNull();
		db.close();
	});
});

describe('handle persistence', () => {
	it('saveHandleToIDB / loadHandleFromIDB round-trip (plain object stand-in)', async () => {
		// FileSystemDirectoryHandle isn't constructible under jsdom; a plain
		// structured-cloneable object exercises the same IDB path.
		const handle = { kind: 'directory', name: 'music' } as unknown as FileSystemDirectoryHandle;
		await saveHandleToIDB(handle);
		const loaded = await loadHandleFromIDB();
		expect(loaded).toEqual(handle);
	});
});

describe('library cache', () => {
	it('load returns null before any save', async () => {
		expect(await loadCachedLibrary('k')).toBeNull();
	});

	it('delete is a no-op on a missing key', async () => {
		await expect(deleteCachedLibrary('missing')).resolves.toBeUndefined();
	});
});

describe('drive cache + TTL', () => {
	it('save / load round-trip', async () => {
		const files = [{ id: 'f1', name: 'a.mp3' }];
		await saveDriveCache('k', files);
		expect(await loadDriveCache('k')).toEqual(files);
	});

	it('returns null when no entry', async () => {
		expect(await loadDriveCache('missing')).toBeNull();
	});

	it('bust removes the entry', async () => {
		await saveDriveCache('k', [{ id: 'f1', name: 'a.mp3' }]);
		await bustDriveCache('k');
		expect(await loadDriveCache('k')).toBeNull();
	});

	it('expires after the TTL (entries with an old savedAt return null)', async () => {
		// Write an entry directly with a stale timestamp to simulate expiry.
		const db = await openDriveCacheIDB();
		await idbPut(db, 'drive-files', { files: [{ id: 'old' }], savedAt: 0 }, 'stale');
		db.close();
		expect(await loadDriveCache('stale')).toBeNull();
	});
});
