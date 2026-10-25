/**
 * folderScan.ts — pure folder-scan helpers for the browse view.
 *
 * Extracted from `Mp3PlayerView.svelte` (PR 3.3 of docs/refactoring-plan.md).
 * Owns the cooperative yield between scan batches, the native SAF batch scan,
 * the browse-path file collection and the native directory picker.
 *
 * Pure by contract: no runes, no stores, no component state, no import from
 * `components/`. Everything the functions need arrives as a parameter.
 * `scanNativeAudioFiles` no longer reads the view's `nativeTreeUri`; it takes
 * the tree URI it should scan. `collectAllFromPath` no longer reads
 * `musicSettings.librarySource`, `musicSettings.sortOrder`, `allFiles`,
 * `libraryScanPromise`, `rootDirHandle` or `nativeTreeUri`; all six arrive in
 * its `deps` object. `yieldScanToUi` and `pickNativeAudioDirectory` already
 * closed over nothing but module imports and globals, so their signatures are
 * unchanged.
 */
import { FilePicker } from '@capawesome/capacitor-file-picker';
import { DirectoryReader, type NativeDirectoryDir, type NativeDirectoryFile } from '$lib/native/directory-reader';
import {
	type StoredAudioFile,
	createStoredAudioFile,
	createStoredNativeAudioFile
} from '$lib/models/music';
import {
	collectStoredFilesFromSnapshot,
	collectFilesFromDirHandle,
	resolveDirAtPath,
	pathToString
} from '$lib/browse/libraryCache';

/** Live progress reported to the batch callback after each non-empty batch. */
export interface ScanBatchState {
	done: boolean;
	foldersScanned: number;
	foldersQueued: number;
	totalFiles: number;
}

/** Options for a native SAF library scan. */
export interface NativeLibraryScanOptions {
	initialBatchSize?: number;
	/** The directory tree a previous completed walk observed, so unchanged subtrees can be skipped. */
	prevDirs?: NativeDirectoryDir[];
}

/** A whole native SAF library walk: every file, plus what the walk skipped or could not read. */
export interface NativeLibraryScanResult {
	files: StoredAudioFile[];
	dirs: NativeDirectoryDir[];
	skippedDirs: number;
	/**
	 * The directories behind `skippedDirs`, as relative paths, without duplicates.
	 * The merge protects exactly these subtrees (D2 amendment); an empty list with a
	 * non-zero `skippedDirs` can only come from an APK that predates the paths.
	 */
	skippedPaths: string[];
	unreadableDirs: number;
}

/** Yield to the event loop so the UI can paint between scan batches. */
export async function yieldScanToUi(): Promise<void> {
	if (typeof window === 'undefined') return;
	await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
}

/**
 * Stream a native SAF audio scan batch by batch, collecting every mapped file
 * and the directory rows the walk observed, and reporting each batch that
 * carries anything to `onBatch`. Passing `prevDirs` lets the native walker skip
 * subtrees whose cached mtime still matches; it reports the paths it skipped and how
 * many directories it could not read. A scan that never completes is cancelled
 * in the `finally`, so an aborted caller cannot leak a running native scan.
 */
