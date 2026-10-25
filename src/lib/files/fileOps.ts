/**
 * fileOps.ts — one deck's move / copy / delete file operations.
 *
 * Extracted from `Mp3PlayerView.svelte` (PR 3.8 of docs/refactoring-plan.md),
 * the last group in the PR 3 series. It owns the destination-picker entry
 * points, the confirm-and-delete toast, the pending-op runner, the three SAF
 * operations themselves, the folder-op placeholder notice and the browse
 * reload the runner performs after a successful op.
 *
 * Seam: `createFileOps` is a factory, not a module singleton. Two decks mount
 * at once (the `deck` prop), so a shared instance would let deck A's pending op
 * answer for deck B. It is a plain `.ts` and holds no runes: a plain `.ts`
 * cannot hold `$state`, and the state these functions drive (`pendingFileOp`
 * and `isFileOpRunning`) is read reactively by the Android local-picker markup
 * (`Mp3PlayerView.svelte`, the `showLocalFolderPicker` block), so it stays in
 * the view and arrives through the injected `view` accessor. That is the same
 * shape `driveLibrary.ts` uses for `isFileOpRunning`, and it keeps the PR 3.5
 * and PR 3.6 seams pointed at the view instead of churning them.
 *
 * It reaches the deck's `deviceLibrary` for the SAF tree URI, the folder open
 * flow and the local picker listing, the deck's `browseNavigation` for the
 * post-op reload, and the deck's library index (`view.allFiles`) to drop a
 * successfully deleted file out of it. Only `openLocalDestinationPicker` runs
 * on a native deck in order to open; on the web it toasts and returns.
 *
 * Behaviour preserved from the view:
 *  - the `pendingFileOp` lifecycle: set by the handler / confirm, read by the
 *    runner, cleared in the runner's `finally`;
 *  - the confirm toast and its Delete action ordering relative to the op;
 *  - `openLocalDestinationPicker`'s non-native early return with its warning
 *    toast, and its native open-then-list order;
 *  - the two error paths that toast (`openLocalDestinationPicker`'s "No local
 *    folder selected." and `runPendingFileOp`'s per-op failure toast);
 *  - the three handlers setting `pendingFileOp` before the destination picker
 *    opens (via `openDestinationForOp` / `confirmAndDelete`);
 *  - `reloadCurrentBrowse`'s synchronous call from the runner. Its second
 *    argument is deliberately not preserved: the view passed the literal
 *    `'drive'` there, which `loadBrowseEntries` reads as a search query, so
 *    every op in Drive mode replaced the listing with files matching "drive".
 *    It now re-runs the deck's live `driveSearch` instead;
 *  - `folderOpNotice`'s toast text and type.
 *
 * A delete also prunes the deck's library index. The browse list is rebuilt
 * from it (`browseNavigation.loadBrowseEntries`), so a reload that ran against
 * an unpruned index put the deleted row straight back and the row never
 * disappeared. See `forgetDeletedFile` for what each source does about its
 * cache.
 */
import { DirectoryReader } from '$lib/native/directory-reader';
import { musicSettings } from '$lib/stores/settings.svelte';
import { addToast } from '$lib/stores/toastStore.svelte';
import { LAST_LIBRARY_CACHE_KEY, getDeviceLibraryCacheKey, loadDeviceCachedLibrary, saveCachedLibrary } from '$lib/browse/libraryCache';
import { deleteCachedLibrary } from '$lib/utils/idb';
import { getStoredFileKey, type StoredAudioFile } from '$lib/models/music';
import type { DeviceLibrary } from '$lib/device/deviceLibrary.svelte';
import type { BrowseNavigation } from '$lib/browse/browseNavigation.svelte';

/** A file row's identity, as the browse template hands it to a handler. */
export type OpTarget = {
	name: string;
	isDrive: boolean;
	fileId: string | null;
	source: StoredAudioFile | null;
};

/** A move / copy / delete waiting on a destination or a confirm. */
export type PendingFileOp = {
	op: 'move' | 'copy' | 'delete';
	name: string;
	isDrive: boolean;
	fileId: string | null;
	source: StoredAudioFile | null; // set for file ops
};

/**
 * The view-owned state the file ops read and write. Every field is the deck's
 * reactive state; the deck passes an accessor for each so this rune-free module
 * can read and replace it without owning it.
 */
export interface FileOpsView {
	pendingFileOp: PendingFileOp | null;
	isFileOpRunning: boolean;
	showLocalFolderPicker: boolean;
	readonly browsePath: string[];
	/** The deck's Drive search box; the post-op reload re-runs it. */
	readonly driveSearch: string;
	/** The deck's library index; a delete drops the file out of it. */
	allFiles: StoredAudioFile[];
}

