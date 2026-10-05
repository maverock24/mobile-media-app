/**
 * browseNavigation.svelte.ts — one deck's browse listing and folder navigation.
 *
 * Extracted from `Mp3PlayerView.svelte` (PR 3.7 of docs/refactoring-plan.md).
 * Owns the entry list the browse view renders (`browseEntries`), the busy flag
 * (`browseLoading`), the per-load id counter used to drop a superseded load, and
 * the five functions that drive them: `loadBrowseEntries`, `navigateInto`,
 * `goToFileFolder`, `navigateToParentFolderFromSwipe` and `navigateUp`.
 *
 * Seam: `createBrowseNavigation` is a factory, not a module singleton. Two decks
 * mount at once (the `deck` prop), so a shared instance would share the load-id
 * counter and deck A's load would cancel deck B's in-flight one, leaving deck B's
 * `browseLoading` stuck true (the counter bail returns before the flag is
 * cleared). Each deck gets its own counter.
 *
 * It spans both sources, so it depends on the deck's `deviceLibrary` instance for
 * the scan-in-progress check (`libraryScanPromise`) and the two device handles
 * (`nativeTreeUri`, `rootDirHandle`) that decide the loader's live-listing branch.
 *
 * The browse reload effect stays in the view: it reads `browsePath`, `driveSearch`,
 * `browseVersion` and `musicSettings.librarySource` and calls this module. That is
 * deliberate — moving the effect here would drop the per-deck `driveSearch` read
 * (Drive-domain state the view owns) and change when the reload fires. The view
 * keeps the reads, so every dependency the effect had before is still read in the
 * effect body; this module is called synchronously from it, so the reactive reads
 * inside `loadBrowseEntries` (the library source, the sort order, the file list,
 * the device handles) still register exactly as they did in the view.
 *
 * State ownership:
 *  - `browseEntries` / `browseLoading` move here: only these functions and the
 *    browse template read them, and the loader owns every transition.
 *  - `browsePath`, `fileSearchQuery`, `selectedBrowseFileKeys` stay in the view.
 *    The breadcrumb markup and other view functions read and write `browsePath`
 *    directly; `fileSearchQuery` is a `bind:value` input and
 *    `selectedBrowseFileKeys` drives the selection effect. They arrive through
 *    the injected `view` accessor.
 *  - `musicFavorites` and `mediaEngine` are cross-deck singletons, like
 *    `musicSettings`, so they are imported directly rather than injected.
 */
import { DirectoryReader } from '$lib/native/directory-reader';
import { buildBrowseEntries, getRelativePath } from '$lib/models/browse';
import {
	type BrowseEntry,
	type StoredAudioFile,
	createStoredAudioFile,
	createStoredNativeAudioFile,
	isSupportedAudioFile,
	parseFilename,
	sortFiles as sortStoredFiles
} from '$lib/models/music';
import { pathToString } from '$lib/browse/libraryCache';
import { musicSettings } from '$lib/stores/settings.svelte';
import { musicFavorites } from '$lib/stores/musicView.svelte';
import { mediaEngine } from '$lib/stores/mediaEngine.svelte';

/** The slice of a deck's device library the browse loader reads. */
export interface BrowseNavigationDeviceLibrary {
	readonly libraryScanPromise: Promise<StoredAudioFile[]> | null;
	readonly nativeTreeUri: string | null;
	readonly rootDirHandle: FileSystemDirectoryHandle | null;
}

/**
 * The view-owned state the browse navigation reads and writes. Every field is
 * the deck's reactive state; the deck passes getters/setters so the module reads
 * and replaces it without owning it.
 */
export interface BrowseNavigationView {
	/** Deck file list; the loader sorts and snapshots it, never writes it. */
	readonly allFiles: StoredAudioFile[];
	/** Breadcrumb stack, also read and written directly by the view. */
	browsePath: string[];
	/** Search box value; a `bind:value` input owns the element. */
	fileSearchQuery: string;
	/** Selected file keys, cleared when jumping to a file's folder. */
	selectedBrowseFileKeys: string[];
}

export interface BrowseNavigationOptions {
	/** The deck's device library instance (scan promise + handles). */
	deviceLibrary: BrowseNavigationDeviceLibrary;
	/** The view-owned state the module reads and writes. */
	view: BrowseNavigationView;
}

/** Per-deck browse state and the navigation functions that drive it. */
export interface BrowseNavigation {
	browseEntries: BrowseEntry[];
	browseLoading: boolean;

	loadBrowseEntries(path: string[], driveFilter?: string): Promise<void>;
	navigateInto(name: string): void;
	goToFileFolder(file: StoredAudioFile): void;
	navigateToParentFolderFromSwipe(): void;
	navigateUp(): void;
}

