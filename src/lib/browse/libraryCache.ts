/**
 * libraryCache.ts — pure library-cache helpers for the browse view.
 *
 * Extracted from `Mp3PlayerView.svelte` (PR 3.2 of docs/refactoring-plan.md).
 * Owns the device cache-key derivation, the IndexedDB round-trip for a scanned
 * folder, the flatten-back of a cached library into `StoredAudioFile`s, the
 * snapshot prefix filter, and the File System Access helpers that walk a
 * directory handle.
 *
 * Pure by contract: no runes, no stores, no component state, no import from
 * `components/`. Everything the functions need arrives as a parameter. Two
 * closures over view state were removed on extraction:
 *  - `getDeviceLibraryCacheKey` no longer defaults its `treeUri` to the view's
 *    `nativeTreeUri`; the caller passes the tree URI it means.
 *  - `saveCachedLibrary` no longer derives its cache key from the view's
 *    `nativeTreeUri` in a default parameter; it takes `treeUri` instead.
 * `collectStoredFilesFromSnapshot` no longer reads `musicSettings.sortOrder`
 * through the view's `sortFiles` wrapper: it takes `sortOrder` and calls
 * `models/music.sortFiles` directly, which is the same function the wrapper
 * called. `resolveDirAtPath` no longer reads the view's `rootDirHandle`: it
 * takes the root handle.
 */
import { getRelativePath } from '$lib/models/browse';
import {
	type StoredAudioFile,
	type CachedLibrary,
	type CachedLibraryFile,
	createStoredWebAudioFile,
	isSupportedAudioFile,
	sortFiles
} from '$lib/models/music';
import { idbPut, loadCachedLibrary, openIDB } from '$lib/utils/idb';

/** Cache key for the most recent device library, whatever folder it came from. */
export const LAST_LIBRARY_CACHE_KEY = 'last-library';

/**
 * Derive the IndexedDB cache key for a device library. A tree URI wins over a
 * folder name; with neither, the key is the last-written library.
 */
export function getDeviceLibraryCacheKey(options: { treeUri?: string | null; folderName?: string | null } = {}): string {
	if (options.treeUri) return `device:${options.treeUri}`;
	if (options.folderName) return `device-folder:${options.folderName}`;
	return LAST_LIBRARY_CACHE_KEY;
}

/**
 * Persist a cooked library under its key, and under {@link LAST_LIBRARY_CACHE_KEY}
 * as well unless it is already that key. Write failures are swallowed: a full or
 * blocked IndexedDB must not break folder opening.
 */
export async function saveCachedLibrary(
	treeUri: string | null,
	folderName: string,
	files: StoredAudioFile[],
	cacheKey = getDeviceLibraryCacheKey({ treeUri, folderName })
) {
	const cachedFiles = files.reduce<CachedLibraryFile[]>((accumulator, file) => {
		if (file.source === 'web') {
			accumulator.push({
				source: 'web',
				name: file.name,
				relativePath: file.relativePath,
				file: file.file,
			});
			return accumulator;
		}

		if (file.source === 'native') {
			accumulator.push({
				source: 'native',
				name: file.name,
				relativePath: file.relativePath,
				path: file.path,
				mimeType: file.mimeType,
				modifiedAt: file.modifiedAt,
			});
		}

		return accumulator;
	}, []);

	if (cachedFiles.length === 0) return;
	try {
		const db = await openIDB();
		const payload = { folderName, files: cachedFiles, savedAt: Date.now(), cacheKey } satisfies CachedLibrary;
		await idbPut(db, 'libraries', payload, cacheKey);
		if (cacheKey !== LAST_LIBRARY_CACHE_KEY) {
			await idbPut(db, 'libraries', payload, LAST_LIBRARY_CACHE_KEY);
		}
		db.close();
	}
	catch { /* ignore cache write failures */ }
}

/**
 * Load a cached library for a tree URI / folder name. Falls back to the last
 * written library, but only when its folder name matches, so a folder rename or
 * a switch between sources cannot restore the wrong listing.
 */
