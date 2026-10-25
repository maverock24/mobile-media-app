/**
 * libraryDelta.ts — the pure delta merge for the device library index.
 *
 * The one piece of correctness risk in the library-delta effort: deciding which
 * cached files survive a walk that only visited part of the tree. Extracted into
 * a pure module so the prune policy can be tested without a device, a component
 * or the bridge.
 *
 * It also owns {@link decideScanMode}, the pure decision between a delta walk and
 * a full walk (D1, D3). `deviceLibrary.svelte.ts` is the only caller of both.
 *
 * Pure by contract, like `libraryCache.ts`: no runes, no stores, no component
 * state, no IndexedDB. Every input arrives as a parameter and the result is a new
 * value; no input array or object is mutated.
 *
 * Identity is `getStoredFileKey` (`src/lib/models/music.ts:114-117`), i.e.
 * `relativePath` for native and web files. A rename is therefore one removal plus
 * one addition, not an update (D1, out of scope in `tree.md`). The change
 * fingerprint is the (mtime, size) pair of D5, both already on `StoredAudioFile`.
 */

import { hasUsableDirectoryTree } from '$lib/browse/libraryCache';
import { getStoredFileKey, type CachedLibrary, type StoredAudioFile } from '$lib/models/music';

/**
 * One row of the persisted directory tree (D6): the directory's path relative to
 * the tree root, and the mtime the walk trusted when it skipped it.
 *
 * Declared here because this phase owns no cache type; P2 moves the same shape
 * into `CachedLibrary.dirs`, and the two must stay structurally identical.
 */
export interface LibraryDeltaDirRow {
	path: string;
	mtime: number;
}

/** Everything the merge needs to know about one walk. */
export interface MergeLibraryDeltaInput {
	/** The cached file list: what the previous completed walk left in the index. */
	previous: readonly StoredAudioFile[];
	/** The files this walk observed. Never a full tree unless the walk was full. */
	walked: readonly StoredAudioFile[];
	/** The directory rows this walk observed. */
	dirs: readonly LibraryDeltaDirRow[];
	/** The previous tree, so a skipped directory keeps its row (D4 amendment). */
	previousDirs?: readonly LibraryDeltaDirRow[];
	/** Directories the walk did not descend into. Their subtrees are unverified. */
	skippedDirs: readonly string[];
	/** Directories the walk tried and could not read (D2). */
	unreadableDirs: number;
	/** Whether the walk ran to the end. Anything else may not prune (D3). */
	completed: boolean;
}

/** The merged index: observed files first, then what the walk could not verify. */
export interface MergeLibraryDeltaResult {
	files: StoredAudioFile[];
	dirs: LibraryDeltaDirRow[];
}

/**
 * D3: the size cap on a tree this app is willing to hand back to the native
 * walker, measured as `JSON.stringify(dirs).length`. A tree over the cap still
 * describes a library worth walking in full; it is just not worth shipping
 * across the bridge on every start.
 */
export const DELTA_TREE_MAX_BYTES = 2 * 1024 * 1024;

/**
 * D1: the verification window. A cached walk older than this gets one full walk
 * instead of a delta, because a directory mtime is only optionally maintained by
 * the provider and the skips have to be re-proved eventually.
 */
export const FULL_WALK_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Which walk the index asks the native side to run. */
export type LibraryScanMode = 'full' | 'delta';

/** Everything `decideScanMode` needs: the cache, a clock, and the tree's size. */
export interface DecideScanModeInput {
	/** The payload restored from IndexedDB, or null on a cold start. */
	cached: CachedLibrary | null | undefined;
	/** The clock, passed in so the decision stays pure. */
	now: number;
	/** `JSON.stringify(cached.dirs).length`, measured once by the caller. */
	encodedTreeBytes: number;
}

/**
 * Choose between a delta walk and a full walk (D1, D3).
 *
 * A delta is allowed only when every safety condition holds: the payload has a
 * usable directory tree, that tree fits under {@link DELTA_TREE_MAX_BYTES}, its
 * completed walk is stamped, and that stamp is inside
 * {@link FULL_WALK_MAX_AGE_MS}. Every other case — a cold cache, a legacy
 * payload, an over-cap tree, a missing stamp, a stale walk — walks in full.
 */