export interface FileOpsOptions {
	/** The deck's device library (SAF tree URI, folder open, local picker). */
	deviceLibrary: Pick<DeviceLibrary, 'nativeTreeUri' | 'openFolder' | 'loadLocalFolderPicker'>;
	/** The deck's browse navigation, reloaded after a successful op. */
	browseNavigation: Pick<BrowseNavigation, 'loadBrowseEntries'>;
	/** True on Android native, where the SAF destination picker is available. */
	isNativeApp: boolean;
	/** Deletes a Drive file through the Drive API. Required for Drive rows. */
	deleteDriveFile?: (source: StoredAudioFile) => Promise<void>;
	/** The view-owned state the module reads and writes. */
	view: FileOpsView;
}

/** Per-deck file operations and the destination pickers that drive them. */
export interface FileOps {
	openDestinationForOp(op: 'move' | 'copy', target: OpTarget): void;
	openLocalDestinationPicker(): Promise<void>;
	confirmAndDelete(target: OpTarget): void;
	runPendingFileOp(destination: { localPath?: string } | null): Promise<void>;
	deleteFileOp(op: PendingFileOp): Promise<void>;
	moveOrCopyFileOp(op: PendingFileOp, destination: { localPath?: string }): Promise<void>;
	handleMoveEntry(target: OpTarget): void;
	handleCopyEntry(target: OpTarget): void;
	handleDeleteEntry(target: OpTarget): void;
	folderOpNotice(op: string): void;
	reloadCurrentBrowse(): Promise<void>;
}

