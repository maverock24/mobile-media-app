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
import { DirectoryReader, type NativeDirectoryFile } from '$lib/native/directory-reader';
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

/** Yield to the event loop so the UI can paint between scan batches. */
export async function yieldScanToUi(): Promise<void> {
	if (typeof window === 'undefined') return;
	await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
}

/**
 * Stream a native SAF audio scan batch by batch, collecting every mapped file
 * and reporting each non-empty batch to `onBatch`. A scan that never completes
 * is cancelled in the `finally`, so an aborted caller cannot leak a running
 * native scan.
 */
export async function scanNativeAudioFiles(
	nativeTreeUri: string | null,
	path: string[],
	batchSize: number,
	options: { initialBatchSize?: number } = {},
	onBatch?: (batch: StoredAudioFile[], state: ScanBatchState) => Promise<void> | void,
): Promise<StoredAudioFile[]> {
	if (!nativeTreeUri) return [];

	const collectedFiles: StoredAudioFile[] = [];
	let scanCompleted = false;
	let scanId = '';
	let isFirstBatch = true;

	try {
		const startedScan = await DirectoryReader.startAudioScan({ treeUri: nativeTreeUri, path: pathToString(path) });
		scanId = startedScan.scanId;

		while (!scanCompleted) {
			const effectiveBatchSize = isFirstBatch
				? Math.max(1, options.initialBatchSize ?? batchSize)
				: batchSize;
			const batch = await DirectoryReader.getAudioScanBatch({ scanId, batchSize: effectiveBatchSize });
			isFirstBatch = false;
			const mappedBatch = batch.files.map((file: NativeDirectoryFile) => createStoredNativeAudioFile(file));
			if (mappedBatch.length > 0) {
				collectedFiles.push(...mappedBatch);
				await onBatch?.(mappedBatch, {
					done: batch.done,
					foldersScanned: batch.foldersScanned,
					foldersQueued: batch.foldersQueued,
					totalFiles: collectedFiles.length,
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

	return collectedFiles;
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
