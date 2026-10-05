/**
 * driveLibrary.ts — one deck's Google Drive library.
 *
 * Extracted from `Mp3PlayerView.svelte` (PR 3.5 of docs/refactoring-plan.md).
 * Owns the Drive source activation, the cached-then-streamed folder load, the
 * connect / change-folder / restore entry points, the Drive upload-folder
 * picker and the favourite switch.
 *
 * Seam: `createDriveLibrary` is a factory, not a module singleton. Two decks
 * mount at once (the `deck` prop), so a shared instance would let deck A's load
 * answer for deck B. The module is rune-free — a plain `.ts` cannot hold
 * `$state` — so the deck allocates the reactive `busy` bag (`isLoading`,
 * `isAuthenticating`, `abort`) and this factory owns every transition of it.
 * Everything else the functions used to close over arrives as an injected
 * option: the `player.clear` seam, the deck file list (`view.allFiles`), the
 * `bumpBrowseVersion` sink, the device-side library state that settles into PR
 * 3.6 (`view.rootDirHandle`, `view.nativeTreeUri`, `view.pendingHandle`,
 * `view.libraryScanPromise`, `view.browsePath`, `view.showQueue`,
 * `view.showPanel`), the favourite spinner, the Drive transfer picker state
 * that settles into PR 3.8, the view's `activateDeviceLibrary` and
 * `hydrateTracksFromLibrary` helpers, and the thin
 * `confirmDriveFolderSelection` composition PR 3.4 left in the view.
 * `openFolderPicker` arrives on the injected `folderPicker` instance.
 *
 * Behaviour preserved from the view:
 *  - `driveLoadAbort`'s abort-and-replace discipline (abort, then take a fresh
 *    controller, then only the controller that is still current clears the flag);
 *  - the `loadDriveCache` -> `streamGoogleDriveMp3Files` -> `saveDriveCache`
 *    order and what each writes;
 *  - `activateDriveLibrary`'s settings writes;
 *  - `refreshGoogleDrive` busting the cache before the forced reload;
 *  - the busy flags going up and down in the same places;
 *  - `switchToFavorite`'s settings writes and its device-side reset;
 *  - the mount effect's `untrack()` boundary: the view still calls
 *    `driveLibrary.finishDriveLoad(...)` from inside it, so no reactive read in
 *    `finishDriveLoad`'s synchronous preamble becomes an effect dependency.
 */
import {
	downloadGoogleDriveFile,
	fetchGoogleDriveUser,
	isGoogleDriveConfigured,
	listGoogleDriveFolders,
	streamGoogleDriveMp3Files,
	uploadGoogleDriveFile,
	type GoogleDriveFile,
	type GoogleDriveFolder
} from '$lib/google-drive';
import { formatGoogleDriveAuthError } from '$lib/google-drive-auth-error';
import {
	clearPendingDriveFolderPickerIntent,
	markDriveFolderPickerPending,
	type FolderPicker
} from '$lib/drive/folderPicker.svelte';
import type { DriveSession } from '$lib/drive/driveSession.svelte';
import { loadDriveCache, saveDriveCache, bustDriveCache } from '$lib/utils/idb';
import { type StoredAudioFile, createStoredDriveAudioFile } from '$lib/models/music';
import { loadDeviceCachedLibrary, restoreStoredFilesFromCache } from '$lib/browse/libraryCache';
import { blobFromNativePath } from '$lib/audio/fileResolver';
import { musicSettings } from '$lib/stores/settings.svelte';
import { musicFavorites } from '$lib/stores/musicView.svelte';
import { addToast } from '$lib/stores/toastStore.svelte';

/** One favourite folder, as `musicSettings.favoriteFolders` stores it. */
type FavoriteFolder = (typeof musicSettings.favoriteFolders)[number];

/** The per-deck Drive busy flags and the in-flight load's abort controller. */
export interface DriveLibraryBusy {
	isLoading: boolean;
	isAuthenticating: boolean;
	abort: AbortController | null;
}