export function createFileOps(opts: FileOpsOptions): FileOps {
	const { view } = opts;

	function openDestinationForOp(op: 'move' | 'copy', target: OpTarget): void {
		view.pendingFileOp = { op, name: target.name, isDrive: target.isDrive, fileId: target.fileId, source: target.source };
		void openLocalDestinationPicker();
	}

	async function openLocalDestinationPicker(): Promise<void> {
		if (!opts.isNativeApp) {
			addToast({ message: 'Local destination requires the Android app.', type: 'warning' });
			return;
		}
		if (!opts.deviceLibrary.nativeTreeUri) {
			await opts.deviceLibrary.openFolder();
		}
		if (!opts.deviceLibrary.nativeTreeUri) { addToast({ message: 'No local folder selected.', type: 'warning' }); return; }
		view.showLocalFolderPicker = true;
		await opts.deviceLibrary.loadLocalFolderPicker('');
	}

	function confirmAndDelete(target: OpTarget): void {
		view.pendingFileOp = { op: 'delete', name: target.name, isDrive: target.isDrive, fileId: target.fileId, source: target.source };
		addToast({
			message: `Delete ${target.name}?`,
			type: 'warning',
			autoDismissMs: 0,
			action: { label: 'Delete', handler: () => { void runPendingFileOp(null); } },
		});
	}

	async function runPendingFileOp(destination: { localPath?: string } | null): Promise<void> {
		const op = view.pendingFileOp;
		if (!op || view.isFileOpRunning) return;
		view.isFileOpRunning = true;
		try {
			if (op.op === 'delete') {
				await deleteFileOp(op);
			} else if (destination) {
				await moveOrCopyFileOp(op, destination);
			}
			// Refresh the current folder so the list reflects the change.
			await reloadCurrentBrowse();
		} catch (e) {
			const reason = e instanceof Error ? e.message : String(e);
			addToast({ message: `${op.op === 'delete' ? 'Delete' : op.op === 'move' ? 'Move' : 'Copy'} failed: ${reason}`, type: 'error' });
		} finally {
			view.isFileOpRunning = false;
			view.pendingFileOp = null;
		}
	}

	async function deleteFileOp(op: PendingFileOp): Promise<void> {
		// A Drive row must never reach the local SAF tree. The old code called the
		// local delete with the Drive file's name at the tree root, so it either
		// failed or deleted a same-named local file.
		if (op.isDrive) {
			const source = op.source;
			if (!source || source.source !== 'drive') throw new Error('Missing Google Drive file.');
			if (!opts.deleteDriveFile) throw new Error('Google Drive delete is not available.');
			await opts.deleteDriveFile(source);
			await forgetDeletedFile(source);
			addToast({ message: `Deleted "${op.name}" from Google Drive.`, type: 'info' });
			return;
		}
		if (!opts.deviceLibrary.nativeTreeUri) throw new Error('no tree');
		// `path: ''` resolved the tree root, so a file in a subfolder was never
		// found. Resolve the file's own directory from its relative path.
		const relativePath = op.source?.relativePath ?? '';
		const slash = relativePath.lastIndexOf('/');
		const path = slash >= 0 ? relativePath.slice(0, slash) : '';
		await DirectoryReader.deleteEntry({
			treeUri: opts.deviceLibrary.nativeTreeUri,
			path,
			name: op.name,
		});
		if (op.source) await forgetDeletedFile(op.source);
		addToast({ message: `Deleted "${op.name}".`, type: 'info' });
	}

	/**
	 * Take a deleted file out of the deck's library index, then out of the cache
	 * that index is restored from. The browse list is built from `allFiles`, so
	 * without the first step the reload after the op restores the deleted row.
	 *
	 * Drive needs no cache step: a cached Drive listing expires on its own
	 * (`DRIVE_CACHE_TTL`) and a cached restore re-streams the folder in the
	 * background, replacing the list. The device cache is restored as-is, so it
	 * has to be rewritten here or the file returns on the next launch.
	 *
	 * The rewrite carries the loaded payload's directory tree forward: a delete
	 * walks nothing, so rebuilding the payload from the file list alone would drop
	 * `dirs` and force the next start into a full walk.
	 */
	async function forgetDeletedFile(source: StoredAudioFile): Promise<void> {
		const key = getStoredFileKey(source);
		const remaining = view.allFiles.filter((file) => getStoredFileKey(file) !== key);
		if (remaining.length === view.allFiles.length) return; // not in the index
		view.allFiles = remaining;
		if (source.source === 'drive') return;

		const treeUri = opts.deviceLibrary.nativeTreeUri;
		const folderName = musicSettings.lastFolderName || 'Library';
		if (remaining.length > 0) {
			const cached = await loadDeviceCachedLibrary(treeUri, folderName);
			await saveCachedLibrary(treeUri, folderName, remaining, undefined, cached?.dirs ?? []);
			return;
		}
		// `saveCachedLibrary` no-ops on an empty list, which would leave the old
		// cache in place, so drop the keys instead.
		const cacheKey = getDeviceLibraryCacheKey({ treeUri, folderName });
		await deleteCachedLibrary(cacheKey);
		if (cacheKey !== LAST_LIBRARY_CACHE_KEY) await deleteCachedLibrary(LAST_LIBRARY_CACHE_KEY);
	}

	async function moveOrCopyFileOp(op: PendingFileOp, destination: { localPath?: string }): Promise<void> {
		if (!opts.deviceLibrary.nativeTreeUri) throw new Error('no tree');
		const destPath = destination.localPath ?? '';
		if (op.op === 'copy') {
			await DirectoryReader.copyEntry({ srcTreeUri: opts.deviceLibrary.nativeTreeUri, srcPath: '', srcName: op.name, destTreeUri: opts.deviceLibrary.nativeTreeUri, destPath, destName: op.name });
		} else {
			await DirectoryReader.moveEntry({ srcTreeUri: opts.deviceLibrary.nativeTreeUri, srcPath: '', srcName: op.name, destTreeUri: opts.deviceLibrary.nativeTreeUri, destPath, destName: op.name });
		}
		addToast({ message: `${op.op === 'copy' ? 'Copied' : 'Moved'} "${op.name}".`, type: 'info' });
	}

	function handleMoveEntry(target: OpTarget): void { openDestinationForOp('move', target); }
	function handleCopyEntry(target: OpTarget): void { openDestinationForOp('copy', target); }
	function handleDeleteEntry(target: OpTarget): void { confirmAndDelete(target); }

	/** Folder ops operate on virtual path-derived folders — follow-up ticket. */
	function folderOpNotice(op: string): void {
		addToast({ message: `${op} on folders is not wired yet.`, type: 'info' });
	}

	async function reloadCurrentBrowse(): Promise<void> {
		// The second argument is the Drive *search query*, not a source flag. The
		// old `librarySource === 'drive' ? 'drive' : undefined` therefore put the
		// browse into search mode filtering for the word "drive" after every op.
		// Re-run the deck's live query instead, so a Drive user stays where they
		// were and a local user gets the plain listing.
		void opts.browseNavigation.loadBrowseEntries(
			view.browsePath,
			musicSettings.librarySource === 'drive' ? view.driveSearch.trim().toLowerCase() : undefined
		);
	}

	return {
		openDestinationForOp,
		openLocalDestinationPicker,
		confirmAndDelete,
		runPendingFileOp,
		deleteFileOp,
		moveOrCopyFileOp,
		handleMoveEntry,
		handleCopyEntry,
		handleDeleteEntry,
		folderOpNotice,
		reloadCurrentBrowse
	};
}
