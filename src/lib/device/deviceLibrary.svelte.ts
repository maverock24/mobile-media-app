/**
 * deviceLibrary.svelte.ts — one deck's device (local / SAF) library.
 *
 * Extracted from `Mp3PlayerView.svelte` (PR 3.6 of docs/refactoring-plan.md).
 * Owns the device source activation, the folder open / restore / reconnect
 * entry points, the background library index scan, the rescan entry point, the
 * Android local-folder picker and the Drive -> device download paths.
 *
 * Seam: `createDeviceLibrary` is a factory, not a module singleton. Two decks
 * mount at once (the `deck` prop), so a shared instance would let deck A's scan
 * or picker answer for deck B. The module holds the per-deck state that used to
 * be view-local and is driven only by these functions — `libraryScanPromise`,
 * `rootDirHandle`, `nativeTreeUri`, `pendingHandle`, `scanProgress`,
 * `trackListLockedByUser`, `deckFolderLabel`, and the Android local-picker
 * fields (`localPickerPath`, `localPickerEntries`, `localPickerLoading`). State
 * shared with other modules stays in the view and arrives through the injected
 * `view` accessor: the deck file list (`allFiles`) and `browsePath` (browse view
 * owns them and reads them directly), `showQueue`, the open-folder spinner
 * (`isLoading`), the Drive-filter write target (`driveSearch`), and the transfer
 * state that 3.5 (Drive upload) and 3.8 (file ops) also drive
 * (`transferFile`, `transferDirection`, `isTransferring`, `transferProgress`,
 * `transferPhase`, `showLocalFolderPicker`, `isFileOpRunning`, `pendingFileOp`).
 *
 * The two hidden file inputs are `bind:this` refs in the view, so they arrive as
 * getters and the module clicks them without moving any markup.
 *
 * Behaviour preserved from the view:
 *  - the blocking `alert()` calls and their order relative to the `isLoading`
 *    writes and the `try`/`finally`;
 *  - every `saveCachedLibrary` call site and the nulled tree URI they pass;
 *  - `startLibraryScan`'s `trackListLockedByUser` guard and its progress writes;
 *  - `rescanCurrentLibraryIndex` deleting the cache key before rescanning;
 *  - `reconnectFolder`'s `requestPermission` flow;
 *  - the native picker flows through `FilePicker` / `DirectoryReader`;
 *  - `downloadToLocalFolder`'s transfer phases.
 */
import { Capacitor } from '@capacitor/core';
import { DirectoryReader, type NativeDirectoryFile, type NativeDirectoryFolder } from '$lib/native/directory-reader';
import { pickNativeAudioDirectory, scanNativeAudioFiles } from '$lib/browse/folderScan';
import {
	LAST_LIBRARY_CACHE_KEY,
	collectStoredFilesFromDirHandle,
	getDeviceLibraryCacheKey,
	loadDeviceCachedLibrary,
	restoreStoredFilesFromCache,
	saveCachedLibrary
} from '$lib/browse/libraryCache';
import { createStoredAudioFile, isSupportedAudioFile, type StoredAudioFile } from '$lib/models/music';
import { deleteCachedLibrary, loadHandleFromIDB, saveHandleToIDB } from '$lib/utils/idb';
import { downloadGoogleDriveFile } from '$lib/google-drive';
import { musicSettings } from '$lib/stores/settings.svelte';
import { addToast } from '$lib/stores/toastStore.svelte';
import type { DriveSession } from '$lib/drive/driveSession.svelte';

/** Batch size for the background full-library SAF scan. */
const BACKGROUND_LIBRARY_SCAN_BATCH_SIZE = 500;

/**
 * The view-owned state the device library reads and writes. Every field is the
 * deck's reactive state; the deck passes an accessor for each so the module can
 * read and replace it without owning it.
 */
export interface DeviceLibraryView {
	// Deck file list + navigation; the browse view owns and reads these directly.
	allFiles: StoredAudioFile[];
	browsePath: string[];
	showQueue: boolean;
	// Open-folder spinner, shared with the view's playCurrentFolder.
	isLoading: boolean;
	// Drive-filter write target; the browse-search effect reads it.
	driveSearch: string;
	// Transfer state shared with 3.5 (Drive upload) and 3.8 (file ops).
	transferFile: StoredAudioFile | null;
	transferDirection: 'upload' | 'download';
	isTransferring: boolean;
	transferProgress: { loaded: number; total: number } | null;
	transferPhase: 'downloading' | 'saving';
	showLocalFolderPicker: boolean;
	readonly isFileOpRunning: boolean;
	readonly pendingFileOp: { op: string } | null;
}