/**
 * The view-owned state the Drive library reads and writes. Every field is the
 * deck's reactive state; the deck passes an accessor for each so a module in a
 * rune-free `.ts` file can read and replace it without owning it.
 */
export interface DriveLibraryView {
	// Device-side library state — settles into PR 3.6 (deviceLibrary).
	libraryScanPromise: Promise<StoredAudioFile[]> | null;
	rootDirHandle: FileSystemDirectoryHandle | null;
	nativeTreeUri: string | null;
	pendingHandle: FileSystemDirectoryHandle | null;
	browsePath: string[];
	showQueue: boolean;
	showPanel: 'none' | 'speed' | 'eq';

	// Deck file list; the module replaces it, the browse view reads it.
	allFiles: StoredAudioFile[];

	// Favourite-load spinner (switchToFavorite).
	switchingToFavId: string | null;

	// Drive transfer folder picker — settles into PR 3.8 (fileOps).
	drivePickerLoading: boolean;
	drivePickerFolders: GoogleDriveFolder[];
	showDriveFolderPicker: boolean;
	transferFile: StoredAudioFile | null;
	transferDirection: 'upload' | 'download';
	isTransferring: boolean;
	isFileOpRunning: boolean;
}

export interface DriveLibraryOptions {
	/** The deck's Drive session (token, user, error). */
	driveSession: DriveSession;
	/** The deck's folder picker (PR 3.4); `openFolderPicker` lives here. */
	folderPicker: FolderPicker;
	/** The deck's Drive busy flags and abort controller. */
	busy: DriveLibraryBusy;
	/** The view-owned state the module reads and writes. */
	view: DriveLibraryView;
	/** The `player.clear` seam — drops the queue before the list is rebuilt. */
	clearPlayer(): void;
	/** The `browseVersion` sink — forces the browse view to reload. */
	bumpBrowseVersion(): void;
	/** The view's device-source activation, reached by switchToFavorite. */
	activateDeviceLibrary(folderName: string): void;
	/** The view's thin `confirmDriveFolderSelection` composition (PR 3.4). */
	confirmDriveFolderSelection(folderId?: string, folderName?: string): void | Promise<void>;
	/** The view's queue loader, reached by switchToFavorite. */
	hydrateTracksFromLibrary(files: StoredAudioFile[], resetToStart?: boolean): void;
}

export interface DriveLibrary {
	activateDriveLibrary(): void;
	finishDriveLoad(token: string, folderId?: string, forceRefresh?: boolean): Promise<void>;
	loadDriveLibrary(interactive: boolean): Promise<void>;
	connectGoogleDrive(): Promise<void>;
	refreshGoogleDrive(): Promise<void>;
	changeDriveFolder(): Promise<void>;
	openDriveSourceButton(): Promise<void>;
	materializeStoredFile(
		entry: StoredAudioFile,
		interactiveAuth?: boolean,
		onProgress?: (loaded: number, total: number) => void
	): Promise<File>;
	loadDriveFolderPicker(parentId: string): Promise<void>;
	selectDriveFolderAndUpload(folder: GoogleDriveFolder): Promise<void>;
	openDriveUploadFolderPicker(file: StoredAudioFile): Promise<void>;
	switchToFavorite(favorite: FavoriteFolder): Promise<void>;
}