export function decideScanMode({ cached, now, encodedTreeBytes }: DecideScanModeInput): LibraryScanMode {
	if (!cached || !hasUsableDirectoryTree(cached)) return 'full';
	if (encodedTreeBytes > DELTA_TREE_MAX_BYTES) return 'full';
	const completedAt = cached.completedAt;
	if (typeof completedAt !== 'number') return 'full';
	if (now - completedAt > FULL_WALK_MAX_AGE_MS) return 'full';
	return 'delta';
}

/** The (mtime, size) fingerprint of D5. */
interface FileFingerprint {
	modifiedAt: number | undefined;
	sizeBytes: number | undefined;
}

/**
 * Read a file's fingerprint. Native and Drive entries carry the fields directly;
 * a web entry's `File` already knows both, so its live handle stands in for them.
 */
function fingerprintOf(file: StoredAudioFile): FileFingerprint {
	if (file.source === 'web') {
		return { modifiedAt: file.file.lastModified, sizeBytes: file.file.size };
	}

	return { modifiedAt: file.modifiedAt, sizeBytes: file.sizeBytes };
}

/** D5: a file is unchanged only when both halves of the fingerprint match. */
function isUnchanged(previous: StoredAudioFile, walked: StoredAudioFile): boolean {
	const before = fingerprintOf(previous);
	const after = fingerprintOf(walked);
	return before.modifiedAt === after.modifiedAt && before.sizeBytes === after.sizeBytes;
}

/**
 * True when `path` is `dir` or lives inside it, comparing whole `/`-delimited
 * segments: `Alpha2/x.mp3` is not under `Alpha`. An empty or `.` directory is the
 * tree root, which contains everything, so a walk that reports it skipped protects
 * the whole library rather than pruning it.
 */
function isUnderOrEqual(path: string, dir: string): boolean {
	const base = dir.replace(/\/+$/, '');
	if (base === '' || base === '.') return true;
	return path === base || path.startsWith(`${base}/`);
}

/** True when `path` is unverified because the walk skipped the directory above it. */
function isUnderSkippedDir(path: string, skippedDirs: readonly string[]): boolean {
	return skippedDirs.some((dir) => isUnderOrEqual(path, dir));
}

/**
 * Union the observed directory rows with the previous rows of every subtree the
 * walk skipped: a skipped directory keeps its mtime, so the next delta can skip it
 * again instead of descending it. A re-observed row always wins over the old one.
 */
function mergeDirRows(
	dirs: readonly LibraryDeltaDirRow[],
	previousDirs: readonly LibraryDeltaDirRow[],
	skippedDirs: readonly string[]
): LibraryDeltaDirRow[] {
	const observed = new Set(dirs.map((row) => row.path));
	const merged: LibraryDeltaDirRow[] = [...dirs];

	for (const row of previousDirs) {
		if (observed.has(row.path)) continue;
		if (!isUnderSkippedDir(row.path, skippedDirs)) continue;
		merged.push(row);
	}

	return merged;
}

/**
 * Merge one walk into the previous index.
 *
 * - A walked file whose fingerprint matches the previous entry keeps the previous
 *   object; every other walked file replaces it.
 * - A previous file the walk did not observe is pruned only when the walk completed
 *   with no unreadable directory and the file is not inside a skipped subtree.
 *   Otherwise it is carried over unchanged.
 * - Files observed first, then carried-over files, both in their input order.
 *
 * There is deliberately no "the result has the same length as before" shortcut:
 * one addition plus one removal is a change (D9).
 */
export function mergeLibraryDelta(input: MergeLibraryDeltaInput): MergeLibraryDeltaResult {
	const { previous, walked, dirs, previousDirs = [], skippedDirs, unreadableDirs, completed } = input;

	const previousByKey = new Map<string, StoredAudioFile>();
	for (const file of previous) {
		previousByKey.set(getStoredFileKey(file), file);
	}

	const walkedKeys = new Set<string>();
	const files: StoredAudioFile[] = [];
	for (const file of walked) {
		const key = getStoredFileKey(file);
		walkedKeys.add(key);
		const previousFile = previousByKey.get(key);
		files.push(previousFile && isUnchanged(previousFile, file) ? previousFile : file);
	}

	const mayPrune = completed && unreadableDirs === 0;
	for (const file of previous) {
		if (walkedKeys.has(getStoredFileKey(file))) continue;
		if (mayPrune && !isUnderSkippedDir(file.relativePath, skippedDirs)) continue;
		files.push(file);
	}

	return { files, dirs: mergeDirRows(dirs, previousDirs, skippedDirs) };
}