export function createBrowseNavigation(opts: BrowseNavigationOptions): BrowseNavigation {
	const state = $state({
		browseEntries: [] as BrowseEntry[],
		browseLoading: false
	});

	// Plain `let`, like the view: the counter is never read in a reactive context.
	// Per instance, so one deck's load cannot cancel the other deck's load.
	let browseLoadId = 0;

	async function loadBrowseEntries(path: string[], driveFilter = ''): Promise<void> {
		const loadId = ++browseLoadId;
		state.browseLoading = true;
		try {
			if (musicSettings.librarySource === 'drive' && driveFilter.trim()) {
				// Search mode: flat filtered list across all Drive files
				const filter = driveFilter.trim();
				const files = sortStoredFiles(opts.view.allFiles, musicSettings.sortOrder).filter((file) => {
					if (file.source !== 'drive') return false;
					const parsed = parseFilename(file.name);
					const haystack = `${file.name} ${parsed.title} ${parsed.artist}`.toLowerCase();
					return haystack.includes(filter);
				});
				state.browseEntries = files.map((file) => ({ kind: 'file', name: file.name, file }));
			} else if (opts.view.allFiles.length > 0) {
				const snapshot = buildBrowseEntries(opts.view.allFiles, path);
				if (snapshot.length > 0 || opts.deviceLibrary.libraryScanPromise === null) {
					// Index is complete or partial but has entries for this path — use it instantly
					state.browseEntries = snapshot;
				} else if (opts.deviceLibrary.nativeTreeUri) {
					// Scan in progress and this subfolder not yet indexed — live single-level call
					const result = await DirectoryReader.listEntries({ treeUri: opts.deviceLibrary.nativeTreeUri, path: pathToString(path) });
					if (loadId !== browseLoadId) return;
					const folders: BrowseEntry[] = [];
					const files: BrowseEntry[] = [];
					for (const entry of result.entries) {
						if (entry.kind === 'folder') {
							folders.push({ kind: 'folder', name: entry.name, count: 0 });
						} else {
							files.push({ kind: 'file', name: entry.name, file: createStoredNativeAudioFile(entry) });
						}
					}
					folders.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
					files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
					state.browseEntries = [...folders, ...files];
				} else {
					state.browseEntries = snapshot; // empty but nothing else we can do
				}
			} else if (opts.deviceLibrary.rootDirHandle) {
				// Navigate to the directory at `path`
				let dir: FileSystemDirectoryHandle = opts.deviceLibrary.rootDirHandle;
				for (const segment of path) {
					let found = false;
					for await (const [name, handle] of (dir as unknown as AsyncIterable<[string, FileSystemHandle]>)) {
						if (handle.kind === 'directory' && name === segment) {
							dir = handle as FileSystemDirectoryHandle; found = true; break;
						}
					}
					if (!found) break;
				}
				const folders: BrowseEntry[] = [];
				const files: BrowseEntry[] = [];
				for await (const [name, handle] of (dir as unknown as AsyncIterable<[string, FileSystemHandle]>)) {
					if (handle.kind === 'directory') {
						let count = 0;
						try {
							for await (const [n2, h2] of (handle as unknown as AsyncIterable<[string, FileSystemHandle]>)) {
								if (h2.kind === 'file' && isSupportedAudioFile(n2)) count++;
							}
						} catch { /* skip */ }
						folders.push({ kind: 'folder', name, count });
					} else if (handle.kind === 'file' && isSupportedAudioFile(name)) {
						files.push({ kind: 'file', name, file: createStoredAudioFile(await (handle as FileSystemFileHandle).getFile()) });
					}
				}
				folders.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
				files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
				state.browseEntries = [...folders, ...files];
			} else if (opts.deviceLibrary.nativeTreeUri) {
				const result = await DirectoryReader.listEntries({ treeUri: opts.deviceLibrary.nativeTreeUri, path: pathToString(path) });
				if (loadId !== browseLoadId) return;
				const folders: BrowseEntry[] = [];
				const files: BrowseEntry[] = [];

				for (const entry of result.entries) {
					if (entry.kind === 'folder') {
						folders.push({ kind: 'folder', name: entry.name, count: 0 });
					} else {
						files.push({ kind: 'file', name: entry.name, file: createStoredNativeAudioFile(entry) });
					}
				}

				folders.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
				files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
				state.browseEntries = [...folders, ...files];
			} else {
				if (loadId === browseLoadId) state.browseEntries = [];
			}
		} catch { if (loadId === browseLoadId) state.browseEntries = []; }
		if (loadId === browseLoadId) state.browseLoading = false;
	}

	function navigateInto(name: string): void {
		musicFavorites.shown = false;
		opts.view.browsePath = [...opts.view.browsePath, name];
	}

	/** Navigate to the folder containing a file from filtered search results. */
	function goToFileFolder(file: StoredAudioFile): void {
		const fullPath = getRelativePath(file);
		const segments = fullPath.split('/');
		if (segments.length <= 1) {
			opts.view.browsePath = [];
		} else {
			opts.view.browsePath = segments.slice(0, -1);
		}
		musicFavorites.shown = false;
		opts.view.fileSearchQuery = '';
		opts.view.selectedBrowseFileKeys = [];
		mediaEngine.musicSelectionLoopActive = false;
	}

	function navigateToParentFolderFromSwipe(): void {
		if (opts.view.browsePath.length === 0) return;
		musicFavorites.shown = false;
		opts.view.browsePath = opts.view.browsePath.slice(0, -1);
	}

	function navigateUp(): void {
		if (musicFavorites.shown) {
			musicFavorites.shown = false;
			return;
		}
		if (opts.view.browsePath.length > 0) {
			opts.view.browsePath = opts.view.browsePath.slice(0, -1);
		}
	}

	return {
		get browseEntries() { return state.browseEntries; },
		set browseEntries(value: BrowseEntry[]) { state.browseEntries = value; },
		get browseLoading() { return state.browseLoading; },
		set browseLoading(value: boolean) { state.browseLoading = value; },

		loadBrowseEntries,
		navigateInto,
		goToFileFolder,
		navigateToParentFolderFromSwipe,
		navigateUp
	};
}
