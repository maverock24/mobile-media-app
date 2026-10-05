/**
 * folderPicker.svelte.ts — one deck's Google Drive folder-picker dialog.
 *
 * Extracted from `Mp3PlayerView.svelte` (PR 3.4 of docs/refactoring-plan.md).
 * Owns the picker state (`showFolderPicker`, the `folderPicker*` fields, the
 * breadcrumb stack, the access token captured for the dialog, the sub-folder
 * probe cache and the pending-restore bookkeeping) and the functions that drive
 * the dialog.
 *
 * Seam: `createFolderPicker` is a factory, not a module singleton. Two decks
 * mount at once (the `deck` prop), so a shared instance would let deck A's
 * picker answer for deck B. The caller injects the deck's Drive session (for
 * the pending-intent restore), a callback that resets the view's two Drive busy
 * flags, and the view's thin `confirmDriveFolderSelection` composition.
 *
 * The localStorage intent helpers are module-level plain functions: the pending
 * flag is a global hand-off across the OAuth round trip, not per-deck.
 *
 * `loadFolderPickerLevel` intentionally carries no staleness guard: it is a
 * straight port of the view, where a superseded load is unguarded and the last
 * `listGoogleDriveFolders` resolution wins. Adding a guard here would have been
 * a behaviour change, so it was not.
 */
import {
	checkFolderHasSubfolders,
	listGoogleDriveFolders,
	type GoogleDriveFolder
} from '$lib/google-drive';
import { formatGoogleDriveAuthError } from '$lib/google-drive-auth-error';
import { musicSettings } from '$lib/stores/settings.svelte';

/** localStorage key for the pending folder-picker hand-off across OAuth. */
export const DRIVE_FOLDER_PICKER_PENDING_KEY = 'google-drive-folder-picker-pending';

/** True while a folder-picker intent is pending a native OAuth round trip. */
export function hasPendingDriveFolderPickerIntent(): boolean {
	if (typeof localStorage === 'undefined') {
		return false;
	}

	return localStorage.getItem(DRIVE_FOLDER_PICKER_PENDING_KEY) === '1';
}

/** Marks a folder-picker intent before an interactive sign-in starts. */
export function markDriveFolderPickerPending(): void {
	if (typeof localStorage === 'undefined') {
		return;
	}

	localStorage.setItem(DRIVE_FOLDER_PICKER_PENDING_KEY, '1');
}

/** Clears a pending folder-picker intent (chosen, cancelled or timed out). */
export function clearPendingDriveFolderPickerIntent(): void {
	if (typeof localStorage === 'undefined') {
		return;
	}

	localStorage.removeItem(DRIVE_FOLDER_PICKER_PENDING_KEY);
}

/** The slice of a deck's Drive session the picker restore needs. */
export interface FolderPickerDriveSession {
	ensureDriveAccessToken(interactive: boolean): Promise<string | null>;
}

export interface FolderPickerOptions {
	/** The deck's Drive session, used by the pending-intent restore. */
	driveSession: FolderPickerDriveSession;
	/**
	 * Resets the view's `isDriveAuthenticating` / `isDriveLoading` flags after a
	 * restore attempt, so a lost native authorisation cannot wedge the Connect
	 * control in a spinner.
	 */
	onRestoreBusyFlagsReset: () => void;
	/** The view's thin `confirmDriveFolderSelection` composition. */
	confirmDriveFolderSelection: (folderId?: string, folderName?: string) => void | Promise<void>;
}

/** Per-deck folder-picker state and the functions that drive the dialog. */
export interface FolderPicker {
	showFolderPicker: boolean;
	folderPickerFolders: GoogleDriveFolder[];
	folderPickerLoading: boolean;
	folderPickerError: string;
	folderPickerStack: { id: string; name: string }[];
	folderPickerToken: string;
	folderHasSubFolders: Record<string, boolean>;

