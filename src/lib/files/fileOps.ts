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
 * flow and the local picker listing, and the deck's `browseNavigation` for the
 * post-op reload. Only `openLocalDestinationPicker` runs on a native deck in
 * order to open; on the web it toasts and returns.
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
 *  - `reloadCurrentBrowse`'s exact `loadBrowseEntries(browsePath, 'drive' |
 *    undefined)` arguments and its synchronous call from the runner;
 *  - `folderOpNotice`'s toast text and type.
 */
import { DirectoryReader } from '$lib/native/directory-reader';
import { musicSettings } from '$lib/stores/settings.svelte';
import { addToast } from '$lib/stores/toastStore.svelte';
import type { StoredAudioFile } from '$lib/models/music';
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
}

export interface FileOpsOptions {
	/** The deck's device library (SAF tree URI, folder open, local picker). */
	deviceLibrary: Pick<DeviceLibrary, 'nativeTreeUri' | 'openFolder' | 'loadLocalFolderPicker'>;
	/** The deck's browse navigation, reloaded after a successful op. */
	browseNavigation: Pick<BrowseNavigation, 'loadBrowseEntries'>;
	/** True on Android native, where the SAF destination picker is available. */
	isNativeApp: boolean;
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
			addToast({ message: `${op.op === 'delete' ? 'Delete' : op.op === 'move' ? 'Move' : 'Copy'} failed.`, type: 'error' });
		} finally {
			view.isFileOpRunning = false;
			view.pendingFileOp = null;
		}
	}

	async function deleteFileOp(op: PendingFileOp): Promise<void> {
		if (!opts.deviceLibrary.nativeTreeUri) throw new Error('no tree');
		await DirectoryReader.deleteEntry({ treeUri: opts.deviceLibrary.nativeTreeUri, path: '', name: op.name });
		addToast({ message: `Deleted "${op.name}".`, type: 'info' });
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
		void opts.browseNavigation.loadBrowseEntries(view.browsePath, musicSettings.librarySource === 'drive' ? 'drive' : undefined);
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
