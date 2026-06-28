/**
 * IndexedDB primitives + persistence helpers, extracted from Mp3PlayerView.
 *
 * Two databases are used:
 *  - `music-app` (v2): `handles` (FileSystemDirectoryHandle) + `libraries`
 *    (cached library file lists).
 *  - `music-app-drive-cache` (v1): `drive-files` (Google Drive file-list cache).
 *
 * View-coupled logic (saveCachedLibrary, which derives its cache key from
 * nativeTreeUri) stays in the view and calls these primitives.
 */

import type { CachedLibrary, GoogleDriveFile } from '$lib/models/music';

// ── Generic IDB request helpers ────────────────────────────────
export function idbGet<T>(db: IDBDatabase, store: string, key: string): Promise<T | null> {
	return new Promise((res, rej) => {
		const req = db.transaction(store).objectStore(store).get(key);
		req.onsuccess = () => res((req.result ?? null) as T | null);
		req.onerror = () => rej(req.error);
	});
}

export function idbPut(db: IDBDatabase, store: string, value: unknown, key: string): Promise<void> {
	return new Promise((res, rej) => {
		const tx = db.transaction(store, 'readwrite');
		tx.objectStore(store).put(value, key);
		tx.oncomplete = () => res();
		tx.onerror = () => rej(tx.error);
	});
}

export function idbDelete(db: IDBDatabase, store: string, key: string): Promise<void> {
	return new Promise((res, rej) => {
		const tx = db.transaction(store, 'readwrite');
		tx.objectStore(store).delete(key);
		tx.oncomplete = () => res();
		tx.onerror = () => rej(tx.error);
	});
}

// ── music-app database (handles + libraries) ───────────────────
export function openIDB(): Promise<IDBDatabase> {
	return new Promise((res, rej) => {
		const req = indexedDB.open('music-app', 2);
		req.onupgradeneeded = () => {
			const db = req.result;
			if (!db.objectStoreNames.contains('handles')) db.createObjectStore('handles');
			if (!db.objectStoreNames.contains('libraries')) db.createObjectStore('libraries');
		};
		req.onsuccess = () => res(req.result);
		req.onerror = () => rej(req.error);
		// Reject instead of hanging when another connection blocks the version change.
		req.onblocked = () => rej(new Error('IDB open blocked'));
	});
}

export async function saveHandleToIDB(handle: FileSystemDirectoryHandle): Promise<void> {
	try {
		const db = await openIDB();
		await idbPut(db, 'handles', handle, 'last-dir');
		db.close();
	} catch { /* storage unavailable */ }
}

export async function loadHandleFromIDB(): Promise<FileSystemDirectoryHandle | null> {
	try {
		const db = await openIDB();
		const h = await idbGet<FileSystemDirectoryHandle>(db, 'handles', 'last-dir');
		db.close();
		return h;
	} catch {
		return null;
	}
}

export async function loadCachedLibrary(cacheKey: string): Promise<CachedLibrary | null> {
	try {
		const db = await openIDB();
		const r = await idbGet<CachedLibrary>(db, 'libraries', cacheKey);
		db.close();
		return r;
	} catch {
		return null;
	}
}

export async function deleteCachedLibrary(cacheKey: string): Promise<void> {
	try {
		const db = await openIDB();
		await idbDelete(db, 'libraries', cacheKey);
		db.close();
	} catch { /* ignore cache delete failures */ }
}

// ── music-app-drive-cache database (drive-files) ───────────────
export const DRIVE_CACHE_TTL = 60 * 60 * 1000;

export function openDriveCacheIDB(): Promise<IDBDatabase> {
	return new Promise((res, rej) => {
		const req = indexedDB.open('music-app-drive-cache', 1);
		req.onupgradeneeded = () => {
			const db = req.result;
			if (!db.objectStoreNames.contains('drive-files')) db.createObjectStore('drive-files');
		};
		req.onsuccess = () => res(req.result);
		req.onerror = () => rej(req.error);
	});
}

export async function saveDriveCache(cacheKey: string, files: GoogleDriveFile[]): Promise<void> {
	try {
		const db = await openDriveCacheIDB();
		await idbPut(db, 'drive-files', { files, savedAt: Date.now() }, cacheKey);
		db.close();
	} catch { /* ignore cache write failures */ }
}

export async function loadDriveCache(cacheKey: string): Promise<GoogleDriveFile[] | null> {
	try {
		const db = await openDriveCacheIDB();
		const entry = await idbGet<{ files: GoogleDriveFile[]; savedAt: number }>(db, 'drive-files', cacheKey);
		db.close();
		if (!entry || Date.now() - entry.savedAt > DRIVE_CACHE_TTL) return null;
		return entry.files;
	} catch {
		return null;
	}
}

export async function bustDriveCache(cacheKey: string): Promise<void> {
	try {
		const db = await openDriveCacheIDB();
		await idbDelete(db, 'drive-files', cacheKey);
		db.close();
	} catch { /* ignore */ }
}