	restorePendingDriveFolderPickerIfNeeded(): Promise<boolean>;
	schedulePendingDriveFolderPickerRestore(): void;
	clearPendingDriveFolderPickerRestoreTimers(): void;
	openFolderPicker(): Promise<void>;
	loadFolderPickerLevel(): Promise<void>;
	navigateFolderPickerInto(folder: GoogleDriveFolder): Promise<void>;
	navigateFolderPickerBack(): Promise<void>;
	cancelFolderPicker(): void;
	confirmCurrentFolder(): void;
	removeFavoriteFolder(id: string, source: string): void;
	isDriveFolderPickerFavorited(folderId: string): boolean;
	toggleDriveFolderPickerFavorite(folder: GoogleDriveFolder, e: MouseEvent): void;
}

export function createFolderPicker(opts: FolderPickerOptions): FolderPicker {
	const state = $state({
		showFolderPicker: false,
		folderPickerFolders: [] as GoogleDriveFolder[],
		folderPickerLoading: false,
		folderPickerError: '',
		folderPickerStack: [] as { id: string; name: string }[],
		folderPickerToken: '',
		folderHasSubFolders: {} as Record<string, boolean>,
		isRestoringPendingDriveFolderPicker: false,
		pendingDriveFolderPickerRestoreTimers: [] as number[]
	});

	async function restorePendingDriveFolderPickerIfNeeded(): Promise<boolean> {
		if (!hasPendingDriveFolderPickerIntent() || state.isRestoringPendingDriveFolderPicker) {
			return false;
		}

		state.isRestoringPendingDriveFolderPicker = true;
		try {
			const token = await opts.driveSession.ensureDriveAccessToken(false);
			if (!token) {
				// Native auth was attempted while the WebView was backgrounded; if its
				// result never came back, don't leave the Connect control wedged in a
				// spinner — reset so the user can simply tap Connect again.
				opts.onRestoreBusyFlagsReset();
				return false;
			}

			state.folderPickerToken = token;
			opts.onRestoreBusyFlagsReset();
			clearPendingDriveFolderPickerRestoreTimers();
			if (!state.showFolderPicker) {
				await openFolderPicker();
			}

			return true;
		} finally {
			state.isRestoringPendingDriveFolderPicker = false;
		}
	}

	function schedulePendingDriveFolderPickerRestore(): void {
		if (typeof window === 'undefined') {
			return;
		}

		state.pendingDriveFolderPickerRestoreTimers.forEach((timer) => window.clearTimeout(timer));
		state.pendingDriveFolderPickerRestoreTimers = [750, 1500, 3000, 6000].map((delay) => window.setTimeout(() => {
			if (!hasPendingDriveFolderPickerIntent() || state.showFolderPicker) {
				return;
			}

			void restorePendingDriveFolderPickerIfNeeded();
		}, delay));
	}

	function clearPendingDriveFolderPickerRestoreTimers(): void {
		if (typeof window === 'undefined') {
			return;
		}

		state.pendingDriveFolderPickerRestoreTimers.forEach((timer) => window.clearTimeout(timer));
		state.pendingDriveFolderPickerRestoreTimers = [];
	}

	async function openFolderPicker(): Promise<void> {
		state.folderPickerStack = [];
		state.folderPickerFolders = [];
		state.folderPickerError = '';
		state.showFolderPicker = true;
		await loadFolderPickerLevel();
	}

	async function loadFolderPickerLevel(): Promise<void> {
		state.folderPickerLoading = true;
		state.folderPickerError = '';
		try {
			const parentId = state.folderPickerStack.at(-1)?.id;
			state.folderPickerFolders = await listGoogleDriveFolders(state.folderPickerToken, parentId);
			// Fire parallel sub-folder existence checks for any unchecked folders
			const unchecked = state.folderPickerFolders.filter(f => !(f.id in state.folderHasSubFolders));
			if (unchecked.length > 0) {
				const results = await Promise.allSettled(
					unchecked.map(f => checkFolderHasSubfolders(state.folderPickerToken, f.id))
				);
				const updates: Record<string, boolean> = {};
				unchecked.forEach((f, i) => {
					const r = results[i];
					updates[f.id] = r.status === 'fulfilled' ? r.value : false;
				});
				state.folderHasSubFolders = { ...state.folderHasSubFolders, ...updates };
			}
		} catch (error) {
			state.folderPickerFolders = [];
			state.folderPickerError = formatGoogleDriveAuthError(error);
		} finally {
			state.folderPickerLoading = false;
		}
	}

	async function navigateFolderPickerInto(folder: GoogleDriveFolder): Promise<void> {
		state.folderPickerStack = [...state.folderPickerStack, { id: folder.id, name: folder.name }];
		await loadFolderPickerLevel();
	}

	async function navigateFolderPickerBack(): Promise<void> {
		state.folderPickerStack = state.folderPickerStack.slice(0, -1);
		await loadFolderPickerLevel();
	}

	function cancelFolderPicker(): void {
		state.showFolderPicker = false;
		clearPendingDriveFolderPickerIntent();
		state.folderPickerToken = '';
		state.folderPickerStack = [];
		state.folderPickerFolders = [];
		state.folderPickerError = '';
	}

	function confirmCurrentFolder(): void {
		const current = state.folderPickerStack.at(-1);
		if (current) {
			void opts.confirmDriveFolderSelection(current.id, current.name);
		} else {
			void opts.confirmDriveFolderSelection(undefined, undefined);
		}
	}

	function removeFavoriteFolder(id: string, source: string): void {
		musicSettings.favoriteFolders = musicSettings.favoriteFolders.filter(f => !(f.id === id && f.source === source));
	}

	function isDriveFolderPickerFavorited(folderId: string): boolean {
		return musicSettings.favoriteFolders.some(f => f.id === folderId && f.source === 'drive');
	}

	function toggleDriveFolderPickerFavorite(folder: GoogleDriveFolder, e: MouseEvent): void {
		e.stopPropagation();
		const idx = musicSettings.favoriteFolders.findIndex(f => f.id === folder.id && f.source === 'drive');
		if (idx >= 0) {
			musicSettings.favoriteFolders = musicSettings.favoriteFolders.filter((_, i) => i !== idx);
		} else {
			musicSettings.favoriteFolders = [...musicSettings.favoriteFolders, { id: folder.id, name: folder.name, source: 'drive' as const }];
		}
	}

	return {
		get showFolderPicker() { return state.showFolderPicker; },
		set showFolderPicker(value: boolean) { state.showFolderPicker = value; },
		get folderPickerFolders() { return state.folderPickerFolders; },
		set folderPickerFolders(value: GoogleDriveFolder[]) { state.folderPickerFolders = value; },
		get folderPickerLoading() { return state.folderPickerLoading; },
		set folderPickerLoading(value: boolean) { state.folderPickerLoading = value; },
		get folderPickerError() { return state.folderPickerError; },
		set folderPickerError(value: string) { state.folderPickerError = value; },
		get folderPickerStack() { return state.folderPickerStack; },
		set folderPickerStack(value: { id: string; name: string }[]) { state.folderPickerStack = value; },
		get folderPickerToken() { return state.folderPickerToken; },
		set folderPickerToken(value: string) { state.folderPickerToken = value; },
		get folderHasSubFolders() { return state.folderHasSubFolders; },
		set folderHasSubFolders(value: Record<string, boolean>) { state.folderHasSubFolders = value; },

		restorePendingDriveFolderPickerIfNeeded,
		schedulePendingDriveFolderPickerRestore,
		clearPendingDriveFolderPickerRestoreTimers,
		openFolderPicker,
		loadFolderPickerLevel,
		navigateFolderPickerInto,
		navigateFolderPickerBack,
		cancelFolderPicker,
		confirmCurrentFolder,
		removeFavoriteFolder,
		isDriveFolderPickerFavorited,
		toggleDriveFolderPickerFavorite
	};
}
