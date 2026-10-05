import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { GoogleDriveFolder } from '$lib/google-drive';

// The module under test talks to Google Drive and, for the favourite trio, to
// the global settings store. The two Drive calls are replaced with vi.fn
// stand-ins so the picker's load, probe and error paths can be driven without a
// network. The settings store is real: the favourites live there.
const mocks = vi.hoisted(() => ({
	list: vi.fn(),
	check: vi.fn(),
}));

vi.mock('$lib/google-drive', () => ({
	listGoogleDriveFolders: mocks.list,
	checkFolderHasSubfolders: mocks.check,
}));

import {
	createFolderPicker,
	hasPendingDriveFolderPickerIntent,
	markDriveFolderPickerPending,
	clearPendingDriveFolderPickerIntent,
	DRIVE_FOLDER_PICKER_PENDING_KEY,
	type FolderPickerOptions
} from '$lib/drive/folderPicker.svelte';
import { musicSettings } from '$lib/stores/settings.svelte';

beforeEach(() => {
	vi.clearAllMocks();
	localStorage.clear();
	musicSettings.favoriteFolders = [];
});

// ── helpers ──────────────────────────────────────────────────

const folder = (id: string, name = id): GoogleDriveFolder => ({
	id,
	name,
	mimeType: 'application/vnd.google-apps.folder',
});

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((r) => { resolve = r; });
	return { promise, resolve };
}

/** A fresh picker wired to inert stand-ins unless a test overrides them. */
function makePicker(overrides: Partial<FolderPickerOptions> = {}) {
	return createFolderPicker({
		driveSession: { ensureDriveAccessToken: vi.fn().mockResolvedValue('token') },
		onRestoreBusyFlagsReset: vi.fn(),
		confirmDriveFolderSelection: vi.fn(),
		...overrides,
	});
}

// ─────────────────────────────────────────────────────────────
// localStorage intent helpers (module-level, global by nature)
// ─────────────────────────────────────────────────────────────

describe('pending folder-picker intent helpers', () => {
	it('marks, reads and clears the pending intent', () => {
		expect(hasPendingDriveFolderPickerIntent()).toBe(false);
		markDriveFolderPickerPending();
		expect(hasPendingDriveFolderPickerIntent()).toBe(true);
		clearPendingDriveFolderPickerIntent();
		expect(hasPendingDriveFolderPickerIntent()).toBe(false);
	});

	it('stores the exact key and value the view used', () => {
		markDriveFolderPickerPending();
		expect(DRIVE_FOLDER_PICKER_PENDING_KEY).toBe('google-drive-folder-picker-pending');
		expect(localStorage.getItem('google-drive-folder-picker-pending')).toBe('1');
	});

	it('treats any value other than the exact "1" as not pending', () => {
		localStorage.setItem('google-drive-folder-picker-pending', 'true');
		expect(hasPendingDriveFolderPickerIntent()).toBe(false);
	});

	it('no-ops and reports false when localStorage is unavailable (SSR)', () => {
		vi.stubGlobal('localStorage', undefined);
		try {
			expect(hasPendingDriveFolderPickerIntent()).toBe(false);
			expect(() => markDriveFolderPickerPending()).not.toThrow();
			expect(() => clearPendingDriveFolderPickerIntent()).not.toThrow();
		} finally {
			vi.unstubAllGlobals();
		}
	});
});

// ─────────────────────────────────────────────────────────────
// loadFolderPickerLevel
// ─────────────────────────────────────────────────────────────