export interface DeviceLibraryOptions {
	/** The deck's Drive session (token), used by the download paths. */
	driveSession: DriveSession;
	/** The view-owned state the module reads and writes. */
	view: DeviceLibraryView;
	/** True on Android native, where the SAF tree URI and picker are used. */
	isNativeApp: boolean;
	/** Reads the hidden `<input webkitdirectory>` ref the native fallback clicks. */
	getFolderInputEl(): HTMLInputElement | undefined;
	/** Reads the hidden `<input type="file">` ref the native fallback clicks. */
	getNativeFileInputEl(): HTMLInputElement | undefined;
	/** The `browseVersion` sink — forces the browse view to reload. */
	bumpBrowseVersion(): void;
	/** The view's queue loader, called after a scan or cache restore. */
	hydrateTracksFromLibrary(files: StoredAudioFile[], resetToStart?: boolean): void;
	/** The view's pending move/copy runner, reached by the local picker. */
	runPendingFileOp(destination: { localPath?: string } | null): Promise<void>;
	/** The Drive library's forced refresh, reached by rescanCurrentLibraryIndex. */
	refreshDriveLibrary(): Promise<void>;
}

/** Per-deck device-library state and the functions that drive it. */
export interface DeviceLibrary {
	rootDirHandle: FileSystemDirectoryHandle | null;
	nativeTreeUri: string | null;
	pendingHandle: FileSystemDirectoryHandle | null;
	libraryScanPromise: Promise<StoredAudioFile[]> | null;
	scanProgress: { pct: number; filesFound: number } | null;
	trackListLockedByUser: boolean;
	deckFolderLabel: string;
	localPickerPath: string[];
	localPickerEntries: Array<NativeDirectoryFolder | NativeDirectoryFile>;
	localPickerLoading: boolean;

	activateDeviceLibrary(folderName: string): void;
	startLibraryScan(folderName: string, options?: { resetExistingFiles?: boolean }): void;
	rescanCurrentLibraryIndex(): Promise<void>;
	openLocalSourceButton(): Promise<void>;
	restoreLocalLibrary(): Promise<boolean>;
	openFolder(): Promise<void>;
	handleFolderInput(e: Event): void;
	handleNativeFileInput(e: Event): void;
	reconnectFolder(): Promise<void>;
	loadLocalFolderPicker(path: string): Promise<void>;
	navigateLocalPickerInto(folder: NativeDirectoryFolder): void;
	selectLocalFolderAndDownload(): Promise<void>;
	downloadToLocalFolder(file: StoredAudioFile): Promise<void>;
	openLocalDownloadFolderPicker(file: StoredAudioFile): Promise<void>;
}