export function createDriveLibrary(opts: DriveLibraryOptions): DriveLibrary {
	const { driveSession, folderPicker, busy, view } = opts;

	function activateDriveLibrary(): void {
		musicSettings.librarySource = 'drive';
		musicSettings.nativeTreeUri = '';
		musicSettings.lastFolderName = 'Google Drive';
		view.libraryScanPromise = null;
		view.rootDirHandle = null;
		view.nativeTreeUri = null;
		view.pendingHandle = null;
		view.browsePath = [];
		view.showQueue = true;
		view.showPanel = 'none';
		opts.bumpBrowseVersion();
	}

	async function loadDriveLibrary(interactive: boolean): Promise<void> {
		if (!isGoogleDriveConfigured()) {
			driveSession.error = 'Google Drive is not configured. Add PUBLIC_GOOGLE_CLIENT_ID to enable sign-in.';
			clearPendingDriveFolderPickerIntent();
			return;
		}

		if (interactive) {
			markDriveFolderPickerPending();
			folderPicker.schedulePendingDriveFolderPickerRestore();
		}

		busy.isAuthenticating = interactive;
		busy.isLoading = true;

		try {
			const token = await driveSession.ensureDriveAccessToken(interactive);
			if (!token) {
				clearPendingDriveFolderPickerIntent();
				return;
			}
			driveSession.error = '';

			void fetchGoogleDriveUser(token)
				.then((user) => {
					driveSession.user = user;
				})
				.catch(() => {
					// Folder selection should still work even if the user profile request fails.
				});

			// Show folder picker before loading files
			folderPicker.folderPickerToken = token;
			folderPicker.folderPickerStack = [];
			busy.isLoading = false;
			busy.isAuthenticating = false;

			// Reuse the saved/default Drive folder when one exists — don't re-ask
			// which folder to load. Only the very first connection (no folder chosen
			// yet) opens the picker; "change folder" lives in Settings.
			if (musicSettings.driveFolderId || musicSettings.driveFolderName) {
				clearPendingDriveFolderPickerIntent();
				await opts.confirmDriveFolderSelection(
					musicSettings.driveFolderId || undefined,
					musicSettings.driveFolderName || undefined
				);
			} else {
				await folderPicker.openFolderPicker();
			}
		} catch (error) {
			driveSession.error = formatGoogleDriveAuthError(error);
		} finally {
			busy.isAuthenticating = false;
			busy.isLoading = false;
		}
	}

	async function finishDriveLoad(token: string, folderId?: string, forceRefresh = false): Promise<void> {
		// Cancel any in-progress load
		busy.abort?.abort();
		const ctrl = new AbortController();
		busy.abort = ctrl;

		busy.isLoading = true;
		driveSession.error = '';

		const cacheKey = folderId ?? '_all';

		try {
			if (!forceRefresh) {
				const cached = await loadDriveCache(cacheKey);
				if (cached && !ctrl.signal.aborted) {
					// Instant restore from IDB — use cached file list immediately
					opts.clearPlayer();
					view.allFiles = cached.map(createStoredDriveAudioFile);
					activateDriveLibrary();
					busy.isLoading = false;

					// Background refresh — update silently without blocking UI
					void (async () => {
						const freshFiles: GoogleDriveFile[] = [];
						try {
							for await (const batch of streamGoogleDriveMp3Files(token, { folderId, signal: ctrl.signal })) {
								if (ctrl.signal.aborted) return;
								freshFiles.push(...batch.files);
							}
							if (!ctrl.signal.aborted) {
								view.allFiles = freshFiles.map(createStoredDriveAudioFile);
								opts.bumpBrowseVersion();
								await saveDriveCache(cacheKey, freshFiles);
							}
						} catch { /* ignore background refresh errors */ }
					})();
					return;
				}
			}

			// Fresh scan — stop playback then stream files progressively into the UI
			opts.clearPlayer();
			view.allFiles = [];

			const collectedFiles: GoogleDriveFile[] = [];
			let libraryActivated = false;

			for await (const batch of streamGoogleDriveMp3Files(token, { folderId, signal: ctrl.signal })) {
				if (ctrl.signal.aborted) break;
				collectedFiles.push(...batch.files);
				// Append batch to the reactive array as a single assignment (not one-at-a-time)
				const newMapped = batch.files.map(createStoredDriveAudioFile);
				view.allFiles = [...view.allFiles, ...newMapped];
				opts.bumpBrowseVersion(); // trigger browse view to refresh with new files

				// Activate the library UI as soon as the first files arrive
				if (!libraryActivated && collectedFiles.length > 0) {
					activateDriveLibrary();
					libraryActivated = true;
				}
			}

			if (!ctrl.signal.aborted) {
				if (!libraryActivated) activateDriveLibrary();
				await saveDriveCache(cacheKey, collectedFiles);
			}
		} catch (error) {
			if (!ctrl.signal.aborted) {
				driveSession.error = formatGoogleDriveAuthError(error);
			}
		} finally {
			if (busy.abort === ctrl) {
				busy.isLoading = false;
				busy.abort = null;
			}
		}
	}

	async function connectGoogleDrive(): Promise<void> {
		await loadDriveLibrary(true);
	}

	async function refreshGoogleDrive(): Promise<void> {
		const token = await driveSession.ensureDriveAccessToken(true);
		if (!token) return;
		const cacheKey = musicSettings.driveFolderId || '_all';
		await bustDriveCache(cacheKey);
		await finishDriveLoad(token, musicSettings.driveFolderId || undefined, true);
	}

	async function changeDriveFolder(): Promise<void> {
		markDriveFolderPickerPending();
		const token = await driveSession.ensureDriveAccessToken(false);
		if (!token) { await loadDriveLibrary(true); return; }
		folderPicker.folderPickerToken = token;
		await folderPicker.openFolderPicker();
	}

	// Drive source: load the last-chosen Drive folder (driveFolderId/Name) when one
	// is saved; otherwise (first ever connect, or nothing chosen yet) sign in and
	// open the folder picker. "Change folder" now lives in Settings.
	async function openDriveSourceButton(): Promise<void> {
		if (!isGoogleDriveConfigured()) return;

		// Not signed in this session yet → full connect flow (may show native consent).
		if (!driveSession.user) {
			await loadDriveLibrary(true);
			return;
		}

		const token = await driveSession.ensureDriveAccessToken(false);
		if (!token) {
			// Silent refresh failed (expired/revoked) → run the interactive connect flow.
			await loadDriveLibrary(true);
			return;
		}

		driveSession.accessToken = token;
		driveSession.error = '';

		if (musicSettings.driveFolderId || musicSettings.driveFolderName) {
			// Reuse the saved/default Drive folder without re-asking which folder.
			folderPicker.folderPickerToken = token;
			await opts.confirmDriveFolderSelection(
				musicSettings.driveFolderId || undefined,
				musicSettings.driveFolderName || undefined
			);
		} else {
			// No folder chosen yet — ask once.
			folderPicker.folderPickerToken = token;
			folderPicker.folderPickerStack = [];
			folderPicker.folderPickerFolders = [];
			folderPicker.folderPickerError = '';
			folderPicker.showFolderPicker = true;
			await folderPicker.loadFolderPickerLevel();
		}
	}

	async function materializeStoredFile(
		entry: StoredAudioFile,
		interactiveAuth = false,
		onProgress?: (loaded: number, total: number) => void
	): Promise<File> {
		if (entry.source === 'web') {
			return entry.file;
		}

		if (entry.source === 'drive') {
			const accessToken = await driveSession.ensureDriveAccessToken(interactiveAuth);
			if (!accessToken) {
				throw new Error('Your Google Drive session has expired. Sign in again to continue playback.');
			}

			return downloadGoogleDriveFile({
				accessToken,
				fileId: entry.fileId,
				fileName: entry.name,
				mimeType: entry.mimeType,
				modifiedAt: entry.modifiedAt,
				onProgress,
			});
		}

		const blob = await blobFromNativePath(entry.path, entry.mimeType);
		return new File([blob], entry.name, {
			type: entry.mimeType ?? blob.type ?? 'audio/mpeg',
			lastModified: entry.modifiedAt ?? Date.now(),
		});
	}

	async function loadDriveFolderPicker(parentId: string): Promise<void> {
		view.drivePickerLoading = true;
		try {
			const result = await listGoogleDriveFolders(driveSession.accessToken, parentId);
			view.drivePickerFolders = result;
		} catch {
			addToast({ message: 'Failed to list Drive folders.', type: 'error' });
		} finally {
			view.drivePickerLoading = false;
		}
	}

	async function openDriveUploadFolderPicker(file: StoredAudioFile): Promise<void> {
		const token = await driveSession.ensureDriveAccessToken(true);
		if (!token) {
			addToast({ message: 'Connect to Google Drive first.', type: 'warning' });
			return;
		}
		view.transferFile = file;
		view.transferDirection = 'upload';
		view.showDriveFolderPicker = true;
		await loadDriveFolderPicker('root');
	}

	async function selectDriveFolderAndUpload(folder: GoogleDriveFolder): Promise<void> {
		if (view.isTransferring || view.isFileOpRunning) return;
		const transferFile = view.transferFile;
		if (!transferFile) return;
		const token = await driveSession.ensureDriveAccessToken(true);
		if (!token) {
			addToast({ message: 'Drive session expired. Please reconnect.', type: 'warning' });
			return;
		}
		view.isTransferring = true;
		view.showDriveFolderPicker = false;
		try {
			const file = await materializeStoredFile(transferFile, true);
			const blob = new Blob([await file.arrayBuffer()], { type: file.type || 'audio/mpeg' });
			await uploadGoogleDriveFile({
				accessToken: token,
				parentFolderId: folder.id,
				fileName: transferFile.name,
				blob,
			});
			addToast({ message: `Uploaded "${transferFile.name}" to Drive.`, type: 'info' });
		} catch (e: any) {
			const msg = e?.message || '';
			if (/401|unauthorised|token|auth/i.test(msg)) {
				addToast({ message: 'Google Drive session expired. Reconnect in Settings.', type: 'warning', autoDismissMs: 5000 });
			} else {
				addToast({ message: 'Upload failed.', type: 'error' });
			}
		} finally {
			view.isTransferring = false;
			view.transferFile = null;
		}
	}

	async function switchToFavorite(favorite: FavoriteFolder): Promise<void> {
		musicFavorites.shown = false;
		view.switchingToFavId = favorite.id;
		try {
			if (favorite.source === 'drive') {
				const folderId = favorite.id === '_all' ? undefined : favorite.id;
				musicSettings.librarySource = 'drive';
				musicSettings.driveFolderId = folderId ?? '';
				musicSettings.driveFolderName = folderId ? favorite.name : '';
				const token = await driveSession.ensureDriveAccessToken(true);
				if (!token) { view.switchingToFavId = null; return; }
				if (!driveSession.user) {
					try { driveSession.user = await fetchGoogleDriveUser(token); } catch { /* ignore */ }
				}
				await finishDriveLoad(token, folderId);
			} else if (favorite.source === 'device' && favorite.treeUri) {
				view.rootDirHandle = null;
				view.nativeTreeUri = favorite.treeUri;
				musicSettings.nativeTreeUri = favorite.treeUri;
				view.pendingHandle = null;
				view.libraryScanPromise = null;
				view.allFiles = [];
				opts.activateDeviceLibrary(favorite.name);
				view.browsePath = [];
				opts.bumpBrowseVersion();
				view.showQueue = true;
				const cachedLibrary = await loadDeviceCachedLibrary(favorite.treeUri, favorite.name);
				if (cachedLibrary && cachedLibrary.files.length > 0) {
					view.allFiles = restoreStoredFilesFromCache(cachedLibrary);
					opts.hydrateTracksFromLibrary(view.allFiles);
					opts.bumpBrowseVersion();
				}
			}
		} finally {
			view.switchingToFavId = null;
		}
	}

	return {
		activateDriveLibrary,
		finishDriveLoad,
		loadDriveLibrary,
		connectGoogleDrive,
		refreshGoogleDrive,
		changeDriveFolder,
		openDriveSourceButton,
		materializeStoredFile,
		loadDriveFolderPicker,
		selectDriveFolderAndUpload,
		openDriveUploadFolderPicker,
		switchToFavorite
	};
}