describe('loadFolderPickerLevel', () => {
	it('lists at the root and probes every unchecked folder once', async () => {
		mocks.list.mockResolvedValue([folder('a'), folder('b')]);
		mocks.check.mockResolvedValue(true);
		const picker = makePicker();
		picker.folderPickerToken = 'tok';

		await picker.loadFolderPickerLevel();

		expect(mocks.list).toHaveBeenCalledWith('tok', undefined);
		expect(mocks.check.mock.calls.map((c) => c[1])).toEqual(['a', 'b']);
		expect(picker.folderHasSubFolders).toEqual({ a: true, b: true });
		expect(picker.folderPickerLoading).toBe(false);
		expect(picker.folderPickerError).toBe('');
	});

	it('uses the top of the stack as the parent', async () => {
		mocks.list.mockResolvedValue([]);
		const picker = makePicker();
		picker.folderPickerToken = 'tok';
		picker.folderPickerStack = [{ id: 'p', name: 'Parent' }];

		await picker.loadFolderPickerLevel();

		expect(mocks.list).toHaveBeenCalledWith('tok', 'p');
	});

	it('does not re-probe a folder already in the sub-folder cache', async () => {
		mocks.list.mockResolvedValue([folder('a')]);
		const picker = makePicker();
		picker.folderHasSubFolders = { a: true };

		await picker.loadFolderPickerLevel();

		expect(mocks.check).not.toHaveBeenCalled();
	});

	it('records a rejected probe as false without failing the load', async () => {
		mocks.list.mockResolvedValue([folder('a')]);
		mocks.check.mockRejectedValue(new Error('probe failed'));
		const picker = makePicker();

		await picker.loadFolderPickerLevel();

		expect(picker.folderHasSubFolders).toEqual({ a: false });
	});

	it('clears the list and formats the error when the listing rejects', async () => {
		mocks.list.mockRejectedValue(new Error('boom'));
		const picker = makePicker();

		await picker.loadFolderPickerLevel();

		expect(picker.folderPickerFolders).toEqual([]);
		expect(picker.folderPickerError).toBe('boom');
		expect(picker.folderPickerLoading).toBe(false);
	});

	it('has no staleness guard: a superseded load is not discarded', async () => {
		// The view had no guard here. Both loads set folderPickerLoading and the
		// last listGoogleDriveFolders resolution wins, so the first load to
		// resolve writes last. This pins the pre-extraction behaviour; a guard
		// would be a behaviour change, not a preservation.
		const first = deferred<GoogleDriveFolder[]>();
		const second = deferred<GoogleDriveFolder[]>();
		mocks.list.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
		mocks.check.mockResolvedValue(false);
		const picker = makePicker();

		const p1 = picker.loadFolderPickerLevel();
		const p2 = picker.loadFolderPickerLevel();
		second.resolve([folder('b')]);
		await p2;
		expect(picker.folderPickerFolders.map((f) => f.id)).toEqual(['b']);
		first.resolve([folder('a')]);
		await p1;
		expect(picker.folderPickerFolders.map((f) => f.id)).toEqual(['a']);
	});
});

// ─────────────────────────────────────────────────────────────
// open + stack navigation
// ─────────────────────────────────────────────────────────────

describe('openFolderPicker and stack navigation', () => {
	it('opens the dialog at the root and loads that level', async () => {
		mocks.list.mockResolvedValue([folder('a')]);
		mocks.check.mockResolvedValue(false);
		const picker = makePicker();

		await picker.openFolderPicker();

		expect(picker.showFolderPicker).toBe(true);
		expect(picker.folderPickerStack).toEqual([]);
		expect(mocks.list).toHaveBeenCalledWith('', undefined);
	});

	it('navigateFolderPickerInto pushes the folder then loads at it', async () => {
		mocks.list.mockResolvedValue([]);
		const picker = makePicker();

		await picker.navigateFolderPickerInto(folder('a', 'Alpha'));

		expect(picker.folderPickerStack).toEqual([{ id: 'a', name: 'Alpha' }]);
		expect(mocks.list).toHaveBeenLastCalledWith('', 'a');
	});

	it('navigateFolderPickerBack pops the stack then loads its parent', async () => {
		mocks.list.mockResolvedValue([]);
		const picker = makePicker();
		picker.folderPickerStack = [{ id: 'a', name: 'Alpha' }, { id: 'b', name: 'Beta' }];

		await picker.navigateFolderPickerBack();

		expect(picker.folderPickerStack).toEqual([{ id: 'a', name: 'Alpha' }]);
		expect(mocks.list).toHaveBeenLastCalledWith('', 'a');
	});
});

// ─────────────────────────────────────────────────────────────
// cancel
// ─────────────────────────────────────────────────────────────

describe('cancelFolderPicker', () => {
	it('hides the dialog and resets every picker field plus the pending intent', () => {
		markDriveFolderPickerPending();
		const picker = makePicker();
		picker.showFolderPicker = true;
		picker.folderPickerToken = 'tok';
		picker.folderPickerStack = [{ id: 'a', name: 'Alpha' }];
		picker.folderPickerFolders = [folder('a')];
		picker.folderPickerError = 'boom';

		picker.cancelFolderPicker();

		expect(picker.showFolderPicker).toBe(false);
		expect(picker.folderPickerToken).toBe('');
		expect(picker.folderPickerStack).toEqual([]);
		expect(picker.folderPickerFolders).toEqual([]);
		expect(picker.folderPickerError).toBe('');
		expect(hasPendingDriveFolderPickerIntent()).toBe(false);
	});
});

// ─────────────────────────────────────────────────────────────
// confirmCurrentFolder
// ─────────────────────────────────────────────────────────────

describe('confirmCurrentFolder', () => {
	it('confirms the stack top when one is selected', () => {
		const confirmDriveFolderSelection = vi.fn();
		const picker = makePicker({ confirmDriveFolderSelection });
		picker.folderPickerStack = [{ id: 'a', name: 'Alpha' }];

		picker.confirmCurrentFolder();

		expect(confirmDriveFolderSelection).toHaveBeenCalledWith('a', 'Alpha');
	});

	it('confirms an open selection when the stack is empty', () => {
		const confirmDriveFolderSelection = vi.fn();
		const picker = makePicker({ confirmDriveFolderSelection });

		picker.confirmCurrentFolder();

		expect(confirmDriveFolderSelection).toHaveBeenCalledWith(undefined, undefined);
	});
});