export function createDeviceLibrary(opts: DeviceLibraryOptions): DeviceLibrary {
	const { view } = opts;

	// `libraryScanPromise` and `trackListLockedByUser` were plain `let`s in the
	// view (not `$state`), so they stay non-reactive here: nothing reads them in a
	// reactive context, and making them signals would add dependencies the view
	// did not have.
	let libraryScanPromise: Promise<StoredAudioFile[]> | null = null;
	let trackListLockedByUser = false;

	const s = $state({
		rootDirHandle: null as FileSystemDirectoryHandle | null,
		nativeTreeUri: null as string | null,
		pendingHandle: null as FileSystemDirectoryHandle | null,
		scanProgress: null as { pct: number; filesFound: number } | null,
		deckFolderLabel: 'Library',
		localPickerPath: [] as string[],
		localPickerEntries: [] as Array<NativeDirectoryFolder | NativeDirectoryFile>,
		localPickerLoading: false
	});

	function activateDeviceLibrary(folderName: string): void {
		musicSettings.librarySource = 'device';
		musicSettings.lastFolderName = folderName;
		s.deckFolderLabel = folderName;
		view.driveSearch = '';
	}

	function startLibraryScan(folderName: string, options: { resetExistingFiles?: boolean } = {}): void {
		if (options.resetExistingFiles) {
			view.allFiles = [];
			opts.bumpBrowseVersion();
		}
		s.scanProgress = { pct: 0, filesFound: 0 };
		let scanPromise: Promise<StoredAudioFile[]> | null = null;
		scanPromise = (async (): Promise<StoredAudioFile[]> => {
			if (s.rootDirHandle) {
				// Web File System API — no batch progress available; scan runs to completion
				const result = await collectStoredFilesFromDirHandle(s.rootDirHandle);
				return result;
			}

			if (s.nativeTreeUri) {
				return scanNativeAudioFiles(s.nativeTreeUri, [], BACKGROUND_LIBRARY_SCAN_BATCH_SIZE, {}, async (mappedBatch: StoredAudioFile[], state) => {
					if (scanPromise && libraryScanPromise === scanPromise) {
						view.allFiles = [...view.allFiles, ...mappedBatch];
						opts.bumpBrowseVersion();
						const total = state.foldersScanned + state.foldersQueued;
						const pct = total > 0 ? Math.min(99, Math.round((state.foldersScanned / total) * 100)) : 1;
						s.scanProgress = { pct, filesFound: view.allFiles.length };
					}
				});
			}

			return view.allFiles;
		})();

		libraryScanPromise = scanPromise;
		void scanPromise
			.then(async (scannedFiles) => {
				if (libraryScanPromise !== scanPromise) return;
				view.allFiles = scannedFiles;
				s.scanProgress = null;
				if (!trackListLockedByUser) opts.hydrateTracksFromLibrary(scannedFiles);
				await saveCachedLibrary(s.nativeTreeUri, folderName, scannedFiles);
			})
			.catch((error) => {
				console.error('Failed to scan selected library.', error);
			})
			.finally(() => {
				if (libraryScanPromise === scanPromise) {
					libraryScanPromise = null;
					s.scanProgress = null;
				}
			});
	}

	async function rescanCurrentLibraryIndex(): Promise<void> {
		if (musicSettings.librarySource === 'drive') {
			await opts.refreshDriveLibrary();
			return;
		}

		const folderName = musicSettings.lastFolderName || 'Library';
		const cacheKey = getDeviceLibraryCacheKey({ treeUri: s.nativeTreeUri, folderName });
		await deleteCachedLibrary(cacheKey);
		if (cacheKey !== LAST_LIBRARY_CACHE_KEY) {
			await deleteCachedLibrary(LAST_LIBRARY_CACHE_KEY);
		}

		if (s.nativeTreeUri || s.rootDirHandle) {
			startLibraryScan(folderName, { resetExistingFiles: true });
		}
	}

	// Local source: restore the last local folder when one is available, otherwise
	// ask the user to pick a folder. "Change folder" now lives in Settings.
	async function openLocalSourceButton(): Promise<void> {
		const restorable = s.rootDirHandle !== null || s.pendingHandle !== null
			|| Boolean(musicSettings.nativeTreeUri) || Boolean(musicSettings.lastFolderName);
		if (restorable && await restoreLocalLibrary()) {
			return;
		}
		await openFolder();
	}

	async function restoreLocalLibrary(): Promise<boolean> {
		const folderName = musicSettings.lastFolderName;
		if (!musicSettings.nativeTreeUri && !folderName && !s.rootDirHandle && !s.pendingHandle) {
			return false;
		}

		try {
			// Android (SAF): the tree permission is remembered, so a re-pick is unnecessary.
			if (opts.isNativeApp && musicSettings.nativeTreeUri) {
				s.nativeTreeUri = musicSettings.nativeTreeUri;
				s.rootDirHandle = null;
				s.pendingHandle = null;
				view.allFiles = [];
				view.browsePath = [];
				activateDeviceLibrary(folderName || 'Library');
				view.showQueue = true;
				opts.bumpBrowseVersion();
				const cachedLibrary = await loadDeviceCachedLibrary(musicSettings.nativeTreeUri, folderName || 'Library');
				if (cachedLibrary && cachedLibrary.files.length > 0) {
					view.allFiles = restoreStoredFilesFromCache(cachedLibrary);
					opts.hydrateTracksFromLibrary(view.allFiles);
					opts.bumpBrowseVersion();
				} else {
					startLibraryScan(folderName || 'Library', { resetExistingFiles: true });
				}
				return true;
			}

			// Desktop/web: restore from a persisted directory handle + cache.
			if (s.rootDirHandle) {
				view.allFiles = [];
				view.browsePath = [];
				activateDeviceLibrary(s.rootDirHandle.name);
				view.showQueue = true;
				opts.bumpBrowseVersion();
				return true;
			}
			const [handle, cachedLibrary] = await Promise.all([
				loadHandleFromIDB(),
				loadDeviceCachedLibrary(null, musicSettings.lastFolderName),
			]);
			if (handle) {
				const perm = await (handle as unknown as { queryPermission(o: object): Promise<string> }).queryPermission({ mode: 'read' });
				if (perm === 'granted') {
					s.rootDirHandle = handle;
					s.nativeTreeUri = null;
					view.allFiles = [];
					view.browsePath = [];
					activateDeviceLibrary(handle.name);
					view.showQueue = true;
					opts.bumpBrowseVersion();
					return true;
				}
			}
			if (cachedLibrary && cachedLibrary.files.length > 0) {
				view.allFiles = restoreStoredFilesFromCache(cachedLibrary);
				activateDeviceLibrary(cachedLibrary.folderName);
				opts.hydrateTracksFromLibrary(view.allFiles);
				view.showQueue = true;
				opts.bumpBrowseVersion();
				return true;
			}
		} catch {
			// Fall through — the caller will show the plain folder chooser.
		}
		return false;
	}

	// ─────────────────────────────────────────────────────────────
	// Folder picker
	// ─────────────────────────────────────────────────────────────
	async function openFolder(): Promise<void> {
		if (opts.isNativeApp) {
			const canUseNativePlugin = Capacitor.isPluginAvailable('FilePicker');
			view.isLoading = true;

			try {
				const { treeUri, folderName } = canUseNativePlugin
					? await pickNativeAudioDirectory()
					: { treeUri: '', folderName: 'Selected Folder' };
				if (!treeUri) {
					if (!canUseNativePlugin) {
						opts.getNativeFileInputEl()?.click();
						return;
					}

					alert('No MP3 files were found in the selected folder.');
					return;
				}
				s.rootDirHandle = null;
				s.nativeTreeUri = treeUri;
				musicSettings.nativeTreeUri = treeUri;
				s.pendingHandle = null;
				view.allFiles = [];
				activateDeviceLibrary(folderName);
				view.browsePath = [];
				opts.bumpBrowseVersion();
				view.showQueue = true;
				const cachedLibrary = await loadDeviceCachedLibrary(treeUri, folderName);
				try {
					await DirectoryReader.rememberTreeUri({ treeUri });
				} catch (error) {
					console.warn('Unable to persist tree URI permission.', error);
				}
				if (cachedLibrary && cachedLibrary.files.length > 0) {
					view.allFiles = restoreStoredFilesFromCache(cachedLibrary);
					opts.hydrateTracksFromLibrary(view.allFiles);
					opts.bumpBrowseVersion();
				}
			} catch (error) {
				const isCancel = error instanceof Error && /cancel/i.test(error.message);
				if (!isCancel) {
					console.error('Failed to open native folder.', error);
				}
				const nativeInput = opts.getNativeFileInputEl();
				if (nativeInput) {
					nativeInput.click();
					return;
				}
				if (!isCancel) {
					alert('Unable to open a folder on this device. Please try again.');
				}
			} finally {
				view.isLoading = false;
			}
			return;
		}

		if ('showDirectoryPicker' in window) {
			try {
				const dirHandle = await (window as unknown as {
					showDirectoryPicker(o: object): Promise<FileSystemDirectoryHandle>;
				}).showDirectoryPicker({ mode: 'read' });
				s.rootDirHandle = dirHandle;
				musicSettings.nativeTreeUri = '';
				s.pendingHandle = null;
				view.allFiles = [];
				activateDeviceLibrary(dirHandle.name);
				view.browsePath = [];
				opts.bumpBrowseVersion();  // triggers browse entry reload
				view.showQueue = true;
				void saveHandleToIDB(dirHandle);
				const cachedLibrary = await loadDeviceCachedLibrary(null, dirHandle.name);
				if (cachedLibrary && cachedLibrary.files.length > 0) {
					view.allFiles = restoreStoredFilesFromCache(cachedLibrary);
					opts.hydrateTracksFromLibrary(view.allFiles);
					opts.bumpBrowseVersion();
				}
			} catch { /* user cancelled or API not supported */ }
		} else {
			opts.getFolderInputEl()?.click();
		}
	}

	function handleFolderInput(e: Event): void {
		const input = e.target as HTMLInputElement;
		const files = Array.from(input.files ?? []).filter(f => isSupportedAudioFile(f.name));
		if (files.length === 0) { alert('No supported audio files found in selected folder.'); return; }
		s.rootDirHandle = null;
		s.nativeTreeUri = null;
		musicSettings.nativeTreeUri = '';
		libraryScanPromise = null;
		view.allFiles = files.map((file) => createStoredAudioFile(file));
		activateDeviceLibrary(files[0].webkitRelativePath?.split('/')[0] ?? 'Selected Files');
		view.browsePath = [];
		opts.bumpBrowseVersion();  // triggers browse entry reload
		view.showQueue = true;
		opts.hydrateTracksFromLibrary(view.allFiles);
		void saveCachedLibrary(s.nativeTreeUri, musicSettings.lastFolderName || 'Selected Files', view.allFiles);
		input.value = '';
	}

	function handleNativeFileInput(e: Event): void {
		const input = e.target as HTMLInputElement;
		const files = Array.from(input.files ?? []).filter((file) => {
			return isSupportedAudioFile(file.name) || file.type.startsWith('audio/');
		});

		if (files.length === 0) {
			alert('No supported audio files were selected.');
			input.value = '';
			return;
		}

		s.rootDirHandle = null;
		s.nativeTreeUri = null;
		musicSettings.nativeTreeUri = '';
		s.pendingHandle = null;
		libraryScanPromise = null;
		view.allFiles = files.map((file) => createStoredAudioFile(file));
		activateDeviceLibrary('Selected Files');
		view.browsePath = [];
		opts.bumpBrowseVersion();
		view.showQueue = true;
		opts.hydrateTracksFromLibrary(view.allFiles, true);
		void saveCachedLibrary(s.nativeTreeUri, 'Selected Files', view.allFiles);
		input.value = '';
	}

	// ─────────────────────────────────────────────────────────────
	// Reconnect a pending handle (needs user gesture for permission)
	// ─────────────────────────────────────────────────────────────
	async function reconnectFolder(): Promise<void> {
		if (!s.pendingHandle) return;
		try {
			const perm = await (s.pendingHandle as unknown as { requestPermission(o: object): Promise<string> })
				.requestPermission({ mode: 'read' });
			if (perm === 'granted') {
				s.rootDirHandle = s.pendingHandle;
				s.nativeTreeUri = null;
				musicSettings.nativeTreeUri = '';
				s.pendingHandle = null;
				view.allFiles = [];
				activateDeviceLibrary(s.rootDirHandle.name);
				opts.bumpBrowseVersion();
				view.showQueue = true;
				void saveHandleToIDB(s.rootDirHandle);
				const cachedLibrary = await loadDeviceCachedLibrary(null, s.rootDirHandle.name);
				if (cachedLibrary && cachedLibrary.files.length > 0) {
					view.allFiles = restoreStoredFilesFromCache(cachedLibrary);
					opts.hydrateTracksFromLibrary(view.allFiles);
					opts.bumpBrowseVersion();
				}
			}
		} catch { /* user denied */ }
	}

	// ── Google Drive ↔ Local file transfer ─────────────────────

	async function openLocalDownloadFolderPicker(file: StoredAudioFile): Promise<void> {
		view.transferFile = file;
		view.transferDirection = 'download';
		if (opts.isNativeApp) {
			if (!s.nativeTreeUri) {
				// First download: the selected root folder is the destination —
				// start immediately instead of opening a second picker.
				s.localPickerPath = [];
				await openFolder();
				if (s.nativeTreeUri && view.transferFile) {
					await selectLocalFolderAndDownload();
				} else {
					view.transferFile = null;
				}
				return;
			}
			view.showLocalFolderPicker = true;
			await loadLocalFolderPicker('');
		} else {
			await downloadToLocalFolder(file);
		}
	}

	async function loadLocalFolderPicker(path: string): Promise<void> {
		if (!s.nativeTreeUri) return;
		s.localPickerLoading = true;
		try {
			const result = await DirectoryReader.listEntries({ treeUri: s.nativeTreeUri, path });
			s.localPickerEntries = result.entries;
		} catch (e) {
			addToast({ message: 'Failed to list folders.', type: 'error' });
		} finally {
			s.localPickerLoading = false;
		}
	}

	function navigateLocalPickerInto(folder: NativeDirectoryFolder): void {
		s.localPickerPath = [...s.localPickerPath, folder.name];
		void loadLocalFolderPicker(s.localPickerPath.join('/'));
	}

	async function selectLocalFolderAndDownload(): Promise<void> {
		if (!s.nativeTreeUri || view.isTransferring || view.isFileOpRunning) return;
		// A pending move/copy uses the local picker's current path as destination.
		if (view.pendingFileOp) {
			view.showLocalFolderPicker = false;
			await opts.runPendingFileOp({ localPath: s.localPickerPath.join('/') });
			return;
		}
		const transferFile = view.transferFile;
		if (!transferFile) return;
		const token = await opts.driveSession.ensureDriveAccessToken(true);
		if (!token) {
			addToast({ message: 'Drive session expired. Please reconnect.', type: 'warning' });
			return;
		}
		view.isTransferring = true;
		view.showLocalFolderPicker = false;
		view.transferPhase = 'downloading';
		view.transferProgress = { loaded: 0, total: 0 };
		try {
			const driveFile = await downloadGoogleDriveFile({
				accessToken: token,
				fileId: (transferFile as any).fileId ?? '',
				fileName: transferFile.name,
				mimeType: (transferFile as any).mimeType,
				modifiedAt: (transferFile as any).modifiedAt,
				onProgress: (loaded, total) => {
					view.transferProgress = { loaded, total };
				}
			});
			view.transferPhase = 'saving';
			view.transferProgress = null;
			// Use FileReader for safe base64 encoding (avoids call-stack
			// overflow from String.fromCharCode(...spread) on large files)
			const base64 = await new Promise<string>((resolve, reject) => {
				const reader = new FileReader();
				reader.onload = () => {
					const result = reader.result as string;
					resolve(result.split(',')[1] ?? result);
				};
				reader.onerror = reject;
				reader.readAsDataURL(driveFile);
			});
			const result = await DirectoryReader.writeFile({
				treeUri: s.nativeTreeUri,
				path: s.localPickerPath.join('/'),
				fileName: transferFile.name,
				mimeType: (transferFile as any).mimeType ?? 'audio/mpeg',
				data: base64,
			});
			// Add the new file to the device library so it appears immediately
			// when browsing local files. In Drive view the source file is already
			// listed (and must keep its "Download" action), so injecting a native
			// copy here would show an "Upload" button instead of the download one.
			if (musicSettings.librarySource !== 'drive') {
				const newFile: StoredAudioFile = {
					source: 'native',
					name: transferFile.name,
					relativePath: s.localPickerPath.length > 0 ? s.localPickerPath.join('/') + '/' + transferFile.name : transferFile.name,
					path: result.path,
					mimeType: (transferFile as any).mimeType ?? 'audio/mpeg',
					modifiedAt: Date.now(),
				};
				view.allFiles = [...view.allFiles, newFile];
				opts.bumpBrowseVersion();
			}
			addToast({ message: `Downloaded "${transferFile.name}" to phone.`, type: 'info' });
		} catch (e: any) {
			const msg = e?.message || '';
			if (/security|permission/i.test(msg)) {
				addToast({ message: 'Please re-select your music folder to grant write permission.', type: 'warning', autoDismissMs: 6000 });
			} else if (/401|unauthorised|token|auth/i.test(msg)) {
				addToast({ message: 'Google Drive session expired. Reconnect in Settings.', type: 'warning', autoDismissMs: 5000 });
			} else {
				addToast({ message: 'Download failed.', type: 'error' });
			}
		} finally {
			view.isTransferring = false;
			view.transferFile = null;
			view.transferProgress = null;
			view.transferPhase = 'downloading';
		}
	}

	async function downloadToLocalFolder(file: StoredAudioFile): Promise<void> {
		if (view.isTransferring) return;
		const token = await opts.driveSession.ensureDriveAccessToken(true);
		if (!token) {
			addToast({ message: 'Connect to Google Drive first.', type: 'warning' });
			return;
		}
		view.isTransferring = true;
		view.transferPhase = 'downloading';
		view.transferProgress = { loaded: 0, total: 0 };
		try {
			if (!('showDirectoryPicker' in window)) {
				addToast({ message: 'Folder picker not supported in this browser. Try Chrome or Edge.', type: 'warning', autoDismissMs: 5000 });
				return;
			}
			addToast({ message: 'Choose a folder to save the file…', type: 'info', autoDismissMs: 2500 });
			const dirHandle = await (window as any).showDirectoryPicker({ mode: 'readwrite' });
			const driveFile = await downloadGoogleDriveFile({
				accessToken: token,
				fileId: (file as any).fileId ?? '',
				fileName: file.name,
				mimeType: (file as any).mimeType,
				modifiedAt: (file as any).modifiedAt,
				onProgress: (loaded, total) => {
					view.transferProgress = { loaded, total };
				}
			});
			view.transferPhase = 'saving';
			view.transferProgress = null;
			const newHandle = await dirHandle.getFileHandle(file.name, { create: true });
			const writable = await newHandle.createWritable();
			await writable.write(driveFile);
			await writable.close();
			addToast({ message: `Downloaded "${file.name}" to phone.`, type: 'info' });
		} catch (e: any) {
			if (e?.name !== 'AbortError') {
				const msg = e?.message || '';
				if (/security|permission/i.test(msg)) {
					addToast({ message: 'Please re-select your music folder to grant write permission.', type: 'warning', autoDismissMs: 6000 });
				} else if (/401|unauthorised|token|auth|expired/i.test(msg)) {
					addToast({ message: 'Google Drive session expired. Reconnect in Settings.', type: 'warning', autoDismissMs: 5000 });
				} else {
					addToast({ message: `Download failed: ${msg || 'Unknown error'}`, type: 'error' });
				}
			}
		} finally {
			view.isTransferring = false;
			view.transferFile = null;
			view.transferProgress = null;
			view.transferPhase = 'downloading';
		}
	}

	return {
		get rootDirHandle() { return s.rootDirHandle; },
		set rootDirHandle(value: FileSystemDirectoryHandle | null) { s.rootDirHandle = value; },
		get nativeTreeUri() { return s.nativeTreeUri; },
		set nativeTreeUri(value: string | null) { s.nativeTreeUri = value; },
		get pendingHandle() { return s.pendingHandle; },
		set pendingHandle(value: FileSystemDirectoryHandle | null) { s.pendingHandle = value; },
		get libraryScanPromise() { return libraryScanPromise; },
		set libraryScanPromise(value: Promise<StoredAudioFile[]> | null) { libraryScanPromise = value; },
		get scanProgress() { return s.scanProgress; },
		set scanProgress(value: { pct: number; filesFound: number } | null) { s.scanProgress = value; },
		get trackListLockedByUser() { return trackListLockedByUser; },
		set trackListLockedByUser(value: boolean) { trackListLockedByUser = value; },
		get deckFolderLabel() { return s.deckFolderLabel; },
		set deckFolderLabel(value: string) { s.deckFolderLabel = value; },
		get localPickerPath() { return s.localPickerPath; },
		set localPickerPath(value: string[]) { s.localPickerPath = value; },
		get localPickerEntries() { return s.localPickerEntries; },
		set localPickerEntries(value: Array<NativeDirectoryFolder | NativeDirectoryFile>) { s.localPickerEntries = value; },
		get localPickerLoading() { return s.localPickerLoading; },
		set localPickerLoading(value: boolean) { s.localPickerLoading = value; },

		activateDeviceLibrary,
		startLibraryScan,
		rescanCurrentLibraryIndex,
		openLocalSourceButton,
		restoreLocalLibrary,
		openFolder,
		handleFolderInput,
		handleNativeFileInput,
		reconnectFolder,
		loadLocalFolderPicker,
		navigateLocalPickerInto,
		selectLocalFolderAndDownload,
		downloadToLocalFolder,
		openLocalDownloadFolderPicker
	};
}