export async function scanNativeLibrary(
	nativeTreeUri: string | null,
	path: string[],
	batchSize: number,
	options: NativeLibraryScanOptions = {},
	onBatch?: (batch: StoredAudioFile[], state: ScanBatchState) => Promise<void> | void,
): Promise<NativeLibraryScanResult> {
	const result: NativeLibraryScanResult = { files: [], dirs: [], skippedDirs: 0, skippedPaths: [], unreadableDirs: 0 };
	if (!nativeTreeUri) return result;

	// The native payload repeats every skipped path on each batch (it is cumulative,
	// like the counters), so collect them into a set and hand back the union.
	const skippedPaths = new Set<string>();

	let scanCompleted = false;
	let scanId = '';
	let isFirstBatch = true;

	try {
		const startedScan = await DirectoryReader.startAudioScan({
			treeUri: nativeTreeUri,
			path: pathToString(path),
			prevDirs: options.prevDirs,
		});
		scanId = startedScan.scanId;

		while (!scanCompleted) {
			const effectiveBatchSize = isFirstBatch
				? Math.max(1, options.initialBatchSize ?? batchSize)
				: batchSize;
			const batch = await DirectoryReader.getAudioScanBatch({ scanId, batchSize: effectiveBatchSize });
			isFirstBatch = false;
			const mappedBatch = batch.files.map((file: NativeDirectoryFile) => createStoredNativeAudioFile(file));
			const batchDirs = batch.dirs ?? [];
			result.dirs.push(...batchDirs);
			// The native counters are cumulative over the session, so assign them.
			result.skippedDirs = batch.skippedDirs ?? result.skippedDirs;
			for (const skippedPath of batch.skippedPaths ?? []) {
				skippedPaths.add(skippedPath);
			}
			result.skippedPaths = [...skippedPaths];
			result.unreadableDirs = batch.unreadableDirs ?? result.unreadableDirs;
			if (mappedBatch.length > 0) {
				result.files.push(...mappedBatch);
			}
			// A batch can carry directory rows and no files; skipping the callback
			// there would lose every row of a files-free batch.
			if (mappedBatch.length > 0 || batchDirs.length > 0) {
				await onBatch?.(mappedBatch, {
					done: batch.done,
					foldersScanned: batch.foldersScanned,
					foldersQueued: batch.foldersQueued,
					totalFiles: result.files.length,
				});
			}
			scanCompleted = batch.done;
			if (!scanCompleted) {
				await yieldScanToUi();
			}
		}
	} finally {
		if (scanId && !scanCompleted) {
			try {
				await DirectoryReader.cancelAudioScan({ scanId });
			} catch (error) {
				console.warn('Unable to cancel native audio scan.', error);
			}
		}
	}

	return result;
}

/**
 * The file list only, for callers that do not care about the directory tree.
 * Kept as a thin wrapper so the folder-play path and the index scan keep their
 * existing shape.
 */
export async function scanNativeAudioFiles(
	nativeTreeUri: string | null,
	path: string[],
	batchSize: number,
	options: NativeLibraryScanOptions = {},
	onBatch?: (batch: StoredAudioFile[], state: ScanBatchState) => Promise<void> | void,
): Promise<StoredAudioFile[]> {
	const result = await scanNativeLibrary(nativeTreeUri, path, batchSize, options, onBatch);
	return result.files;
}

/**
 * Pick a directory through the native plugin and report its tree URI and
 * display folder name.
 */
export async function pickNativeAudioDirectory(): Promise<{ treeUri: string; folderName: string }> {
	const result = await FilePicker.pickDirectory();
	const directory = await DirectoryReader.listEntries({ treeUri: result.path });
	return {
		treeUri: result.path,
		folderName: directory.folderName,
	};
}

/** The view state `collectAllFromPath` used to read directly. */
export interface CollectAllDeps {
	librarySource: 'device' | 'drive';
	sortOrder: string;
	allFiles: StoredAudioFile[];
	libraryScanPromise: Promise<StoredAudioFile[]> | null;
	rootDirHandle: FileSystemDirectoryHandle | null;
	nativeTreeUri: string | null;
}

/**
 * Collect every audio file under a browse path from whichever source is active:
 * the in-memory snapshot, an in-flight scan promise, a File System Access root
 * handle or a native SAF tree. The drive branch short-circuits before the rest,
 * exactly as before extraction.
 */
export async function collectAllFromPath(path: string[], deps: CollectAllDeps): Promise<StoredAudioFile[]> {
	if (deps.librarySource === 'drive') {
		return collectStoredFilesFromSnapshot(deps.allFiles, path, deps.sortOrder);
	} else if (deps.allFiles.length > 0) {
		return collectStoredFilesFromSnapshot(deps.allFiles, path, deps.sortOrder);
	} else if (deps.libraryScanPromise) {
		const scannedFiles = await deps.libraryScanPromise;
		return collectStoredFilesFromSnapshot(scannedFiles, path, deps.sortOrder);
	} else if (deps.rootDirHandle) {
		const dir = await resolveDirAtPath(deps.rootDirHandle, path);
		return dir ? (await collectFilesFromDirHandle(dir)).map((file) => createStoredAudioFile(file)) : [];
	} else if (deps.nativeTreeUri) {
		const result = await DirectoryReader.listAudioFiles({ treeUri: deps.nativeTreeUri, path: pathToString(path) });
		return result.files.map((file) => createStoredNativeAudioFile(file));
	}
	return [];
}