export async function loadDeviceCachedLibrary(treeUri: string | null, folderName: string): Promise<CachedLibrary | null> {
	const cacheKey = getDeviceLibraryCacheKey({ treeUri, folderName });
	const cached = await loadCachedLibrary(cacheKey);
	if (cached) return cached;
	if (cacheKey === LAST_LIBRARY_CACHE_KEY) return null;
	const fallback = await loadCachedLibrary(LAST_LIBRARY_CACHE_KEY);
	return fallback?.folderName === folderName ? fallback : null;
}

/**
 * Rebuild playable `StoredAudioFile`s from a cached library. Cached entries
 * carry no live `File`, so web entries are re-wrapped and native entries are
 * returned as the plain native shape.
 */
export function restoreStoredFilesFromCache(cachedLibrary: CachedLibrary): StoredAudioFile[] {
	return cachedLibrary.files.map((file) => {
		if (file.source === 'web') {
			return createStoredWebAudioFile(file.file, file.relativePath);
		}

		return {
			source: 'native',
			name: file.name,
			relativePath: file.relativePath,
			path: file.path,
			mimeType: file.mimeType,
			modifiedAt: file.modifiedAt,
		} satisfies StoredAudioFile;
	});
}

/** Join browse path segments into a native/SAF path, or undefined at the root. */
export function pathToString(path: string[]): string | undefined {
	return path.length > 0 ? path.join('/') : undefined;
}

/**
 * The files already in memory that live under `path`, sorted with `sortOrder`.
 * At the root every file matches; deeper down the match is a relative-path
 * prefix scan.
 */
export function collectStoredFilesFromSnapshot(files: StoredAudioFile[], path: string[], sortOrder: string): StoredAudioFile[] {
	const prefix = path.length > 0 ? path.join('/') + '/' : '';
	return sortFiles(files.filter((file) => {
		const relativePath = getRelativePath(file);
		return prefix ? relativePath.startsWith(prefix) : true;
	}), sortOrder);
}

/** Collect every supported audio `File` under a directory handle, recursively. */
export async function collectFilesFromDirHandle(dir: FileSystemDirectoryHandle): Promise<File[]> {
	const result: File[] = [];
	for await (const [name, handle] of (dir as unknown as AsyncIterable<[string, FileSystemHandle]>)) {
		if (handle.kind === 'file' && isSupportedAudioFile(name)) {
			result.push(await (handle as FileSystemFileHandle).getFile());
		} else if (handle.kind === 'directory') {
			result.push(...await collectFilesFromDirHandle(handle as FileSystemDirectoryHandle));
		}
	}
	return result;
}

/**
 * Collect every supported audio file under a directory handle as stored files,
 * with the walked path segments baked into each `relativePath`.
 */
export async function collectStoredFilesFromDirHandle(
	dir: FileSystemDirectoryHandle,
	pathSegments: string[] = []
): Promise<StoredAudioFile[]> {
	const result: StoredAudioFile[] = [];
	for await (const [name, handle] of (dir as unknown as AsyncIterable<[string, FileSystemHandle]>)) {
		if (handle.kind === 'file' && isSupportedAudioFile(name)) {
			const file = await (handle as FileSystemFileHandle).getFile();
			result.push(createStoredWebAudioFile(file, [...pathSegments, name].join('/')));
		} else if (handle.kind === 'directory') {
			result.push(...await collectStoredFilesFromDirHandle(handle as FileSystemDirectoryHandle, [...pathSegments, name]));
		}
	}
	return result;
}

/** Navigate a root directory handle down to `path`, or null when a segment is missing. */
export async function resolveDirAtPath(root: FileSystemDirectoryHandle | null, path: string[]): Promise<FileSystemDirectoryHandle | null> {
	if (!root) return null;
	let dir: FileSystemDirectoryHandle = root;
	for (const segment of path) {
		let found = false;
		for await (const [name, handle] of (dir as unknown as AsyncIterable<[string, FileSystemHandle]>)) {
			if (handle.kind === 'directory' && name === segment) {
				dir = handle as FileSystemDirectoryHandle; found = true; break;
			}
		}
		if (!found) return null;
	}
	return dir;
}