// ─────────────────────────────────────────────────────────────
// favourite trio (writes the global settings store)
// ─────────────────────────────────────────────────────────────

describe('folder favourites', () => {
	it('toggle adds a drive favourite', () => {
		const picker = makePicker();
		const e = { stopPropagation: vi.fn() } as unknown as MouseEvent;

		picker.toggleDriveFolderPickerFavorite(folder('a', 'Alpha'), e);

		expect(e.stopPropagation).toHaveBeenCalled();
		expect(musicSettings.favoriteFolders).toEqual([{ id: 'a', name: 'Alpha', source: 'drive' }]);
	});

	it('toggle removes an existing drive favourite', () => {
		musicSettings.favoriteFolders = [{ id: 'a', name: 'Alpha', source: 'drive' }];
		const picker = makePicker();
		const e = { stopPropagation: vi.fn() } as unknown as MouseEvent;

		picker.toggleDriveFolderPickerFavorite(folder('a', 'Alpha'), e);

		expect(musicSettings.favoriteFolders).toEqual([]);
	});

	it('isDriveFolderPickerFavorited is true only for the drive source', () => {
		musicSettings.favoriteFolders = [{ id: 'a', name: 'Alpha', source: 'device' }];
		const picker = makePicker();
		expect(picker.isDriveFolderPickerFavorited('a')).toBe(false);
		musicSettings.favoriteFolders = [{ id: 'a', name: 'Alpha', source: 'drive' }];
		expect(picker.isDriveFolderPickerFavorited('a')).toBe(true);
	});

	it('removeFavoriteFolder removes by id and source', () => {
		musicSettings.favoriteFolders = [
			{ id: 'a', name: 'Alpha', source: 'drive' },
			{ id: 'a', name: 'Alpha device', source: 'device' },
		];
		const picker = makePicker();

		picker.removeFavoriteFolder('a', 'drive');

		expect(musicSettings.favoriteFolders).toEqual([{ id: 'a', name: 'Alpha device', source: 'device' }]);
	});
});

// ─────────────────────────────────────────────────────────────
// pending-intent restore
// ─────────────────────────────────────────────────────────────

describe('pending-intent restore', () => {
	it('does nothing when there is no pending intent', async () => {
		const onRestoreBusyFlagsReset = vi.fn();
		const picker = makePicker({ onRestoreBusyFlagsReset });

		await expect(picker.restorePendingDriveFolderPickerIfNeeded()).resolves.toBe(false);
		expect(onRestoreBusyFlagsReset).not.toHaveBeenCalled();
	});

	it('on a token, stores it, resets the busy flags and opens the picker', async () => {
		markDriveFolderPickerPending();
		mocks.list.mockResolvedValue([]);
		const onRestoreBusyFlagsReset = vi.fn();
		const picker = makePicker({ onRestoreBusyFlagsReset });

		await expect(picker.restorePendingDriveFolderPickerIfNeeded()).resolves.toBe(true);
		expect(picker.folderPickerToken).toBe('token');
		expect(onRestoreBusyFlagsReset).toHaveBeenCalledTimes(1);
		expect(picker.showFolderPicker).toBe(true);
	});

	it('without a token, resets the busy flags and reports false', async () => {
		markDriveFolderPickerPending();
		const onRestoreBusyFlagsReset = vi.fn();
		const picker = makePicker({
			onRestoreBusyFlagsReset,
			driveSession: { ensureDriveAccessToken: vi.fn().mockResolvedValue(null) }
		});

		await expect(picker.restorePendingDriveFolderPickerIfNeeded()).resolves.toBe(false);
		expect(onRestoreBusyFlagsReset).toHaveBeenCalledTimes(1);
		expect(picker.showFolderPicker).toBe(false);
	});

	it('returns false immediately while a restore is already in flight', async () => {
		markDriveFolderPickerPending();
		mocks.list.mockResolvedValue([]);
		const gate = deferred<string | null>();
		const picker = makePicker({
			driveSession: { ensureDriveAccessToken: vi.fn().mockReturnValue(gate.promise) }
		});

		const first = picker.restorePendingDriveFolderPickerIfNeeded();
		await expect(picker.restorePendingDriveFolderPickerIfNeeded()).resolves.toBe(false);
		gate.resolve('token');
		await expect(first).resolves.toBe(true);
	});

	it('schedule arms four retry timers and clear cancels them', () => {
		const setSpy = vi.spyOn(window, 'setTimeout');
		const clearSpy = vi.spyOn(window, 'clearTimeout');
		const picker = makePicker();

		picker.schedulePendingDriveFolderPickerRestore();
		expect(setSpy).toHaveBeenCalledTimes(4);
		picker.clearPendingDriveFolderPickerRestoreTimers();
		expect(clearSpy).toHaveBeenCalledTimes(4);

		setSpy.mockRestore();
		clearSpy.mockRestore();
	});
});
