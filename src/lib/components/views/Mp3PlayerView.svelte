<script lang="ts">
	import { untrack } from 'svelte';
	import { swipeBack } from '$lib/actions/touch';
	import { swipeItem } from '$lib/actions/swipeItem';
	import { Capacitor } from '@capacitor/core';
	import { Filesystem } from '@capacitor/filesystem';
	import Input from '$lib/components/ui/Input.svelte';
	import { DirectoryReader } from '$lib/native/directory-reader';
	import MusicEqPanel from '$lib/components/ui/MusicEqPanel.svelte';
	import { createPlayer, type PlayerTrack } from '$lib/audio/player.svelte';
	import { createEqFilterChain, applyEqGains } from '$lib/audio/equalizer';
	import { bytesFromBase64, arrayBufferFromBytes } from '$lib/audio/fileResolver';
	import { getRelativePath } from '$lib/models/browse';
	import type { MediaItem } from '$lib/models/media';
	import {
		type StoredAudioFile,
		type BrowseEntry,
		type CachedWebLibraryFile,
		type CachedNativeLibraryFile,
		EQ_LABELS,
		EQ_PRESETS,
		formatTime,
		getStoredFileKey,
		getTrackKey,
		mergeStoredFiles,
		fmtGain,
		isYoutubeFavorite,
		parseFilename,
		sortFiles as sortStoredFiles,
	} from '$lib/models/music';
	import {
		idbGet, idbDelete,
		loadHandleFromIDB,
	} from '$lib/utils/idb';
	import { triggerPlaybackHaptic, triggerSwipeBackHaptic } from '$lib/native/haptics';
	import { marqueeTitle } from '$lib/actions/marqueeTitle';
	import Button from '$lib/components/ui/Button.svelte';
	import {
		downloadGoogleDriveFile,
		getGoogleDriveClientId,
		isGoogleDriveConfigured,
		type GoogleDriveFolder
	} from '$lib/google-drive';
	import { createDriveSession } from '$lib/drive/driveSession.svelte';
	import {
		createFolderPicker,
		hasPendingDriveFolderPickerIntent,
		clearPendingDriveFolderPickerIntent
	} from '$lib/drive/folderPicker.svelte';
	import {
		createDriveLibrary,
		type DriveLibraryBusy,
		type DriveLibraryView
	} from '$lib/drive/driveLibrary';
	import {
		createDeviceLibrary,
		type DeviceLibrary,
		type DeviceLibraryView
	} from '$lib/device/deviceLibrary.svelte';
	import {
		createBrowseNavigation,
		type BrowseNavigation,
		type BrowseNavigationView
	} from '$lib/browse/browseNavigation.svelte';
	import {
		saveCachedLibrary,
		loadDeviceCachedLibrary,
		restoreStoredFilesFromCache,
		collectStoredFilesFromSnapshot
	} from '$lib/browse/libraryCache';
	import {
		scanNativeAudioFiles,
		collectAllFromPath
	} from '$lib/browse/folderScan';
	import { appSettings, musicSettings } from '$lib/stores/settings.svelte';
	import { getListTileToneClasses } from '$lib/utils/listTileTone';
	
	import { mediaEngine, claimAudio, registerAudioSource, markUserPaused } from '$lib/stores/mediaEngine.svelte';
	import { addToast } from '$lib/stores/toastStore.svelte';
	import { openYoutubePanel, youtubePanel } from '$lib/stores/youtubePanel.svelte';
	import { musicFavorites, registerMusicPlayerView } from '$lib/stores/musicView.svelte';
	import {
		Play, Pause, SkipBack, SkipForward, Shuffle, Repeat,
		Volume2, VolumeX, FolderOpen, Music2,
		ChevronLeft, ChevronRight, Folder, Gauge, SlidersHorizontal,
		Cloud, RefreshCw, LogOut, Search, Star, Upload, Download, X,
		Copy, Trash2, FolderInput, Youtube
	} from 'lucide-svelte';

	type FavoriteTrack = (typeof musicSettings.favoriteTracks)[number];

	const isNativeApp = typeof window !== 'undefined' && Capacitor.isNativePlatform();

	let { deck = 'A' as 'A' | 'B', activeTab = 'music' as string }: { deck?: 'A' | 'B'; activeTab?: string } = $props();
	const deckVolKey = $derived(deck === 'A' ? 'deckAVolume' as const : 'deckBVolume' as const);
	// Deck A always plays at full volume. Deck B uses its independent volume slider.
	const effectiveVolume = $derived(deck === 'A' ? 100 : musicSettings.deckBVolume);
	// Per-deck playback speed — Deck A and Deck B keep independent speeds.
	const effectiveSpeed = $derived(deck === 'A' ? musicSettings.deckASpeed : musicSettings.deckBSpeed);
	const googleDriveConfigured = isGoogleDriveConfigured();
	const googleDriveClientId = getGoogleDriveClientId();

	const FOLDER_PLAY_SCAN_BATCH_SIZE = 48;
	const listTileToneClasses = $derived(getListTileToneClasses(appSettings.listTileTone));
	const FOLDER_PLAY_INITIAL_BATCH_SIZE = 1;
	const FOLDER_PLAY_PRIME_COUNT = 1;
	const FOLDER_PLAY_QUEUE_FLUSH_SIZE = 400;
	const BROWSE_LONG_PRESS_MS = 450;

	/** Load the library into the deck queue without starting playback. */
	function hydrateTracksFromLibrary(files: StoredAudioFile[], resetToStart = false) {
		const sorted = sortFiles(files);
		mediaEngine.musicSelectionLoopActive = false;

		if (sorted.length === 0) {
			player.clear();
			musicSettings.lastTrackIndex = 0;
			musicSettings.lastTrackTimestamp = 0;
			return;
		}

		if (resetToStart) {
			// New folder: stop playback, clear audio, reset to track 0
			player.clear();
			player.load(sorted, { startIndex: 0 });
			musicSettings.lastTrackTimestamp = 0;
			return;
		}

		// Restore: find the track by key (it survives a re-sort), and fall back to
		// the saved index. The index has to be resolved before the hand-off: the
		// module writes musicSettings.lastTrackIndex back as it selects the track.
		const keyMatch = musicSettings.lastTrackKey
			? sorted.findIndex((file) => getTrackKey(file) === musicSettings.lastTrackKey)
			: -1;
		player.load(sorted, {
			startIndex: keyMatch >= 0
				? keyMatch
				: Math.max(0, Math.min(musicSettings.lastTrackIndex, sorted.length - 1)),
		});
	}

	// ── ephemeral playback state ──
	// The queue, the transport state and the <audio> element live in the player
	// module (ADR-0001). The view reads them through these aliases and drives them
	// with `player.play/load/append/clear/resume/pause/next/prev/seek`.
	let isChangingTrack = $state(false); // prevents concurrent skip/select calls
	let isLoading        = $state(false);
	let loadingFolderPath = $state<string | null>(null); // per-folder spinner key
	let queueSessionId = 0;
	let showQueue   = $state(false);   // true → browse / folder view

	// ── Swipe left in full player → go back to browse list ───────
	// Wired via use:swipeBack on the player container in the template below.

	let showPanel   = $state<'none' | 'speed' | 'eq'>('none');
	let isRestoring = $state(false);  // set to true by init effect on Android native only

	// Prevents background folder scans from overwriting the track list after the user has
	// explicitly selected a song. Owned by the per-deck device library (PR 3.6);
	// `beginQueue` sets it through the instance below.

	// ── folder browse state ──
	// allFiles MUST be $state so hasFolderLoaded $derived updates
	let allFiles         = $state<StoredAudioFile[]>([]);     // web/native metadata-backed library
	let browsePath       = $state<string[]>([]);                 // navigation stack
	let fileSearchQuery  = $state('');
	let browseVersion    = $state(0);                          // bump to force reload
	let selectedBrowseFileKeys = $state<string[]>([]);
	// Per-deck Drive session (token, expiry, user, error). One instance per deck,
	// created here so two mounted decks never share a token.
	const driveSession = createDriveSession({ addToast, clientId: googleDriveClientId });
	let driveSearch      = $state('');
	// Per-deck Drive busy flags and abort controller. `driveLibrary.ts` is a
	// rune-free module, so the deck allocates the reactive bag and the module owns
	// every transition.
	const driveBusy = $state<DriveLibraryBusy>({ isLoading: false, isAuthenticating: false, abort: null });

	// ── Transfer state (upload to Drive / download from Drive) ──
	let showDriveFolderPicker = $state(false);
	let showLocalFolderPicker = $state(false);
	let transferFile = $state<StoredAudioFile | null>(null);
	let transferDirection = $state<'upload' | 'download'>('upload');
	let isTransferring = $state(false);
	let transferProgress = $state<{ loaded: number; total: number } | null>(null);

	// ── Track materialization progress (Drive downloads, large native files) ──
	let trackLoadProgress = $state<{ loaded: number; total: number } | null>(null);

	// ── File management ops (move / copy / delete) — ADR-0002 ──
	type PendingFileOp = {
		op: 'move' | 'copy' | 'delete';
		name: string;
		isDrive: boolean;
		fileId: string | null;
		source: StoredAudioFile | null; // set for file ops
	};
	let pendingFileOp = $state<PendingFileOp | null>(null);
	let isFileOpRunning = $state(false);
	let transferPhase = $state<'downloading' | 'saving'>('downloading');
	const transferProgressPct = $derived(
		transferProgress && transferProgress.total > 0
			? Math.min(100, Math.round((transferProgress.loaded / transferProgress.total) * 100))
			: null
	);
	// Drive folder picker navigation
	let drivePickerPath = $state<GoogleDriveFolder[]>([]);
	let drivePickerFolders = $state<GoogleDriveFolder[]>([]);
	let drivePickerLoading = $state(false);
	// Local folder picker state (Android) now lives in the per-deck device library (PR 3.6).
	let switchingToFavId = $state<string | null>(null); // fav id currently loading
	let browseLongPressTimer: ReturnType<typeof setTimeout> | null = null;
	let longPressHandledFileKey = $state<string | null>(null);

	// ── Filtered browse entries (search by name) ─────────────────
	// Debounce the raw input so filtering doesn't run per keystroke.
	let debouncedSearchQuery = $state('');
	$effect(() => {
		const q = fileSearchQuery;
		const timer = setTimeout(() => { debouncedSearchQuery = q; }, 200);
		return () => clearTimeout(timer);
	});

	// Clear browse selection when the user starts typing a filter query.
	// Filtering is a new browsing context; stale selection state from the
	// unfiltered view blocks upload/download buttons for ALL entries.
	// Only fires on the empty→non-empty transition, not on every keystroke.
	let _lastFilterNonEmpty = $state(false);
	$effect(() => {
		const hasFilter = fileSearchQuery.trim().length > 0;
		if (hasFilter && !_lastFilterNonEmpty && selectedBrowseFileKeys.length > 0) {
			selectedBrowseFileKeys = [];
			mediaEngine.musicSelectionLoopActive = false;
		}
		_lastFilterNonEmpty = hasFilter;
	});

	// Search index: sorted files + lowercase haystacks. Built incrementally
	// across batch loads so sortFiles + parseFilename don't re-run over the
	// entire growing array on every incremental library scan batch.
	let _searchIndexSortedLength = 0;
	let _searchIndexSorted: Array<{ file: StoredAudioFile; haystack: string }> = [];
	$effect(() => {
		const total = allFiles.length;
		if (total === _searchIndexSortedLength) return;
		if (total === 0) {
			_searchIndexSorted = [];
			_searchIndexSortedLength = 0;
			return;
		}
		// On first build or reset, sort the full array; on incremental batches,
		// sort only the new slice and merge (the incoming slice is already sorted
		// within itself from the source, so we benchmark vs full re-sort).
		if (_searchIndexSortedLength === 0) {
			_searchIndexSorted = sortFiles(allFiles).map((f) => {
				const { title, artist } = parseFilename(f.name);
				return { file: f, haystack: `${f.name} ${title} ${artist}`.toLowerCase() };
			});
		} else {
			const newSlice = allFiles.slice(_searchIndexSortedLength);
			const newEntries = sortFiles(newSlice).map((f) => {
				const { title, artist } = parseFilename(f.name);
				return { file: f, haystack: `${f.name} ${title} ${artist}`.toLowerCase() };
			});
			// Merge the pre-sorted index with the new sorted batch
			_searchIndexSorted = mergeSortedIndex(_searchIndexSorted, newEntries);
		}
		_searchIndexSortedLength = total;
	});

	function mergeSortedIndex(
		existing: Array<{ file: StoredAudioFile; haystack: string }>,
		incoming: Array<{ file: StoredAudioFile; haystack: string }>,
	): Array<{ file: StoredAudioFile; haystack: string }> {
		const merged = new Array(existing.length + incoming.length);
		let ei = 0, ii = 0, mi = 0;
		const getKey = (entry: { file: StoredAudioFile }) => {
			if (musicSettings.sortOrder === 'title') return parseFilename(entry.file.name).title;
			if (musicSettings.sortOrder === 'artist') return parseFilename(entry.file.name).artist;
			return entry.file.name;
		};
		while (ei < existing.length && ii < incoming.length) {
			const aKey = getKey(existing[ei]);
			const bKey = getKey(incoming[ii]);
			if (aKey.localeCompare(bKey, undefined, { numeric: true }) <= 0) {
				merged[mi++] = existing[ei++];
			} else {
				merged[mi++] = incoming[ii++];
			}
		}
		while (ei < existing.length) merged[mi++] = existing[ei++];
		while (ii < incoming.length) merged[mi++] = incoming[ii++];
		return merged;
	}

	// Expose the search index as a reactive alias for the filteredEntries derivation
	const searchIndex = $derived(_searchIndexSorted);

	// Cap rendered results — a broad query (e.g. "a") matching thousands of
	// rows explodes the DOM and freezes the UI. In search mode, limit to the
	// first N results. In browse mode (no filter), use CSS content-visibility
	// for automatic viewport-based culling of off-screen rows.
	const SEARCH_RESULT_LIMIT = 300;
	const filteredEntries = $derived.by(() => {
		const query = debouncedSearchQuery.trim().toLowerCase();
		if (query.length === 0) return browseNavigation.browseEntries;

		if (searchIndex.length > 0) {
			const out: BrowseEntry[] = [];
			for (const { file, haystack } of searchIndex) {
				if (haystack.includes(query)) {
					out.push({ kind: 'file', name: file.name, file });
					if (out.length >= SEARCH_RESULT_LIMIT) break;
				}
			}
			return out;
		}
		return browseNavigation.browseEntries.filter(e => e.kind === 'file' && e.name.toLowerCase().includes(query));
	});

	// When browsing without a search filter, cap the rendered DOM at the same
	// limit to keep layout/paint costs bounded even for very large folders.
	// The full list is still available for selection and playback; this only
	// limits what's in the DOM at once.
	const BROWSE_RENDER_LIMIT = 500;
	const renderableEntries = $derived(
		debouncedSearchQuery.trim().length === 0 && filteredEntries.length > BROWSE_RENDER_LIMIT
			? filteredEntries.slice(0, BROWSE_RENDER_LIMIT)
			: filteredEntries
	);
	const entriesRenderCount = $derived(renderableEntries.length);
	const hasMoreEntries = $derived(filteredEntries.length > entriesRenderCount);
	const selectedBrowseCount = $derived(selectedBrowseFileKeys.length);

	// Kick off a full library scan the first time the user searches while the
	// index is empty — without this, global search only sees the current
	// folder because allFiles is only populated by cache restore or manual rescan.
	$effect(() => {
		if (fileSearchQuery.trim().length > 0 && allFiles.length === 0
			&& !deviceLibrary.libraryScanPromise && (deviceLibrary.nativeTreeUri || deviceLibrary.rootDirHandle)) {
			deviceLibrary.startLibraryScan(musicSettings.lastFolderName || 'Library');
		}
	});
	const filteredFavoriteTracks = $derived.by(() => {
		const query = fileSearchQuery.trim().toLowerCase();
		// Guard against corrupt persisted data — favoriteTracks must be an array
		const tracksList = Array.isArray(musicSettings.favoriteTracks) ? musicSettings.favoriteTracks : [];
		const favorites = tracksList.map((favorite) => ({
			favorite,
			file: resolveFavoriteTrackFile(favorite),
		}));

		if (!query) return favorites;

		return favorites.filter(({ favorite }) => {
			const haystack = `${favorite.title} ${favorite.artist} ${favorite.name}`.toLowerCase();
			return haystack.includes(query);
		});
	});
	// ── Drive folder picker dialog: the state and the behaviour live in the per-deck
	//    `createFolderPicker` instance (PR 3.4). `hasRestoredPendingDriveFolderPicker`
	//    stays here because it gates this component's restore effect. ──
	const folderPicker = createFolderPicker({
		driveSession,
		onRestoreBusyFlagsReset: () => {
			driveBusy.isAuthenticating = false;
			driveBusy.isLoading = false;
		},
		confirmDriveFolderSelection
	});
	let hasRestoredPendingDriveFolderPicker = false;

	// ── Web Audio API (lazy-init) ──
	let audioCtx: AudioContext | null = null;
	let eqAvailable = $state(true);  // false if AudioContext creation fails
	let filters: BiquadFilterNode[] = [];

	// ── refs ──
	let folderInputEl: HTMLInputElement;
	let nativeFileInputEl: HTMLInputElement;

	// ── the playback core (ADR-0001) ──
	// One player per deck. It owns the <audio> element, the queue and the
	// advance/preload/retry/loop behaviour; the view supplies the URL adapter, the
	// per-deck element controls and the equalizer hook, and keeps the mediaEngine
	// integration (exclusivity, MediaSession, deck metadata) around it.
	const player = createPlayer({
		settings: musicSettings,
		resolveUrl: resolveTrackUrl,
		controls: {
			// Deck A always plays at full volume; Deck B has its own volume and speed.
			get volume() { return effectiveVolume; },
			get muted() { return musicSettings.isMuted; },
			get playbackRate() { return effectiveSpeed; },
		},
		native: isNativeApp,
		applyEqualizer: attachEqualizer,
		onBeforeAdvance: () => { syncLoopTracksToSelection(); },
		// The MiniPlayer toggles the loop without touching the queue, so the module
		// reads the live flag for advance/repeat-one decisions.
		isSelectionLoop: () => mediaEngine.musicSelectionLoopActive,
	});

	// ── Device library: the logic lives in the per-deck `createDeviceLibrary`
	//    factory (PR 3.6). It owns the device-side state the moved functions drive
	//    (`libraryScanPromise`, `rootDirHandle`, `nativeTreeUri`, `pendingHandle`,
	//    `scanProgress`, `trackListLockedByUser`, `deckFolderLabel` and the Android
	//    local-picker fields) and reads or writes everything else through the
	//    injected `view` accessor below. ──
	const deviceLibrary: DeviceLibrary = createDeviceLibrary({
		driveSession,
		view: {
			get allFiles() { return allFiles; },
			set allFiles(v) { allFiles = v; },
			get browsePath() { return browsePath; },
			set browsePath(v) { browsePath = v; },
			get showQueue() { return showQueue; },
			set showQueue(v) { showQueue = v; },
			get isLoading() { return isLoading; },
			set isLoading(v) { isLoading = v; },
			get driveSearch() { return driveSearch; },
			set driveSearch(v) { driveSearch = v; },
			get transferFile() { return transferFile; },
			set transferFile(v) { transferFile = v; },
			get transferDirection() { return transferDirection; },
			set transferDirection(v) { transferDirection = v; },
			get isTransferring() { return isTransferring; },
			set isTransferring(v) { isTransferring = v; },
			get transferProgress() { return transferProgress; },
			set transferProgress(v) { transferProgress = v; },
			get transferPhase() { return transferPhase; },
			set transferPhase(v) { transferPhase = v; },
			get showLocalFolderPicker() { return showLocalFolderPicker; },
			set showLocalFolderPicker(v) { showLocalFolderPicker = v; },
			get isFileOpRunning() { return isFileOpRunning; },
			get pendingFileOp() { return pendingFileOp; },
		},
		isNativeApp,
		getFolderInputEl: () => folderInputEl,
		getNativeFileInputEl: () => nativeFileInputEl,
		bumpBrowseVersion: () => { browseVersion += 1; },
		hydrateTracksFromLibrary,
		runPendingFileOp: (destination) => runPendingFileOp(destination),
		refreshDriveLibrary: () => driveLibrary.refreshGoogleDrive(),
	});

	// ── Drive library: the logic lives in the per-deck `createDriveLibrary`
	//    factory (PR 3.5). The module is a rune-free `.ts`, so this view allocates
	//    the reactive `driveBusy` bag and passes an accessor for every piece of
	//    view state the module reads or writes. ──
	const driveLibraryView: DriveLibraryView = {
		get libraryScanPromise() { return deviceLibrary.libraryScanPromise; },
		set libraryScanPromise(v) { deviceLibrary.libraryScanPromise = v; },
		get rootDirHandle() { return deviceLibrary.rootDirHandle; },
		set rootDirHandle(v) { deviceLibrary.rootDirHandle = v; },
		get nativeTreeUri() { return deviceLibrary.nativeTreeUri; },
		set nativeTreeUri(v) { deviceLibrary.nativeTreeUri = v; },
		get pendingHandle() { return deviceLibrary.pendingHandle; },
		set pendingHandle(v) { deviceLibrary.pendingHandle = v; },
		get browsePath() { return browsePath; },
		set browsePath(v) { browsePath = v; },
		get showQueue() { return showQueue; },
		set showQueue(v) { showQueue = v; },
		get showPanel() { return showPanel; },
		set showPanel(v) { showPanel = v; },
		get allFiles() { return allFiles; },
		set allFiles(v) { allFiles = v; },
		get switchingToFavId() { return switchingToFavId; },
		set switchingToFavId(v) { switchingToFavId = v; },
		get drivePickerLoading() { return drivePickerLoading; },
		set drivePickerLoading(v) { drivePickerLoading = v; },
		get drivePickerFolders() { return drivePickerFolders; },
		set drivePickerFolders(v) { drivePickerFolders = v; },
		get showDriveFolderPicker() { return showDriveFolderPicker; },
		set showDriveFolderPicker(v) { showDriveFolderPicker = v; },
		get transferFile() { return transferFile; },
		set transferFile(v) { transferFile = v; },
		get transferDirection() { return transferDirection; },
		set transferDirection(v) { transferDirection = v; },
		get isTransferring() { return isTransferring; },
		set isTransferring(v) { isTransferring = v; },
		get isFileOpRunning() { return isFileOpRunning; },
		set isFileOpRunning(v) { isFileOpRunning = v; },
	};

	const driveLibrary = createDriveLibrary({
		driveSession,
		folderPicker,
		busy: driveBusy,
		view: driveLibraryView,
		clearPlayer: () => player.clear(),
		bumpBrowseVersion: () => { browseVersion += 1; },
		activateDeviceLibrary: (folderName) => deviceLibrary.activateDeviceLibrary(folderName),
		confirmDriveFolderSelection,
		hydrateTracksFromLibrary,
	});

	// ── Browse navigation: the logic lives in the per-deck
	//    `createBrowseNavigation` factory (PR 3.7). It owns `browseEntries`, the
	//    `browseLoading` flag and the per-instance load-id counter; `browsePath`,
	//    `fileSearchQuery` and `selectedBrowseFileKeys` stay in the view and
	//    arrive through the accessor. It reads the device library's scan promise
	//    and handles so the loader's live-listing branch is unchanged. ──
	const browseNavigation: BrowseNavigation = createBrowseNavigation({
		deviceLibrary,
		view: {
			get allFiles() { return allFiles; },
			get browsePath() { return browsePath; },
			set browsePath(v) { browsePath = v; },
			get fileSearchQuery() { return fileSearchQuery; },
			set fileSearchQuery(v) { fileSearchQuery = v; },
			get selectedBrowseFileKeys() { return selectedBrowseFileKeys; },
			set selectedBrowseFileKeys(v) { selectedBrowseFileKeys = v; },
		},
	});

	// ── derived ──
	const tracks       = $derived(player.state.tracks);
	const currentTime  = $derived(player.state.currentTime);
	const duration     = $derived(player.state.duration);
	const isPlaying    = $derived(player.state.isPlaying);
	const isBuffering  = $derived(player.state.isBuffering);
	const currentTrack    = $derived(tracks[musicSettings.lastTrackIndex] as PlayerTrack | undefined);
	const currentTrackIsFavorite = $derived(currentTrack ? isFavoriteTrack(currentTrack.source) : false);
	const currentMusicTrackKey = $derived(
		musicSettings.lastTrackKey || (currentTrack ? getStoredFileKey(currentTrack.source) : '')
	);

	const hasFolderLoaded = $derived(deviceLibrary.rootDirHandle !== null || deviceLibrary.nativeTreeUri !== null || allFiles.length > 0);
	const currentLibraryLabel = $derived(
		musicSettings.librarySource === 'drive' ? 'Google Drive' : deviceLibrary.deckFolderLabel
	);

	// ── register stop-callback for cross-view audio exclusivity ──
	$effect(() => {
		if (musicSettings.lastTrackTimestamp !== 0) {
			musicSettings.lastTrackTimestamp = 0;
		}
	});

	$effect(() => {
		const srcId = deck === 'A' ? 'musicA' as const : 'musicB' as const;
		registerAudioSource(srcId, () => {
			// Fully reset so the browser releases the audio channel —
			// pause() alone can leave residual decoder state that
			// causes brief overlap when a new source starts immediately.
			player.stop();
		});
	});

	$effect(() => {
		// Lets the MiniPlayer (which lives at the shell level) pull the music view
		// back out of the file browser. Switching tabs is a no-op when the Music
		// tab is already active, so "Return to music player" needs this.
		return registerMusicPlayerView(() => {
			showQueue = false;
		});
	});

	// Keep mediaEngine.musicHasSelectedTracks in sync so MiniPlayer can show the loop toggle
	$effect(() => {
		mediaEngine.musicHasSelectedTracks = selectedBrowseFileKeys.length > 0;
	});

	// When MiniPlayer clears loop selection, clear local selection state too
	$effect(() => {
		const loopActive = mediaEngine.musicSelectionLoopActive;
		const hasTracks = mediaEngine.musicHasSelectedTracks;
		if (!loopActive && !hasTracks && selectedBrowseFileKeys.length > 0) {
			selectedBrowseFileKeys = [];
		}
	});

	function claimMusicControls() {
		if (typeof mediaEngine.setPlaybackHandlers === 'function') {
			mediaEngine.setPlaybackHandlers(
				() => { void resumePlayback(); },
				() => { pausePlayback(); },
				(seconds) => { handleSeekSeconds(seconds); }
			);
		}

		if (typeof mediaEngine.setSkipHandlers === 'function') {
			mediaEngine.setSkipHandlers(
				() => { skipNext(); },
				() => { skipPrev(); }
			);
		}
	}

	// ── Always push per-deck state to the engine so the MiniPlayer can
	//     show the correct track/time/progress for whichever deck is active,
	//     even when both decks play simultaneously. The global `item`/
	//     `currentTime`/`duration` are also set when this deck is the active
	//     one (and podcast/radio aren't playing), so MediaSession and native
	//     controls still work. ──
	$effect(() => {
		const isActiveDeck = mediaEngine.activeMusicDeck === deck;
		const isMusicTab = activeTab === 'music';
		const musicOwnsDisplay = !mediaEngine.podcastPlaying && !mediaEngine.radioPlaying;

		// Always push per-deck metadata — even when NOT the active deck —
		// so that deck-switching in the MiniPlayer immediately shows the
		// right track info without waiting for a re-render.
		if (deck === 'A') {
			mediaEngine.deckAItem = currentTrack ? {
				id:         String(currentTrack.id),
				source:     'music' as const,
				title:      currentTrack.title,
				subtitle:   currentTrack.artist,
				audioUrl:   '',
				artworkUrl: undefined,
				duration:   currentTrack.duration > 0 ? currentTrack.duration : undefined,
			} : null;
			mediaEngine.deckACurrentTime = untrack(() => player.state.currentTime);
			mediaEngine.deckADuration = untrack(() => player.state.duration) || (currentTrack?.duration ?? 0);
			mediaEngine.deckABuffering = isBuffering;
		} else {
			mediaEngine.deckBItem = currentTrack ? {
				id:         String(currentTrack.id),
				source:     'music' as const,
				title:      currentTrack.title,
				subtitle:   currentTrack.artist,
				audioUrl:   '',
				artworkUrl: undefined,
				duration:   currentTrack.duration > 0 ? currentTrack.duration : undefined,
			} : null;
			mediaEngine.deckBCurrentTime = untrack(() => player.state.currentTime);
			mediaEngine.deckBDuration = untrack(() => player.state.duration) || (currentTrack?.duration ?? 0);
			mediaEngine.deckBBuffering = isBuffering;
		}

		// Mirror the deck's playing state into the engine's per-deck flag, the way
		// the element's own play/pause events used to. Deliberately not gated on
		// this deck owning the display: a deck that stops while another source owns
		// the MiniPlayer (cross-source claim, track end) must still clear its flag,
		// or the engine reports "playing" forever and holds the wakelock.
		if (deck === 'A') {
			mediaEngine.musicPlayingA = isPlaying;
		} else {
			mediaEngine.musicPlayingB = isPlaying;
		}

		// When this deck is active + music tab + music owns the display,
		// also push to global state so that MediaSession + native controls work.
		if (isActiveDeck && isMusicTab && musicOwnsDisplay) {
			claimMusicControls();
			if (currentTrack) {
				mediaEngine.setNowPlaying({
					id:         String(currentTrack.id),
					source:     'music',
					title:      currentTrack.title,
					subtitle:   currentTrack.artist,
					audioUrl:   '',
					artworkUrl: undefined,
					duration:   currentTrack.duration > 0 ? currentTrack.duration : undefined,
				}, 'music');
				mediaEngine.updateTime(
					untrack(() => player.state.currentTime),
					untrack(() => player.state.duration) || (currentTrack.duration ?? 0)
				);
			}
		}
	});

	// ── Progress to the engine. This replaces the forwarding the view used to do
	//     from the audio element's `timeupdate` event: the module throttles
	//     `state.currentTime` to ~4Hz, which is what keeps the MiniPlayer seek bar,
	//     MediaSession progress and the native notification in step. ──
	$effect(() => {
		const time = player.state.currentTime;
		const total = player.state.duration;
		if (deck === 'A') {
			mediaEngine.deckACurrentTime = time;
			mediaEngine.deckADuration = total;
		} else {
			mediaEngine.deckBCurrentTime = time;
			mediaEngine.deckBDuration = total;
		}
		// Only push global progress when music owns the MiniPlayer display.
		if (mediaEngine.activeMusicDeck === deck && mediaEngine.source === 'music') {
			mediaEngine.updateTime(time, total);
		}
	});

	// MediaSession play/pause/seek handlers are managed by mediaEngine directly.

	function syncTrackToMediaEngine(index: number) {
		const track = tracks[index];
		if (!track) return;
		const item: MediaItem = {
			id:         String(track.id),
			source:     'music',
			title:      track.title,
			subtitle:   track.artist,
			audioUrl:   '',
			artworkUrl: undefined,
			duration:   track.duration > 0 ? track.duration : undefined,
		};
		// Push per-deck metadata so MiniPlayer shows correct track on switch
		if (deck === 'A') {
			mediaEngine.deckAItem = item;
		} else {
			mediaEngine.deckBItem = item;
		}
		mediaEngine.setNowPlaying(item, 'music');
		claimMusicControls();
	}

	// ── reload browse entries when path or folder version changes ──
	$effect(() => {
		const path = [...browsePath];
		const driveFilter = driveSearch.trim().toLowerCase();
		browseVersion; // reactive dependency
		musicSettings.librarySource;
		void browseNavigation.loadBrowseEntries(path, driveFilter);
	});

	$effect(() => {
		// Prune selected keys only when the file no longer exists in the
		// library index (allFiles). Pruning against the current folder alone
		// instantly deselected tracks picked from global search results
		// (they live in other folders) and killed the loop when navigating.
		// Before the index is built, fall back to the current folder view.
		const availableSource = allFiles.length > 0
			? allFiles
			: getCurrentBrowseFileEntries().map((entry) => entry.file);
		const availableBrowseFileKeys = new Set(availableSource.map((file) => getStoredFileKey(file)));
		const nextSelectedKeys = selectedBrowseFileKeys.filter((key) => availableBrowseFileKeys.has(key));
		const hasSelectionChanged =
			nextSelectedKeys.length !== selectedBrowseFileKeys.length ||
			nextSelectedKeys.some((key, index) => key !== selectedBrowseFileKeys[index]);

		if (hasSelectionChanged) {
			selectedBrowseFileKeys = nextSelectedKeys;
		}
	});

	$effect(() => {
		return () => clearBrowseLongPressTimer();
	});

	// ── Auto-save to Drive when key music settings change ──
	$effect(() => {
		// Access reactive fields so Svelte tracks them
		void musicSettings.driveFolderId;
		void musicSettings.driveFolderName;
		void musicSettings.favoriteFolders;
		void musicSettings.deckASpeed;
		void musicSettings.deckBSpeed;
		void musicSettings.equalizerPreset;
		void musicSettings.sortOrder;
	});

	// ── Sync EQ gains ──
	$effect(() => {
		// Explicitly track eqBands array for reactivity
		void musicSettings.eqBands.length;
		applyEqGains(filters, musicSettings.eqBands);
	});

	// ─────────────────────────────────────────────────────────────
	// Web Audio API
	// ─────────────────────────────────────────────────────────────
	function initAudioContext() {
		if (!eqAvailable) return;
		if (audioCtx) { if (audioCtx.state === 'suspended') audioCtx.resume(); return; }
		try {
			const ctx = new AudioContext();
			void ctx.resume();
			audioCtx = ctx;
		} catch (e) {
			eqAvailable = false;
			addToast({ message: 'Equalizer not available on this device.', type: 'warning' });
			console.warn('AudioContext creation failed:', e);
		}
	}

	/** Equalizer hook for the player module. The module owns the <audio> element and
	 *  calls this immediately before it points the element at a new URL —
	 *  createMediaElementSource must be connected before the element starts loading,
	 *  or it fails on Android WebView. Runs once per deck element. */
	function attachEqualizer(audio: HTMLAudioElement) {
		initAudioContext();
		if (!audioCtx || filters.length > 0) return;
		try {
			const source = audioCtx.createMediaElementSource(audio);
			const bands = createEqFilterChain(audioCtx, musicSettings.eqBands);
			source.connect(bands[0]);
			bands[bands.length - 1].connect(audioCtx.destination);
			filters = bands;
		} catch (e) {
			eqAvailable = false;
			addToast({ message: 'Equalizer not available on this device.', type: 'warning' });
			console.warn('Equalizer hookup failed:', e);
		}
	}

	// ─────────────────────────────────────────────────────────────
	// EQ helpers
	// ─────────────────────────────────────────────────────────────
	function applyEqPreset(preset: string) {
		const gains = EQ_PRESETS[preset]; if (!gains) return;
		musicSettings.eqBands = [...gains];
		musicSettings.equalizerPreset = preset as typeof musicSettings.equalizerPreset;
	}
	function setEqBand(index: number, value: number) {
		const next = [...musicSettings.eqBands]; next[index] = value;
		musicSettings.eqBands = next;
		musicSettings.equalizerPreset = 'custom';
	}
	/** Apply a band change live while dragging, without touching the persisted
	 *  musicSettings store (which would JSON.stringify the whole blob on every
	 *  tick and re-run the EQ reactivity effect per input). The single commit
	 *  lands via setEqBand on drag release. */
	function setEqBandLive(index: number, value: number) {
		if (filters.length === 0) return;
		const next = [...musicSettings.eqBands]; next[index] = value;
		applyEqGains(filters, next);
	}

	// ─────────────────────────────────────────────────────────────
	// General helpers
	// ─────────────────────────────────────────────────────────────
	function sortFiles(files: StoredAudioFile[]): StoredAudioFile[] {
		return sortStoredFiles(files, musicSettings.sortOrder);
	}

	function createFavoriteTrack(file: StoredAudioFile): FavoriteTrack {
		const parsed = parseFilename(file.name);
		// `source` is added per branch so TS keeps the discriminant narrow —
		// spreading file.source here would widen it to the whole union and no
		// longer match any FavoriteTrack member.
		const baseFavorite = {
			key: getStoredFileKey(file),
			name: file.name,
			title: parsed.title,
			artist: parsed.artist,
			relativePath: getRelativePath(file),
		};

		if (file.source === 'native') {
			return {
				...baseFavorite,
				source: 'native',
				path: file.path,
				mimeType: file.mimeType,
				modifiedAt: file.modifiedAt,
			};
		}

		if (file.source === 'drive') {
			return {
				...baseFavorite,
				source: 'drive',
				fileId: file.fileId,
				mimeType: file.mimeType,
				modifiedAt: file.modifiedAt,
				sizeBytes: file.sizeBytes,
				webViewLink: file.webViewLink,
			};
		}

		return { ...baseFavorite, source: 'web' };
	}

	function resolveFavoriteTrackFile(favorite: FavoriteTrack): StoredAudioFile | null {
		const loadedFile = allFiles.find((file) => getStoredFileKey(file) === favorite.key)
			?? tracks.find((track) => getStoredFileKey(track.source) === favorite.key)?.source;
		if (loadedFile) return loadedFile;

		if (favorite.source === 'native' && favorite.path) {
			return {
				source: 'native',
				name: favorite.name,
				relativePath: favorite.relativePath,
				path: favorite.path,
				mimeType: favorite.mimeType,
				modifiedAt: favorite.modifiedAt,
			};
		}

		if (favorite.source === 'drive' && favorite.fileId) {
			return {
				source: 'drive',
				name: favorite.name,
				relativePath: favorite.relativePath,
				fileId: favorite.fileId,
				mimeType: favorite.mimeType,
				modifiedAt: favorite.modifiedAt,
				sizeBytes: favorite.sizeBytes,
				webViewLink: favorite.webViewLink,
			};
		}

		return null;
	}

	function isFavoriteTrack(file: StoredAudioFile): boolean {
		const key = getStoredFileKey(file);
		return Array.isArray(musicSettings.favoriteTracks)
			? musicSettings.favoriteTracks.some((favorite) => favorite.key === key)
			: false;
	}

	function toggleFavoriteTrack(file: StoredAudioFile): void {
		const favorite = createFavoriteTrack(file);
		const current = Array.isArray(musicSettings.favoriteTracks) ? musicSettings.favoriteTracks : [];
		const exists = current.some((entry) => entry.key === favorite.key);
		musicSettings.favoriteTracks = exists
			? current.filter((entry) => entry.key !== favorite.key)
			: [...current, favorite];
	}

	function removeFavoriteTrack(key: string): void {
		const current = Array.isArray(musicSettings.favoriteTracks) ? musicSettings.favoriteTracks : [];
		musicSettings.favoriteTracks = current.filter((favorite) => favorite.key !== key);
	}

	function getResolvedFavoriteTrackFiles(): StoredAudioFile[] {
		const seen = new Set<string>();
		const files: StoredAudioFile[] = [];

		const favorites = Array.isArray(musicSettings.favoriteTracks) ? musicSettings.favoriteTracks : [];
		for (const favorite of favorites) {
			const file = resolveFavoriteTrackFile(favorite);
			if (!file) continue;
			const key = getStoredFileKey(file);
			if (seen.has(key)) continue;
			seen.add(key);
			files.push(file);
		}

		return files;
	}

	function clearBrowseLongPressTimer() {
		if (browseLongPressTimer !== null) {
			clearTimeout(browseLongPressTimer);
			browseLongPressTimer = null;
		}
	}

	function isBrowseFileSelected(file: StoredAudioFile): boolean {
		return selectedBrowseFileKeys.includes(getStoredFileKey(file));
	}

	function toggleBrowseFileSelection(file: StoredAudioFile) {
		const key = getStoredFileKey(file);
		const wasSelected = isBrowseFileSelected(file);
		selectedBrowseFileKeys = wasSelected
			? selectedBrowseFileKeys.filter((currentKey) => currentKey !== key)
			: [...selectedBrowseFileKeys, key];

		// When nothing is playing, keep the loop queue instantly in sync
		// with the selection so the MiniPlayer and notification always
		// reflect the current loop state without needing to press play.
		if (!mediaEngine.isPlaying) {
			if (selectedBrowseFileKeys.length > 0) {
				preloadLoopSelection();
			} else {
				clearBrowseSelection();
				mediaEngine.clear();
			}
		} else if (selectedBrowseFileKeys.length > 0) {
			// Other deck is playing — can't preload, but mark the loop as
			// active so the MiniPlayer toggle shows the correct state.
			mediaEngine.musicSelectionLoopActive = true;
		} else {
			// All selections cleared while other deck is playing
			mediaEngine.musicSelectionLoopActive = false;
		}
	}

	/** Load selected tracks into the queue without starting playback.
	 *  Hands the queue to the module and updates the mediaEngine item and
	 *  musicSelectionLoopActive so the MiniPlayer and media notification show the
	 *  loaded track immediately. */
	function preloadLoopSelection() {
		const selectedFiles = getSelectedBrowseFilesInOrder();
		if (selectedFiles.length === 0) return;
		const label = browsePath.length > 0 ? browsePath[browsePath.length - 1] : musicSettings.lastFolderName;
		beginQueue(label, { selectionLoop: true });
		player.clear();
		player.load(selectedFiles, { selectionLoop: true, startIndex: 0 });
		syncTrackToMediaEngine(0);
	}

	function clearBrowseSelection() {
		selectedBrowseFileKeys = [];
		mediaEngine.musicSelectionLoopActive = false;
	}

	async function playFavoriteTrack(favorite: FavoriteTrack) {
		if (isChangingTrack) return;

		// A YouTube favorite has no file to resolve, and its stream URL is
		// short-lived and IP-bound, so it can never join the music deck queue.
		// Hand off to the YouTube panel, which re-resolves and owns that audio.
		if (isYoutubeFavorite(favorite)) {
			openYoutubePanel(favorite.videoId);
			return;
		}

		const resolvedTrack = resolveFavoriteTrackFile(favorite);
		if (!resolvedTrack) {
			addToast({ message: 'This favorite track is not available in the current library.', type: 'warning' });
			return;
		}

		initAudioContext();
		isChangingTrack = true;
		try {
			const files = getResolvedFavoriteTrackFiles();
			if (files.length === 0) {
				addToast({ message: 'No favorite tracks are currently available.', type: 'warning' });
				return;
			}

			// Load tracks in display order (not sorted), so playback follows
			// the same order the user sees in the favorites list.
			const nextIndex = files.findIndex((file) => getStoredFileKey(file) === favorite.key);
			beginQueue('Favorite Tracks');
			await startPlayback(files, Math.max(0, nextIndex), { preserveOrder: true });
		} finally {
			isChangingTrack = false;
		}
	}

	function getCurrentBrowseFileEntries(): (BrowseEntry & { kind: 'file' })[] {
		return browseNavigation.browseEntries.filter((entry): entry is BrowseEntry & { kind: 'file' } => entry.kind === 'file');
	}

	function getSelectedBrowseFilesInOrder(): StoredAudioFile[] {
		if (selectedBrowseFileKeys.length === 0) return [];
		// Resolve keys against the whole library index first so selections
		// made from global search results (files in other folders) resolve;
		// current folder entries override for freshest metadata.
		const fileByKey = new Map<string, StoredAudioFile>();
		for (const file of allFiles) fileByKey.set(getStoredFileKey(file), file);
		for (const entry of getCurrentBrowseFileEntries()) {
			fileByKey.set(getStoredFileKey(entry.file), entry.file);
		}
		const selectedFiles: StoredAudioFile[] = [];
		for (const key of selectedBrowseFileKeys) {
			const file = fileByKey.get(key);
			if (file) selectedFiles.push(file);
		}
		return selectedFiles;
	}

	function getBrowsePlaybackFiles(): { files: StoredAudioFile[]; selectionLoop: boolean } {
		const selectedFiles = getSelectedBrowseFilesInOrder();
		if (selectedFiles.length > 0) {
			return { files: selectedFiles, selectionLoop: true };
		}

		// When a search filter is active, the visible list IS the queue —
		// tapping a result must play that file, and next/prev moves through
		// the search results. Building the queue from the current folder
		// here made findIndex miss (result lives in another folder) and
		// fall back to index 0 — the "wrong track plays when filtered" bug.
		if (debouncedSearchQuery.trim().length > 0) {
			return {
				files: filteredEntries
					.filter((entry): entry is BrowseEntry & { kind: 'file' } => entry.kind === 'file')
					.map((entry) => entry.file),
				selectionLoop: false,
			};
		}

		return {
			files: getCurrentBrowseFileEntries().map((entry) => entry.file),
			selectionLoop: false,
		};
	}

	function handleBrowseFilePressStart(entry: BrowseEntry & { kind: 'file' }, event: PointerEvent) {
		if (event.button !== 0) return;
		clearBrowseLongPressTimer();
		const fileKey = getStoredFileKey(entry.file);
		browseLongPressTimer = setTimeout(() => {
			longPressHandledFileKey = fileKey;
			toggleBrowseFileSelection(entry.file);
			browseLongPressTimer = null;
		}, BROWSE_LONG_PRESS_MS);
	}

	function handleBrowseFilePressEnd() {
		clearBrowseLongPressTimer();
	}

	async function confirmDriveFolderSelection(folderId?: string, folderName?: string) {
		folderPicker.showFolderPicker = false;
		clearPendingDriveFolderPickerIntent();
		musicSettings.driveFolderId = folderId ?? '';
		musicSettings.driveFolderName = folderName ?? '';
		// Switch to drive source immediately so the restoration $effect doesn't
		// re-hydrate the device library during async pauses inside finishDriveLoad.
		musicSettings.librarySource = 'drive';
		deviceLibrary.rootDirHandle = null;
		deviceLibrary.nativeTreeUri = null;
		deviceLibrary.libraryScanPromise = null;
		const token = folderPicker.folderPickerToken;
		folderPicker.folderPickerToken = '';
		await driveLibrary.finishDriveLoad(token, folderId);
	}

	/**
	 * URL seam for the player module: turn a stored file into something the audio
	 * element can play. Native files use the Capacitor bridge URL, everything else
	 * is materialized to a File and exposed as an object URL with a cleanup path.
	 */
	async function resolveTrackUrl(source: StoredAudioFile, interactiveAuth = false): Promise<string | null> {
		// Progress is only reported for the track the listener asked for. The module
		// also materializes the *next* track in the background, and the player view
		// shows a "Loading track…" overlay whenever progress is set.
		const isForeground = player.state.tracks[player.state.currentIndex]?.source === source;

		// Fast path for native files: Capacitor converts content:// / file:// paths to a local
		// HTTP bridge URL (http://localhost/_capacitor_content_/... or _capacitor_file_/...).
		// The audio element streams the file progressively via range requests — no need to read
		// the entire file into memory before playback can start.
		if (isNativeApp && source.source === 'native') {
			const bridgeUrl = Capacitor.convertFileSrc(source.path);
			// convertFileSrc returns the original string unchanged if it cannot convert the scheme.
			// Only use the bridge URL when Capacitor actually transformed it.
			if (bridgeUrl !== source.path) {
				return bridgeUrl;
			}
		}

		try {
			const file = await driveLibrary.materializeStoredFile(
				source,
				interactiveAuth,
				isForeground ? (loaded, total) => { trackLoadProgress = { loaded, total }; } : undefined
			);
			const url = URL.createObjectURL(file);
			// Re-look-up the queued track by source identity after the await. A queue
			// replacement (play/load/clear) can land while the file materializes, but
			// so can a rebuild that keeps the source (append on a folder scan,
			// syncLoopTracksToSelection re-queueing the selection): both rebuild the
			// PlayerTrack wrappers while preserving the underlying source objects, so
			// wrapper identity is not stable and source identity is. No live entry
			// means the source is no longer queued, so revoke the URL rather than
			// orphan it.
			const live = player.state.tracks.find((entry) => entry.source === source);
			if (!live) {
				URL.revokeObjectURL(url);
				return null;
			}
			// Hand the revocation path to the module through the live track's
			// `cleanup` field: the module calls it when it releases the URL.
			live.cleanup = () => URL.revokeObjectURL(url);
			return url;
		} catch (error) {
			console.error('Failed to prepare track for playback.', error);
			const msg = error instanceof Error ? error.message : 'Failed to load track.';
			addToast({ message: msg, type: 'error' });
			return null;
		} finally {
			if (isForeground) trackLoadProgress = null;
		}
	}

	// ─────────────────────────────────────────────────────────────
	// Queue hand-off to the player module (ADR-0001)
	// ─────────────────────────────────────────────────────────────
	/** Per-queue bookkeeping the module cannot know about: the session guard that
	 *  stops a still-streaming folder scan from appending to a replaced queue, the
	 *  folder label, the selection-loop flag and the user-picked-queue lock. */
	function beginQueue(folder: string, options: { selectionLoop?: boolean } = {}) {
		queueSessionId += 1;
		musicSettings.lastFolderName = folder;
			deviceLibrary.trackListLockedByUser = true;
		mediaEngine.musicSelectionLoopActive = options.selectionLoop ?? false;
	}

	/** Hand a queue to the module and start it at `index`. The queue stays loaded
	 *  (stopped) when the track's URL cannot be materialized. */
	async function startPlayback(
		files: StoredAudioFile[],
		index: number,
		options: { selectionLoop?: boolean; preserveOrder?: boolean; suppressAlert?: boolean } = {}
	): Promise<boolean> {
		if (files.length === 0) return false;
		await player.play(files, index, {
			selectionLoop: options.selectionLoop,
			preserveOrder: options.preserveOrder,
		});
		if (player.state.error) {
			if (!options.suppressAlert) alert('Unable to load this track.');
			return false;
		}

		syncTrackToMediaEngine(player.state.currentIndex);

		// Set the playing flag BEFORE claimAudio.
		const deckFlag = deck === 'A' ? 'musicPlayingA' as const : 'musicPlayingB' as const;
		mediaEngine[deckFlag] = true;

		claimAudio(deck === 'A' ? 'musicA' : 'musicB');
		return true;
	}

	/** Start the first track of the queue whose URL can be materialized, the way a
	 *  folder play does: broken files at the head must not stop the queue. */
	async function startFirstPlayableTrack(
		files: StoredAudioFile[],
		options: { selectionLoop?: boolean } = {}
	): Promise<boolean> {
		for (let index = 0; index < files.length; index += 1) {
			if (await startPlayback(files, index, { ...options, suppressAlert: true })) return true;
		}
		return false;
	}

	function appendTracksToQueue(files: StoredAudioFile[], folder: string, expectedQueueSessionId: number) {
		if (files.length === 0 || queueSessionId !== expectedQueueSessionId) return;
		player.append(files);
		musicSettings.lastFolderName = folder;
	}

	// ─────────────────────────────────────────────────────────────
	// Browse interactions
	// ─────────────────────────────────────────────────────────────

	async function playNativeFolderFromScan(path: string[], folderLabel: string): Promise<boolean> {
		if (!deviceLibrary.nativeTreeUri) return false;

		let playbackStarted = false;
		let hasResolvedStart = false;
		let activePlaybackQueueSessionId = queueSessionId;
		let queuedFileCount = 0;
		let resolveStart: ((value: boolean) => void) | null = null;
		const startPromise = new Promise<boolean>((resolve) => {
			resolveStart = resolve;
		});

		const collectedFiles: StoredAudioFile[] = [];
		void scanNativeAudioFiles(
			deviceLibrary.nativeTreeUri,
			path,
			FOLDER_PLAY_SCAN_BATCH_SIZE,
			{ initialBatchSize: FOLDER_PLAY_INITIAL_BATCH_SIZE },
			async (mappedBatch, state) => {
			const mergedFiles = mergeStoredFiles(collectedFiles, mappedBatch);
			if (mergedFiles.length === collectedFiles.length) return;
			collectedFiles.splice(0, collectedFiles.length, ...mergedFiles);

			if (!playbackStarted) {
				if (collectedFiles.length < FOLDER_PLAY_PRIME_COUNT && !state.done) return;
				beginQueue(folderLabel);
				activePlaybackQueueSessionId = queueSessionId;
				queuedFileCount = collectedFiles.length;
				playbackStarted = await startFirstPlayableTrack(collectedFiles);
				if (playbackStarted && !hasResolvedStart) {
					hasResolvedStart = true;
					resolveStart?.(true);
				}
				return;
			}

			const pendingQueueGrowth = collectedFiles.length - queuedFileCount;
			if (pendingQueueGrowth < FOLDER_PLAY_QUEUE_FLUSH_SIZE && !state.done) {
				return;
			}

			appendTracksToQueue(
				collectedFiles.slice(queuedFileCount),
				folderLabel,
				activePlaybackQueueSessionId
			);
			queuedFileCount = collectedFiles.length;
		}).then(async () => {
			if (!playbackStarted && collectedFiles.length > 0) {
				beginQueue(folderLabel);
				activePlaybackQueueSessionId = queueSessionId;
				queuedFileCount = collectedFiles.length;
				playbackStarted = await startFirstPlayableTrack(collectedFiles);
			}
			if (playbackStarted && collectedFiles.length > queuedFileCount) {
				appendTracksToQueue(
					collectedFiles.slice(queuedFileCount),
					folderLabel,
					activePlaybackQueueSessionId
				);
				queuedFileCount = collectedFiles.length;
			}
			if (path.length === 0 && collectedFiles.length > 0) {
				allFiles = collectedFiles;
				browseVersion += 1;
				await saveCachedLibrary(deviceLibrary.nativeTreeUri, folderLabel, collectedFiles);
			}
			if (!hasResolvedStart) {
				hasResolvedStart = true;
				resolveStart?.(playbackStarted);
			}
		}).catch((error) => {
			console.error('Failed to scan folder for playback.', error);
			if (!hasResolvedStart) {
				hasResolvedStart = true;
				resolveStart?.(false);
			}
		});

		return startPromise;
	}

	// Play a single file → load all siblings as context
	async function playBrowseFile(entry: BrowseEntry & { kind: 'file' }) {
		if (isChangingTrack) return;
		// Unlock / resume the AudioContext while still within the user gesture.
		// playFolderPath does the same — without this, initAudioContext called later
		// (after awaits) may create a suspended context that silently mutes audio.
		initAudioContext();
		isChangingTrack = true;
		try {
			const { files, selectionLoop } = getBrowsePlaybackFiles();
			beginQueue(
				browsePath.length > 0 ? browsePath[browsePath.length - 1] : musicSettings.lastFolderName,
				{ selectionLoop }
			);
			const sorted = sortFiles(files);
			const entryKey = getStoredFileKey(entry.file);
			const idx = sorted.findIndex((file) => getStoredFileKey(file) === entryKey);
			await startPlayback(files, Math.max(0, idx), { selectionLoop });
		} finally {
			isChangingTrack = false;
		}
	}

	// Play only the files visible in the current folder view (no recursion)
	async function playCurrentFolder() {
		if (isChangingTrack) return;
		const { files, selectionLoop } = getBrowsePlaybackFiles();
		if (files.length === 0) { alert('No MP3 files found.'); return; }
		const label = browsePath.length > 0 ? browsePath[browsePath.length - 1] : (musicSettings.lastFolderName || 'Library');
		isLoading = true;
		isChangingTrack = true;
		try {
			beginQueue(label, { selectionLoop });
			if (!(await startFirstPlayableTrack(files, { selectionLoop }))) {
				alert('No playable audio files were found in this folder.');
			}
		} catch (e) {
			console.error('Failed to play folder:', e);
		} finally {
			isLoading = false;
			isChangingTrack = false;
		}
	}

	// Play all files under a given browse path (recursively)
	async function playFolderPath(path: string[]) {
		if (isChangingTrack) return;
		isChangingTrack = true;
		const folderKey = path.join('/');
		const folderLabel = path.length > 0 ? path[path.length - 1] : musicSettings.lastFolderName || 'Library';
		loadingFolderPath = folderKey;
		initAudioContext(); // unlock AudioContext while still in user gesture
		try {
			const indexedFiles = collectStoredFilesFromSnapshot(allFiles, path, musicSettings.sortOrder);
			if (indexedFiles.length > 0) {
				beginQueue(folderLabel);
				if (!(await startFirstPlayableTrack(indexedFiles))) {
					alert('No playable audio files were found in this folder.');
				}
				return;
			}

			if (deviceLibrary.nativeTreeUri) {
				if (!(await playNativeFolderFromScan(path, folderLabel))) {
					alert('No audio files found in this folder.');
				}
				return;
			}

			const files = await collectAllFromPath(path, {
				librarySource: musicSettings.librarySource,
				sortOrder: musicSettings.sortOrder,
				allFiles,
				libraryScanPromise: deviceLibrary.libraryScanPromise,
				rootDirHandle: deviceLibrary.rootDirHandle,
				nativeTreeUri: deviceLibrary.nativeTreeUri,
			});
			if (files.length === 0) { alert('No audio files found in this folder.'); return; }
			beginQueue(folderLabel);
			if (!(await startFirstPlayableTrack(files))) {
				alert('No playable audio files were found in this folder.');
			}
		} catch (e) {
			console.error('Failed to play folder:', e);
			alert('Could not load the folder. Please try again.');
		} finally {
			isChangingTrack = false;
			loadingFolderPath = null;
		}
	}

	// ── File management handlers (T6) — ADR-0002 ─────────────────────────────
	type OpTarget = { name: string; isDrive: boolean; fileId: string | null; source: StoredAudioFile | null };

	function openDestinationForOp(op: 'move' | 'copy', target: OpTarget) {
		pendingFileOp = { op, name: target.name, isDrive: target.isDrive, fileId: target.fileId, source: target.source };
		void openLocalDestinationPicker();
	}

	async function openLocalDestinationPicker() {
		if (!isNativeApp) {
			addToast({ message: 'Local destination requires the Android app.', type: 'warning' });
			return;
		}
		if (!deviceLibrary.nativeTreeUri) {
			await deviceLibrary.openFolder();
		}
		if (!deviceLibrary.nativeTreeUri) { addToast({ message: 'No local folder selected.', type: 'warning' }); return; }
		showLocalFolderPicker = true;
		await deviceLibrary.loadLocalFolderPicker('');
	}

	function confirmAndDelete(target: OpTarget) {
		pendingFileOp = { op: 'delete', name: target.name, isDrive: target.isDrive, fileId: target.fileId, source: target.source };
		addToast({
			message: `Delete ${target.name}?`,
			type: 'warning',
			autoDismissMs: 0,
			action: { label: 'Delete', handler: () => { void runPendingFileOp(null); } },
		});
	}

	async function runPendingFileOp(destination: { localPath?: string } | null) {
		const op = pendingFileOp;
		if (!op || isFileOpRunning) return;
		isFileOpRunning = true;
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
			isFileOpRunning = false;
			pendingFileOp = null;
		}
	}

	async function deleteFileOp(op: PendingFileOp) {
		if (!deviceLibrary.nativeTreeUri) throw new Error('no tree');
		await DirectoryReader.deleteEntry({ treeUri: deviceLibrary.nativeTreeUri, path: '', name: op.name });
		addToast({ message: `Deleted "${op.name}".`, type: 'info' });
	}

	async function moveOrCopyFileOp(op: PendingFileOp, destination: { localPath?: string }) {
		if (!deviceLibrary.nativeTreeUri) throw new Error('no tree');
		const destPath = destination.localPath ?? '';
		if (op.op === 'copy') {
			await DirectoryReader.copyEntry({ srcTreeUri: deviceLibrary.nativeTreeUri, srcPath: '', srcName: op.name, destTreeUri: deviceLibrary.nativeTreeUri, destPath, destName: op.name });
		} else {
			await DirectoryReader.moveEntry({ srcTreeUri: deviceLibrary.nativeTreeUri, srcPath: '', srcName: op.name, destTreeUri: deviceLibrary.nativeTreeUri, destPath, destName: op.name });
		}
		addToast({ message: `${op.op === 'copy' ? 'Copied' : 'Moved'} "${op.name}".`, type: 'info' });
	}

	function handleMoveEntry(target: OpTarget) { openDestinationForOp('move', target); }
	function handleCopyEntry(target: OpTarget) { openDestinationForOp('copy', target); }
	function handleDeleteEntry(target: OpTarget) { confirmAndDelete(target); }
	/** Folder ops operate on virtual path-derived folders — follow-up ticket. */
	function folderOpNotice(op: string) {
		addToast({ message: `${op} on folders is not wired yet.`, type: 'info' });
	}

	async function reloadCurrentBrowse() {
		void browseNavigation.loadBrowseEntries(browsePath, musicSettings.librarySource === 'drive' ? 'drive' : undefined);
	}

	// ─────────────────────────────────────────────────────────────
	// Playback controls
	// ─────────────────────────────────────────────────────────────

	/** mediaEngine transport: deliberate pause. Tells the engine, so the Android
	 *  background recovery does not restart this track when the phone is later
	 *  locked. */
	function pausePlayback() {
		try {
			if (!currentTrack || !isPlaying) return;
			void triggerPlaybackHaptic(false);
			markUserPaused();
			player.pause();
		} catch { /* haptics or player failure */ }
	}

	/** mediaEngine transport: resume this deck. The module owns the element — it
	 *  restarts the selected track when the element has no source (queue loaded
	 *  without playback, or unloaded by a cross-source stop) and refreshes the
	 *  Capacitor bridge on native. */
	async function resumePlayback() {
		if (isPlaying) return;

		// Loop selection takes priority — start or restart the loop even if no
		// track is currently loaded (fresh app start / empty queue).
		if (selectedBrowseFileKeys.length > 0 && !mediaEngine.musicSelectionLoopActive) {
			await playCurrentFolder();
			return;
		}

		// If a loop is already active but somehow the queue was cleared, restart it.
		if (mediaEngine.musicSelectionLoopActive && !currentTrack) {
			await playCurrentFolder();
			return;
		}

		if (!currentTrack) return;

		void triggerPlaybackHaptic(true);
		initAudioContext();

		// Set playing flag BEFORE claimAudio so mediaEngine.isPlaying never
		// transiently drops to false while we pause other sources.
		const deckFlag = deck === 'A' ? 'musicPlayingA' as const : 'musicPlayingB' as const;
		mediaEngine[deckFlag] = true;

		claimAudio(deck === 'A' ? 'musicA' : 'musicB');
		syncTrackToMediaEngine(player.state.currentIndex);
		player.resume();
	}

	// ── Rebuild the queue from the current selection when the loop is active.
	// Called before advancing so newly added/removed tracks take effect.
	function syncLoopTracksToSelection() {
		if (!mediaEngine.musicSelectionLoopActive) return;
		const selectedFiles = getSelectedBrowseFilesInOrder();
		if (selectedFiles.length === 0) {
			// All selections removed — disable the loop
			mediaEngine.musicSelectionLoopActive = false;
			return;
		}
		const currentKeys = tracks.map((t) => getStoredFileKey(t.source));
		const newKeys = selectedFiles.map((f) => getStoredFileKey(f));
		const selectionChanged =
			currentKeys.length !== newKeys.length ||
			currentKeys.some((k, i) => k !== newKeys[i]);
		if (!selectionChanged) return;

		// The module keeps the currently-playing track selected across the rebuild
		// by key, and falls back to the first track when it was removed.
		queueSessionId += 1;
		player.load(sortFiles(selectedFiles), { selectionLoop: true, keepCurrent: true });
	}

	/** mediaEngine transport: skip. The module advances/preloads and keeps the
	 *  queue in step; the view only has to refresh a changed selection loop first.
	 *  A skip that actually starts a different track claims the audio channel for
	 *  this deck the way startPlayback does (flag first, then claim) — a layer
	 *  playing elsewhere, such as a YouTube panel, must stop when this deck takes
	 *  over. A skip that rewinds in place, stops at the end of the queue, loops the
	 *  same track or finds every track broken does not claim, and neither does a
	 *  step forward or back on a paused deck, which only loads the src and starts
	 *  nothing.
	 *  Claiming follows the start of playback, not a resolved URL: the pre-migration
	 *  code claimed as soon as a URL landed, paused deck included, and set the
	 *  deck's playing flag with no isPlaying change, so the flag stuck true. That
	 *  claim without playback is deliberately gone. A next() from a paused deck
	 *  only loads the src, so it resolves false and does not claim either. */
	function claimDeckAudioForSkip() {
		// Set the playing flag before claiming so mediaEngine.isPlaying never
		// transiently drops to false while other sources are paused — the same
		// ordering startPlayback uses. Only reached when playback actually begins,
		// so a skip from a stopped deck never leaves the flag stuck true.
		const deckFlag = deck === 'A' ? 'musicPlayingA' as const : 'musicPlayingB' as const;
		mediaEngine[deckFlag] = true;
		claimAudio(deck === 'A' ? 'musicA' : 'musicB');
	}

	async function skipNext() {
		if (isChangingTrack) return;
		syncLoopTracksToSelection();
		// The module resolves true only when it changed track and began playback.
		if (await player.next()) claimDeckAudioForSkip();
	}

	async function skipPrev() {
		if (isChangingTrack) return;
		// Resolves false on the rewind-in-place branch and when nothing playable
		// could be started, so neither steals the channel from another source.
		if (await player.prev()) claimDeckAudioForSkip();
	}

	function handleSeekSeconds(seconds: number) {
		player.seek(seconds);
	}
	function handleVolume(e: Event) {
		const input = e.target as HTMLInputElement;
		musicSettings.deckBVolume = parseFloat(input.value);
		musicSettings.isMuted = musicSettings.deckBVolume === 0;
	}
	function toggleMute() { musicSettings.isMuted = !musicSettings.isMuted; }
	function togglePanel(p: 'speed' | 'eq') {
		showPanel = showPanel === p ? 'none' : p;
		if (showPanel !== 'none') initAudioContext();
	}

	$effect(() => {
		if (hasRestoredPendingDriveFolderPicker) return;
		hasRestoredPendingDriveFolderPicker = true;

		if (!hasPendingDriveFolderPickerIntent()) {
			return;
		}

		let cancelled = false;
		let restoreAttempts = 0;
		let restoreTimer: number | null = null;

		const scheduleRetry = () => {
			if (restoreAttempts >= 8 || cancelled) {
				clearPendingDriveFolderPickerIntent();
				return;
			}

			restoreAttempts += 1;
			restoreTimer = window.setTimeout(() => {
				restoreTimer = null;
				void restorePendingFolderPicker();
			}, 250);
		};

		const restorePendingFolderPicker = async () => {
			const restored = await folderPicker.restorePendingDriveFolderPickerIfNeeded();
			if (cancelled) {
				return;
			}

			if (!restored) {
				scheduleRetry();
			}
		};

		void restorePendingFolderPicker();

		return () => {
			cancelled = true;
			if (restoreTimer !== null) {
				window.clearTimeout(restoreTimer);
			}
		};
	});

	$effect(() => {
		const handleFocusRestore = () => {
			if (!hasPendingDriveFolderPickerIntent()) {
				return;
			}

			// The WebView is foreground again after a native Google consent screen.
			// Clear transient busy flags up front so a lost native call can never leave
			// the Connect button disabled and "do nothing" on the next tap.
			driveBusy.isAuthenticating = false;
			driveBusy.isLoading = false;
			void folderPicker.restorePendingDriveFolderPickerIfNeeded();
		};

		const handleVisibilityRestore = () => {
			if (document.visibilityState === 'visible') {
				handleFocusRestore();
			}
		};

		window.addEventListener('focus', handleFocusRestore);
		document.addEventListener('visibilitychange', handleVisibilityRestore);

		return () => {
			window.removeEventListener('focus', handleFocusRestore);
			document.removeEventListener('visibilitychange', handleVisibilityRestore);
			folderPicker.clearPendingDriveFolderPickerRestoreTimers();
		};
	});

	// ── Restore last folder handle from IndexedDB on mount ───────
	// untrack() prevents any reactive reads in the sync preamble (e.g. driveSession.accessToken reads
	// inside driveSession.ensureDriveAccessToken) from becoming effect dependencies, which would otherwise
	// cause this effect to re-run when those signals are written during hydration — leading to
	// multiple concurrent finishDriveLoad calls and a spinner that never resolves.
	$effect(() => {
		if (isNativeApp) isRestoring = true;
		untrack(() => {
		if (musicSettings.librarySource === 'drive') {
			// Skip if a Drive load is already running (e.g. triggered by folder picker confirmation)
			if (driveBusy.isLoading) return;
			// Silently restore Drive library using the persisted session token (survives refresh)
			void (async () => {
				try {
					const token = await driveSession.ensureDriveAccessToken(false);
					if (token) {
						await driveLibrary.finishDriveLoad(token, musicSettings.driveFolderId || undefined);
					}
				} catch {
					// Silent restore failed — user will see the Connect button
				} finally {
					isRestoring = false;
				}
			})();
			return;
		}
		void (async () => {
			try {
				const [handle, cachedLibrary] = await Promise.all([
					loadHandleFromIDB(),
					loadDeviceCachedLibrary(musicSettings.nativeTreeUri || null, musicSettings.lastFolderName),
				]);
				if (cachedLibrary && cachedLibrary.files.length > 0) {
					allFiles = restoreStoredFilesFromCache(cachedLibrary);
					deviceLibrary.activateDeviceLibrary(cachedLibrary.folderName);
					hydrateTracksFromLibrary(allFiles);
					showQueue = true;
					browseVersion++;
				}
				if (isNativeApp && musicSettings.nativeTreeUri) {
					deviceLibrary.nativeTreeUri = musicSettings.nativeTreeUri;
					deviceLibrary.rootDirHandle = null;
					deviceLibrary.pendingHandle = null;
					showQueue = true;
					browseVersion++;
				}
				if (!('showDirectoryPicker' in window) || !handle) return;
				type FSHandle = { queryPermission(o: object): Promise<string> };
				// queryPermission is safe to call without a user gesture.
				// If Chrome still has the permission in this session, we restore silently.
				// Otherwise we show the "Reconnect" button — requestPermission happens there
				// (inside reconnectFolder) where a real user gesture exists.
				const perm = await (handle as unknown as FSHandle).queryPermission({ mode: 'read' });
				if (perm === 'granted') {
					deviceLibrary.rootDirHandle = handle;
					deviceLibrary.nativeTreeUri = null;
					allFiles = cachedLibrary?.files.length ? allFiles : [];
					browseVersion++;
					showQueue = true;
				} else {
					// 'prompt' or 'denied' — need user gesture to re-request
					deviceLibrary.pendingHandle = handle;
				}
			} catch {
				// IDB or permission API unavailable — show plain Open Folder
			} finally {
				isRestoring = false;
			}
		})();
		});
	});

	$effect(() => {
		if (typeof window === 'undefined') return;
		const onRescan = () => { void deviceLibrary.rescanCurrentLibraryIndex(); };
		window.addEventListener('music-library:rescan', onRescan);
		return () => window.removeEventListener('music-library:rescan', onRescan);
	});

	$effect(() => { return () => { player.destroy(); audioCtx?.close(); }; });
</script>

<!-- Hidden folder input fallback -->
<input
	bind:this={folderInputEl}
	type="file"
	accept=".mp3,.m4a,audio/mpeg,audio/mp4,audio/x-m4a,audio/aac"
	multiple
	webkitdirectory
	class="hidden"
	onchange={deviceLibrary.handleFolderInput}
/>

<input
	bind:this={nativeFileInputEl}
	type="file"
	accept=".mp3,.m4a,audio/*"
	multiple
	class="hidden"
	onchange={deviceLibrary.handleNativeFileInput}
/>

<div class="flex flex-col h-full bg-background/85">

	<!-- ════════════════════════════ RESTORING ════════════════════════════ -->
	{#if isRestoring}
	<div class="flex flex-col items-center justify-center flex-1 gap-3">
		<div class="w-8 h-8 border-4 border-primary/30 border-t-primary rounded-full animate-spin"></div>
	</div>

	<!-- ════════════════════════════════ EMPTY STATE ════════════════════════════════ -->
	{:else if !hasFolderLoaded && !showQueue}
	<div class="flex flex-col items-center justify-center flex-1 gap-6 p-8 text-center">
		<div class="w-28 h-28 rounded-3xl bg-gradient-to-br from-cyan-500 via-sky-700 to-blue-950 flex items-center justify-center shadow-2xl ring-1 ring-cyan-400/30">
			<Music2 class="w-14 h-14 text-white" />
		</div>
		<div>
			<h2 class="text-2xl font-bold mb-2">Your Music</h2>
			<p class="text-muted-foreground text-sm leading-relaxed max-w-xs">
				{#if isNativeApp}
					Select a folder from your device. MP3 files in that folder and its sub-folders will be added to your library.
				{:else}
					Open a local folder or connect Google Drive to stream MP3 files from your account.
				{/if}
			</p>
		</div>
		<div class="flex flex-col items-center gap-3 w-full max-w-xs">
			{#if deviceLibrary.pendingHandle}
				<Button onclick={deviceLibrary.reconnectFolder} class="gap-2 px-6 h-12 text-base w-full">
					<FolderOpen class="w-5 h-5" /> Reconnect "{musicSettings.lastFolderName}"
				</Button>
				<Button variant="outline" onclick={deviceLibrary.openFolder} class="gap-2 h-10 text-sm w-full" disabled={isLoading}>
					<FolderOpen class="w-4 h-4" /> Choose a different folder
				</Button>
			{:else}
				<Button onclick={deviceLibrary.openFolder} class="gap-2 px-6 h-12 text-base w-full" disabled={isLoading}>
					{#if isLoading}
						<div class="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin"></div>
						Loading…
					{:else}
						<FolderOpen class="w-5 h-5" /> Open Folder
					{/if}
				</Button>
			{/if}
			<Button
				variant="outline"
				onclick={driveLibrary.connectGoogleDrive}
				class="gap-2 px-6 h-12 text-base w-full"
				disabled={!googleDriveConfigured || driveBusy.isLoading || driveBusy.isAuthenticating}
			>
				{#if driveBusy.isLoading || driveBusy.isAuthenticating}
					<div class="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin"></div>
					Connecting…
				{:else}
					<Cloud class="w-5 h-5" /> Connect Google Drive
				{/if}
			</Button>
			<!-- Reachable without a library on purpose: YouTube audio does not need
			     any local MP3s, and the panel itself explains that playback is
			     Android-only when it runs in a browser. -->
			<Button
				variant="outline"
				onclick={() => openYoutubePanel()}
				class="gap-2 px-6 h-12 text-base w-full"
			>
				<Youtube class="w-5 h-5 text-red-500" /> Play from YouTube
			</Button>
		</div>
		{#if !googleDriveConfigured}
			<p class="text-xs text-muted-foreground max-w-xs">
				Google Drive sign-in is disabled until PUBLIC_GOOGLE_CLIENT_ID is configured.
			</p>
		{/if}
		{#if driveSession.error}
			<p class="text-xs text-destructive max-w-xs">{driveSession.error}</p>
		{/if}
	</div>

	<!-- ════════════════════════════════ BROWSE VIEW ════════════════════════════════ -->
	{:else if showQueue}
	<div class="flex flex-col h-full"
		use:swipeBack={{
			onBack: () => {
				if (browsePath.length === 0) return;
				void triggerSwipeBackHaptic();
				browseNavigation.navigateToParentFolderFromSwipe();
			},
		}}
	>

		<!-- Header -->
		<div class="px-3 py-3 border-b shrink-0 space-y-2">
			<div class="flex items-center gap-2">
				{#if browsePath.length > 0 || musicFavorites.shown}
				<Button
					variant="ghost"
					size="icon"
					class="w-11 h-11 shrink-0"
					onclick={browseNavigation.navigateUp}
					aria-label={musicFavorites.shown
						? 'Back from favorite tracks'
						: 'Back to parent folder'}
				>
					<ChevronLeft class="w-6 h-6" />
				</Button>
				{/if}

				<!-- Breadcrumb (or search results label) -->
				<div class="flex items-center gap-1 flex-1 min-w-0 overflow-hidden">
					{#if fileSearchQuery}
						<span class="text-sm text-muted-foreground truncate">Search results</span>
					{:else}
					<button class="text-sm text-muted-foreground hover:text-foreground truncate shrink-0 max-w-[90px]"
						onclick={() => (browsePath = [])}
					>{currentLibraryLabel}</button>
					{#each browsePath as seg, i}
						<ChevronRight class="w-3 h-3 text-muted-foreground shrink-0" />
						<button
							class="text-sm truncate max-w-[90px] {i === browsePath.length - 1 ? 'text-foreground font-medium' : 'text-muted-foreground hover:text-foreground'}"
							onclick={() => (browsePath = browsePath.slice(0, i + 1))}
						>{seg}</button>
					{/each}
					{/if}
				</div>

				<!-- Favorites toggle + Change folder -->
				<div class="flex items-center gap-1 shrink-0">
					<Button
						variant="ghost"
						size="icon"
						class={`h-10 w-10 ${musicFavorites.shown ? 'text-yellow-400' : 'text-muted-foreground'}`}
						onclick={() => {
							musicFavorites.shown = !musicFavorites.shown;
							clearBrowseSelection();
						}}
						aria-label={musicFavorites.shown ? 'Hide favorite tracks' : 'Show favorite tracks'}
						title={musicFavorites.shown ? 'Hide favorite tracks' : 'Show favorite tracks'}
					>
						<Star class="w-5 h-5" fill={musicFavorites.shown ? 'currentColor' : 'none'} />
					</Button>
					<Button variant="ghost" size="icon" class="h-10 w-10" onclick={deviceLibrary.openLocalSourceButton} aria-label="Local folder" title="Local folder">
						<FolderOpen class="w-5 h-5" />
					</Button>
					<Button variant="ghost" size="icon" class="h-10 w-10" onclick={driveLibrary.openDriveSourceButton} disabled={driveBusy.isAuthenticating} aria-label="Google Drive" title="Google Drive">
						{#if driveBusy.isAuthenticating}
							<div class="w-5 h-5 border-2 border-current border-t-transparent rounded-full animate-spin"></div>
						{:else}
							<Cloud class="w-5 h-5" />
						{/if}
					</Button>
				</div>
			</div>

			<!-- Search filter — full-width row below the toolbar -->
			<div class="relative w-full">
				<Search class="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
				<input
					type="text"
					placeholder="Filter…"
					bind:value={fileSearchQuery}
					class="w-full h-8 pl-7 pr-7 text-xs rounded-lg border bg-background focus:outline-none focus:ring-1 focus:ring-primary/50"
				/>
				{#if fileSearchQuery}
					<button
						class="absolute right-1 top-1/2 -translate-y-1/2 w-5 h-5 flex items-center justify-center rounded-full text-muted-foreground hover:text-foreground"
						onclick={() => (fileSearchQuery = '')}
						aria-label="Clear filter"
					>
						<X class="w-3 h-3" />
					</button>
				{/if}
			</div>
		</div>

		<!-- Index scan progress bar (shown while building the in-memory folder index) -->
		{#if deviceLibrary.scanProgress !== null && musicSettings.librarySource !== 'drive'}
		<div class="px-4 py-2 border-b shrink-0 bg-muted/20">
			<div class="flex items-center gap-2 text-xs text-muted-foreground mb-1.5">
				<div class="w-3 h-3 border border-primary border-t-transparent rounded-full animate-spin shrink-0"></div>
				<span class="flex-1 truncate">Indexing library… {deviceLibrary.scanProgress.pct}% · {deviceLibrary.scanProgress.filesFound} file{deviceLibrary.scanProgress.filesFound === 1 ? '' : 's'} found</span>
			</div>
			<div class="h-1 rounded-full bg-muted overflow-hidden">
				<div class="h-full bg-primary rounded-full transition-[width] duration-300" style="width: {deviceLibrary.scanProgress.pct}%"></div>
			</div>
		</div>
		{/if}

		<!-- Download/upload progress -->
		{#if isTransferring && transferFile}
		<div class="px-4 py-2 border-b shrink-0 bg-muted/20">
			<div class="flex items-center gap-2 text-xs text-muted-foreground mb-1.5">
				<div class="w-3 h-3 border border-primary border-t-transparent rounded-full animate-spin shrink-0"></div>
				<span class="flex-1 truncate">
					{#if transferDirection === 'download'}
						{transferPhase === 'downloading' ? 'Downloading' : 'Saving'} {transferFile.name}
					{:else}
						Uploading {transferFile.name}
					{/if}
					{#if transferDirection === 'download' && transferPhase === 'downloading' && transferProgressPct !== null}
						· {transferProgressPct}%
					{/if}
				</span>
			</div>
			{#if transferDirection === 'download' && transferPhase === 'downloading' && transferProgressPct !== null}
			<div class="h-1 rounded-full bg-muted overflow-hidden">
				<div class="h-full bg-primary rounded-full transition-[width] duration-150" style="width: {transferProgressPct}%"></div>
			</div>
			{/if}
		</div>
		{/if}

		<!-- Favorites strip -->
		{#if musicSettings.favoriteFolders.length > 0}
		<div class="px-4 py-2 border-b shrink-0">
				<div class="flex items-center gap-2 overflow-x-auto" style="scrollbar-width:none">
				{#each musicSettings.favoriteFolders as fav}
					{@const isActive = fav.source === 'drive'
						? (musicSettings.librarySource === 'drive' && (fav.id === '_all' ? !musicSettings.driveFolderId : musicSettings.driveFolderId === fav.id))
						: (musicSettings.librarySource === 'device' && deviceLibrary.nativeTreeUri === fav.treeUri)}
					<div class="mini-player-control-surface flex items-center gap-0.5 shrink-0 rounded-full pl-2.5 pr-1 py-1 text-xs {isActive ? 'bg-primary text-primary-foreground border-primary' : 'text-foreground'}">
						<button class="flex items-center gap-1.5 min-w-0" onclick={() => driveLibrary.switchToFavorite(fav)} title="Switch to {fav.name}" disabled={switchingToFavId !== null}>
							{#if switchingToFavId === fav.id}
								<div class="w-3 h-3 border border-current border-t-transparent rounded-full animate-spin shrink-0"></div>
							{:else if fav.source === 'drive'}
								<Cloud class="w-3 h-3 shrink-0" />
							{:else}
								<FolderOpen class="w-3 h-3 shrink-0" />
							{/if}
							<span class="truncate max-w-[100px]">{fav.name}</span>
						</button>
						<button
							class="w-5 h-5 flex items-center justify-center rounded-full ml-0.5 hover:bg-black/10 opacity-60 hover:opacity-100 transition-opacity"
							onclick={() => folderPicker.removeFavoriteFolder(fav.id, fav.source)}
							aria-label="Remove {fav.name} from favorites"
						>×</button>
					</div>
				{/each}
			</div>
		</div>
		{/if}

		<!-- Entry list -->
		<div class="flex-1 overflow-y-auto min-h-0 browse-list-container">

			{#if musicFavorites.shown}
				{#if filteredFavoriteTracks.length === 0}
					<div class="flex flex-col items-center justify-center h-40 gap-2 text-muted-foreground px-6 text-center">
						<Star class="w-10 h-10 opacity-30" />
						<p class="text-sm">
							{#if fileSearchQuery.trim()}
								No favorite tracks match “{fileSearchQuery}”
							{:else}
								No favorite tracks yet
							{/if}
						</p>
						{#if !fileSearchQuery.trim()}
							<p class="text-xs">Tap the star on any track to add it here.</p>
						{/if}
					</div>
				{:else}
					{#each filteredFavoriteTracks as entry}
						{@const isYoutubeEntry = entry.favorite.source === 'youtube'}
						<!-- A YouTube favorite carries the same key as its MediaItem id
						     (`youtube:<videoId>`), so identity is a direct comparison. -->
						{@const isCurrentTrack = isYoutubeEntry
							? mediaEngine.source === 'youtube' && mediaEngine.item?.id === entry.favorite.key
							: mediaEngine.source === 'music' && currentMusicTrackKey === entry.favorite.key}
						<!-- YouTube entries have no file: they are playable through the
						     YouTube panel, not the music deck. -->
						{@const playable = isYoutubeEntry || Boolean(entry.file)}
						<div class="browse-list-row list-row-surface flex items-center gap-2 px-4 py-2 border-b transition-colors {isCurrentTrack ? 'bg-primary/10 ring-1 ring-inset ring-primary/25' : listTileToneClasses.usesTint ? listTileToneClasses.rowClass : 'hover:bg-accent'}">
							<button
								class="tap-feedback flex-1 min-w-0 flex items-center gap-2 rounded-xl px-2 py-2 transition-colors text-left {playable ? (isCurrentTrack ? 'bg-primary/10 ring-1 ring-inset ring-primary/30 active:bg-primary/15' : listTileToneClasses.usesTint ? listTileToneClasses.actionClass : 'active:bg-accent/80') : 'opacity-60'}"
								onclick={() => playFavoriteTrack(entry.favorite)}
								disabled={!playable}
								aria-label={playable ? `Play ${entry.favorite.title}` : `${entry.favorite.title} is unavailable`}
								aria-current={isCurrentTrack ? 'true' : undefined}
							>
								<div class="flex-1 min-w-0">
									<p class="font-semibold text-[0.95rem] leading-tight title-marquee"><span class="title-marquee-inner" data-text={entry.favorite.title}>{entry.favorite.title}</span></p>
									<p class="text-xs text-muted-foreground truncate">
										{entry.favorite.artist}
										{#if isYoutubeEntry}
											· YouTube
										{:else if !entry.file}
											· unavailable in current library
										{/if}
									</p>
								</div>
								{#if isCurrentTrack}
									<div class="rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-semibold text-primary shrink-0">{mediaEngine.isPlaying ? 'Playing' : 'Current'}</div>
								{/if}
							</button>
							<Button
								variant="ghost"
								size="icon"
								class="h-10 w-10 shrink-0 text-yellow-400"
								onclick={(event) => {
									event.stopPropagation();
									removeFavoriteTrack(entry.favorite.key);
								}}
								aria-label={`Remove ${entry.favorite.title} from favorite tracks`}
								title="Remove from favorite tracks"
							>
								<Star class="w-5 h-5" fill="currentColor" />
							</Button>
						</div>
					{/each}
				{/if}
			{:else if browseNavigation.browseLoading}
				<div class="flex items-center justify-center h-32">
					<div class="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin"></div>
				</div>
			{:else if filteredEntries.length === 0}
				<p class="text-center text-muted-foreground text-sm py-12">
					{#if fileSearchQuery.trim()}
						No files match “{fileSearchQuery}”
					{:else if musicSettings.librarySource === 'drive'}
						{driveSearch ? 'No Google Drive audio files match your search' : 'No audio files were found in Google Drive'}
					{:else}
						No audio files or folders here
					{/if}
				</p>
			{:else}
				{#each renderableEntries as entry}
					{#if entry.kind === 'folder'}
					{@const folderKey = [...browsePath, entry.name].join('/')}
					<!-- Folder row -->
					<div class="browse-list-row relative overflow-hidden border-b">
						<!-- Behind-content: move / copy / delete (compact icon tiles) -->
						<div class="absolute inset-y-0 right-0 flex items-center gap-1 bg-slate-900/80">
							<Button
								variant="ghost"
								size="icon"
								class="shrink-0"
								title="Move"
								onclick={(e) => { e.stopPropagation(); folderOpNotice('Move'); }}
							>
								<FolderInput class="w-5 h-5" />
							</Button>
							<Button
								variant="ghost"
								size="icon"
								class="shrink-0"
								title="Copy"
								onclick={(e) => { e.stopPropagation(); folderOpNotice('Copy'); }}
							>
								<Copy class="w-5 h-5" />
							</Button>
							<Button
								variant="ghost"
								size="icon"
								class="shrink-0"
								title="Delete"
								onclick={(e) => { e.stopPropagation(); folderOpNotice('Delete'); }}
							>
								<Trash2 class="w-5 h-5" />
							</Button>
						</div>
						<!-- Front: swipeable -->
						<div
							use:swipeItem={{ threshold: 180 }}
							data-swipe-front
							class="list-row-surface bg-background flex items-center gap-3 px-4 py-3 transition-colors relative z-10 {listTileToneClasses.usesTint ? listTileToneClasses.rowClass : 'hover:bg-accent'}"
						>
							<div class="w-9 h-9 rounded-lg bg-primary/15 flex items-center justify-center shrink-0">
								<Folder class="w-4.5 h-4.5 text-primary" />
							</div>
							<button class="tap-feedback flex-1 min-w-0 -my-2 -ml-2 rounded-xl px-2 py-2 text-left {listTileToneClasses.usesTint ? listTileToneClasses.actionClass : 'active:bg-accent/80'}" onclick={() => browseNavigation.navigateInto(entry.name)}>
								<p class="font-semibold text-[0.95rem] leading-tight title-marquee"><span class="title-marquee-inner" data-text={entry.name}>{entry.name}</span></p>
								<p class="text-xs text-muted-foreground">{entry.count > 0 ? entry.count + ' MP3 file' + (entry.count !== 1 ? 's' : '') : 'folder'}</p>
							</button>
							<!-- Play all in this subfolder -->
							<button
								class="w-11 h-11 rounded-full bg-primary/20 hover:bg-primary/40 flex items-center justify-center text-primary shrink-0 transition-colors disabled:opacity-40 disabled:pointer-events-none"
								onclick={() => playFolderPath([...browsePath, entry.name])}
								disabled={loadingFolderPath === folderKey}
								aria-label="Play {entry.name}"
							>
								{#if loadingFolderPath === folderKey}
									<div class="w-5 h-5 border-2 border-current border-t-transparent rounded-full animate-spin"></div>
								{:else}
									<Play class="w-5 h-5 ml-0.5" />
								{/if}
							</button>
							<!-- Navigate into -->
							<button class="text-muted-foreground shrink-0" onclick={() => browseNavigation.navigateInto(entry.name)} aria-label="Browse {entry.name}">
								<ChevronRight class="w-5 h-5" />
							</button>
						</div>
					</div>
					{:else}
					<!-- File row — swipe left for upload/download -->
					{@const isSelected = isBrowseFileSelected(entry.file)}
					{@const isCurrentTrack = mediaEngine.source === 'music' && currentMusicTrackKey === getStoredFileKey(entry.file)}
					{@const isDrive = entry.file.source === 'drive'}
					{@const isFiltered = fileSearchQuery.trim().length > 0}
					<div class="browse-list-row relative overflow-hidden border-b">
						<!-- Behind-content: upload/download (hidden during loop selection) -->
						{#if selectedBrowseCount === 0}
						<div class="absolute inset-y-0 right-0 flex items-center gap-1 bg-slate-900/80">
							{#if isFiltered}
							<Button
								variant="ghost"
								size="icon"
								class="shrink-0"
								title="Go to folder"
								onclick={(e) => {
								e.stopPropagation();
								const wrapper = (e.currentTarget as HTMLElement).closest('.relative.overflow-hidden');
								const front = wrapper?.querySelector('[data-swipe-front]') as HTMLElement | null;
								if (front) { front.style.transition = 'transform 0.2s ease'; front.style.transform = ''; }
								browseNavigation.goToFileFolder(entry.file);
							}}
							>
								<Folder class="w-5 h-5" />
							</Button>
							{/if}
							<Button
								variant="ghost"
								size="icon"
								class="shrink-0"
								title={isDrive ? 'Download' : 'Upload'}
								onclick={(e) => {
								e.stopPropagation();
								// Reset the swipe position
								const wrapper = (e.currentTarget as HTMLElement).closest('.relative.overflow-hidden');
								const front = wrapper?.querySelector('[data-swipe-front]') as HTMLElement | null;
								if (front) { front.style.transition = 'transform 0.2s ease'; front.style.transform = ''; }
								if (isDrive) deviceLibrary.openLocalDownloadFolderPicker(entry.file);
								else driveLibrary.openDriveUploadFolderPicker(entry.file);
							}}
							>
								{#if isDrive}
									<Download class="w-5 h-5" />
								{:else}
									<Upload class="w-5 h-5" />
								{/if}
							</Button>
							{#if !isDrive}
							<Button
								variant="ghost"
								size="icon"
								class="shrink-0"
								title="Move"
								onclick={(e) => { e.stopPropagation(); handleMoveEntry({ name: entry.file.name, isDrive, fileId: isDrive ? ((entry.file as any).fileId ?? null) : null, source: entry.file }); }}
							>
								<FolderInput class="w-5 h-5" />
							</Button>
							<Button
								variant="ghost"
								size="icon"
								class="shrink-0"
								title="Copy"
								onclick={(e) => { e.stopPropagation(); handleCopyEntry({ name: entry.file.name, isDrive, fileId: isDrive ? ((entry.file as any).fileId ?? null) : null, source: entry.file }); }}
							>
								<Copy class="w-5 h-5" />
							</Button>
							<Button
								variant="ghost"
								size="icon"
								class="shrink-0"
								title="Delete"
								onclick={(e) => { e.stopPropagation(); handleDeleteEntry({ name: entry.file.name, isDrive, fileId: isDrive ? ((entry.file as any).fileId ?? null) : null, source: entry.file }); }}
							>
								<Trash2 class="w-5 h-5" />
							</Button>
							{/if}
						</div>
						{/if}
						<!-- Front: existing row content (swipeable) -->
						<div
							use:swipeItem={{ threshold: 180 }}
							data-swipe-front
							class="list-row-surface flex items-center gap-2 px-4 py-2 transition-colors relative z-10 bg-background {isSelected ? 'ring-1 ring-inset ring-primary/35' : isCurrentTrack ? 'ring-1 ring-inset ring-primary/25' : listTileToneClasses.usesTint ? listTileToneClasses.rowClass : 'hover:bg-accent'}"
							style={isSelected ? 'background-color: hsl(190 62% 20%)' : isCurrentTrack ? 'background-color: hsl(190 58% 17%)' : ''}
						>
						<button
							class="tap-feedback flex-1 min-w-0 flex items-center gap-2 rounded-xl px-2 py-2 transition-colors text-left {isSelected || isCurrentTrack ? 'active:bg-primary/18' : listTileToneClasses.usesTint ? listTileToneClasses.actionClass : 'active:bg-accent/80'}"
							onclick={async () => {
								const fileKey = getStoredFileKey(entry.file);
								if (longPressHandledFileKey === fileKey) {
									longPressHandledFileKey = null;
									return;
								}

								if (selectedBrowseCount > 0) {
									toggleBrowseFileSelection(entry.file);
									return;
								}

								await playBrowseFile(entry);
							}}
							onpointerdown={(event) => handleBrowseFilePressStart(entry, event)}
							onpointerup={handleBrowseFilePressEnd}
							onpointerleave={handleBrowseFilePressEnd}
							onpointercancel={handleBrowseFilePressEnd}
							oncontextmenu={(event) => event.preventDefault()}
							aria-label="Play {entry.name}"
							aria-pressed={isSelected}
							aria-current={isCurrentTrack ? 'true' : undefined}
						>
							<div class="flex-1 min-w-0">
								<p class="font-semibold text-[0.95rem] leading-tight title-marquee {isCurrentTrack ? 'is-active' : ''}"><span class="title-marquee-inner" data-text={parseFilename(entry.name).title}>{parseFilename(entry.name).title}</span></p>
								<p class="text-xs text-muted-foreground truncate">{parseFilename(entry.name).artist}</p>
							</div>
							{#if isSelected}
								<div class="rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-semibold text-primary shrink-0">Loop</div>
							{:else if isCurrentTrack}
								<div class="rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-semibold text-primary shrink-0">{mediaEngine.isPlaying ? 'Playing' : 'Current'}</div>
							{/if}
						</button>
						<Button
							variant="ghost"
							size="icon"
							class={`h-10 w-10 shrink-0 ${isFavoriteTrack(entry.file) ? 'text-yellow-400' : 'text-muted-foreground'}`}
							onclick={(event) => {
								event.stopPropagation();
								toggleFavoriteTrack(entry.file);
							}}
							aria-label={`${isFavoriteTrack(entry.file) ? 'Remove' : 'Add'} ${parseFilename(entry.name).title} ${isFavoriteTrack(entry.file) ? 'from' : 'to'} favorite tracks`}
							title={isFavoriteTrack(entry.file) ? 'Remove from favorite tracks' : 'Add to favorite tracks'}
						>
							<Star class="w-5 h-5" fill={isFavoriteTrack(entry.file) ? 'currentColor' : 'none'} />
						</Button>
					</div>
					</div>
					{/if}
				{/each}
				{#if hasMoreEntries}
					<p class="text-center text-muted-foreground text-xs py-4 border-t border-border/50">
						Showing {entriesRenderCount} of {filteredEntries.length} files
						{#if debouncedSearchQuery.trim().length === 0}
							— use search to find specific files
						{:else}
							— refine your search for more results
						{/if}
					</p>
				{/if}
			{/if}
		</div>

	</div>

	<!-- ════════════════════════════════ PLAYER VIEW ════════════════════════════════ -->
	{:else if currentTrack}

	<!-- Scrollable player content -->
	<div class="flex flex-col items-center px-6 pt-5 pb-4 gap-4 flex-1 overflow-y-auto"
		role="region"
		aria-label="Music player"
		use:swipeBack={{ onBack: () => { void triggerSwipeBackHaptic(); showQueue = true; } }}
	>

		<!-- Folder badge -->
		<div class="w-full flex items-center justify-between">
			<div class="flex items-center gap-1.5 text-xs text-muted-foreground min-w-0">
				{#if musicSettings.librarySource === 'drive'}
					<Cloud class="w-5 h-5 shrink-0" />
				{:else}
					<FolderOpen class="w-5 h-5 shrink-0" />
				{/if}
				<span class="truncate">{currentLibraryLabel}</span>
			</div>
			<div class="flex items-center gap-1 shrink-0">
				<Button variant="ghost" size="icon" onclick={deviceLibrary.openFolder} title="Open local folder" class="h-10 w-10">
					<FolderOpen class="w-5 h-5" />
				</Button>
				<Button variant="ghost" size="icon" onclick={driveSession.user ? driveLibrary.changeDriveFolder : driveLibrary.connectGoogleDrive} title={driveSession.user ? 'Change Google Drive folder' : 'Connect Google Drive'} class="h-10 w-10">
					<Cloud class="w-5 h-5" />
				</Button>
			</div>
		</div>

		<!-- Album Art -->
		<div class="w-48 h-48 rounded-2xl bg-gradient-to-br from-cyan-500 via-sky-700 to-blue-950 flex items-center justify-center shadow-2xl relative overflow-hidden shrink-0 ring-1 ring-cyan-400/40">
			{#if isPlaying}
				<div class="absolute inset-0 bg-white/5 animate-pulse rounded-2xl"></div>
			{/if}
			<Music2 class="w-20 h-20 text-white/80" />

			{#if trackLoadProgress || isBuffering}
				<div class="absolute inset-0 bg-black/60 backdrop-blur-[2px] flex flex-col items-center justify-center gap-2 text-white">
					<div class="w-8 h-8 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
					{#if trackLoadProgress && trackLoadProgress.total > 0}
						<p class="text-xs font-medium">Loading track… {Math.min(100, Math.round((trackLoadProgress.loaded / trackLoadProgress.total) * 100))}%</p>
						<div class="w-32 h-1.5 bg-white/25 rounded-full overflow-hidden">
							<div class="h-full bg-white rounded-full transition-all" style="width: {Math.min(100, (trackLoadProgress.loaded / trackLoadProgress.total) * 100)}%"></div>
						</div>
					{:else}
						<p class="text-xs font-medium">{trackLoadProgress ? 'Loading track…' : 'Buffering…'}</p>
					{/if}
				</div>
			{/if}
		</div>

		<!-- Track Info -->
		<div class="w-full flex items-center justify-between">
			<div class="flex-1 min-w-0 text-left">
				<h2 class="text-xl font-bold truncate">{currentTrack.title}</h2>
				<p class="text-muted-foreground text-sm truncate">{currentTrack.artist}</p>
			</div>
			<Button variant="ghost" size="icon"
				onclick={() => currentTrack && toggleFavoriteTrack(currentTrack.source)}
				class="{currentTrackIsFavorite ? 'text-yellow-400' : 'text-muted-foreground'} ml-2 shrink-0"
				aria-label={currentTrackIsFavorite ? 'Remove current track from favorite tracks' : 'Add current track to favorite tracks'}
			>
				<Star class="w-6 h-6" fill={currentTrackIsFavorite ? 'currentColor' : 'none'} />
			</Button>
		</div>

		<!-- Volume (Deck B only — Deck A always at 100%) -->
		{#if deck === 'B'}
		<div class="flex items-center gap-3 w-full">
			<Button variant="ghost" size="icon" onclick={toggleMute} class="text-muted-foreground shrink-0">
				{#if musicSettings.isMuted || effectiveVolume === 0}
					<VolumeX class="w-5 h-5" />
				{:else}
					<Volume2 class="w-5 h-5" />
				{/if}
			</Button>
			<input type="range" min="0" max="100"
				value={musicSettings.isMuted ? 0 : effectiveVolume}
				oninput={handleVolume}
				class="w-full h-1.5 rounded-full appearance-none cursor-pointer bg-secondary accent-primary" />
		</div>
		{/if}
	</div>

	<!-- Speed panel -->
	{#if showPanel === 'speed'}
	<div class="border-t bg-card/95 px-4 pt-3 pb-3 shrink-0">
		<p class="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">Playback Speed</p>
		<div class="flex flex-wrap gap-2">
			{#each [0.5, 0.75, 0.8, 1.0, 1.25, 1.5, 1.75, 2.0] as speed}
				<button
					class="px-3 py-1.5 rounded-full text-sm font-medium border transition-colors {effectiveSpeed === speed ? 'bg-primary text-primary-foreground border-primary' : 'border-border hover:bg-accent'}"
					onclick={() => { if (deck === 'A') musicSettings.deckASpeed = speed; else musicSettings.deckBSpeed = speed; }}
				>{speed}×</button>
			{/each}
		</div>
	</div>
	{/if}

	<!-- EQ panel -->
	{#if showPanel === 'eq'}
		<MusicEqPanel
			eqBands={musicSettings.eqBands}
			equalizerPreset={musicSettings.equalizerPreset}
			eqAvailable={eqAvailable}
			onApplyPreset={applyEqPreset}
				onLiveBand={setEqBandLive}
			onSetBand={setEqBand}
		/>
	{/if}

	<!-- Bottom toolbar -->
	<div class="border-t bg-background px-3 pt-3 pb-4 shrink-0 flex gap-3">
		<button
			class="flex-1 flex flex-col items-center justify-center gap-1.5 rounded-2xl py-3 transition-all active:scale-95
				{showQueue
					? 'bg-primary text-primary-foreground shadow-lg shadow-primary/30'
					: 'bg-secondary/60 text-muted-foreground hover:bg-secondary'}"
			onclick={() => { showQueue = !showQueue; showPanel = 'none'; }}>
			<FolderOpen class="w-7 h-7" />
			<span class="text-[11px] font-semibold tracking-wide">Browse</span>
		</button>
		<button
			class="flex-1 flex flex-col items-center justify-center gap-1.5 rounded-2xl py-3 transition-all active:scale-95
				{showPanel === 'speed'
					? 'bg-primary text-primary-foreground shadow-lg shadow-primary/30'
					: 'bg-secondary/60 text-muted-foreground hover:bg-secondary'}"
			onclick={() => togglePanel('speed')}>
			<Gauge class="w-7 h-7" />
			<span class="text-[11px] font-semibold tracking-wide">{effectiveSpeed}×</span>
		</button>
		<button
			class="flex-1 flex flex-col items-center justify-center gap-1.5 rounded-2xl py-3 transition-all active:scale-95
				{showPanel === 'eq'
					? 'bg-primary text-primary-foreground shadow-lg shadow-primary/30'
					: 'bg-secondary/60 text-muted-foreground hover:bg-secondary'}"
			onclick={() => togglePanel('eq')}>
			<SlidersHorizontal class="w-7 h-7" />
			<span class="text-[11px] font-semibold tracking-wide">EQ</span>
		</button>
		<button
			class="flex-1 flex flex-col items-center justify-center gap-1.5 rounded-2xl py-3 transition-all active:scale-95
				{youtubePanel.open
					? 'bg-primary text-primary-foreground shadow-lg shadow-primary/30'
					: 'bg-secondary/60 text-muted-foreground hover:bg-secondary'}"
			onclick={() => { openYoutubePanel(); showPanel = 'none'; }}>
			<Youtube class="w-7 h-7" />
			<span class="text-[11px] font-semibold tracking-wide">YouTube</span>
		</button>
	</div>

	{/if}

<!-- ═══════════════════ LOCAL FOLDER PICKER (Android download) ═══ -->
{#if showLocalFolderPicker}
<div class="absolute inset-0 z-50 bg-background flex flex-col">
	<div class="flex items-center gap-2 px-3 py-3 border-b shrink-0">
		<Button variant="ghost" size="icon" class="w-11 h-11 shrink-0" onclick={() => { showLocalFolderPicker = false; transferFile = null; pendingFileOp = null; }}>
			<ChevronLeft class="w-6 h-6" />
		</Button>
		<div class="flex-1 min-w-0">
			<p class="text-sm font-semibold">{pendingFileOp ? (pendingFileOp.op === 'move' ? 'Move to folder' : 'Copy to folder') : 'Download to phone'}</p>
			<p class="text-xs text-muted-foreground">{pendingFileOp?.name ?? transferFile?.name ?? ''}</p>
		</div>
		<Button variant="ghost" size="sm" onclick={deviceLibrary.selectLocalFolderAndDownload} disabled={isTransferring || isFileOpRunning}>
			{pendingFileOp ? 'Move here' : 'Save here'}
		</Button>
	</div>
	<!-- Breadcrumb -->
	{#if deviceLibrary.localPickerPath.length > 0}
	<div class="flex items-center gap-1 px-3 py-2 text-xs text-muted-foreground border-b shrink-0 flex-wrap">
		<button class="hover:text-foreground" onclick={() => { deviceLibrary.localPickerPath = []; void deviceLibrary.loadLocalFolderPicker(''); }}>Root</button>
		{#each deviceLibrary.localPickerPath as seg, i}
			<ChevronRight class="w-3 h-3 shrink-0" />
			<button class="hover:text-foreground truncate max-w-[100px] {i === deviceLibrary.localPickerPath.length - 1 ? 'text-foreground font-medium' : ''}" onclick={() => { deviceLibrary.localPickerPath = deviceLibrary.localPickerPath.slice(0, i + 1); void deviceLibrary.loadLocalFolderPicker(deviceLibrary.localPickerPath.join('/')); }}>{seg}</button>
		{/each}
	</div>
	{/if}
	<div class="flex-1 overflow-y-auto">
		{#if deviceLibrary.localPickerLoading}
		<div class="flex items-center justify-center py-12"><div class="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin"></div></div>
		{:else if deviceLibrary.localPickerEntries.length === 0}
		<p class="text-center text-muted-foreground text-sm py-12">No folders here</p>
		{:else}
		{#each deviceLibrary.localPickerEntries as entry}
			{#if entry.kind === 'folder'}
			<button class="w-full flex items-center gap-3 px-4 py-3 border-b hover:bg-accent text-left" onclick={() => deviceLibrary.navigateLocalPickerInto(entry)}>
				<Folder class="w-5 h-5 text-primary shrink-0" />
				<span class="text-sm truncate">{entry.name}</span>
			</button>
			{/if}
		{/each}
		{/if}
	</div>
</div>
{/if}

</div>

<!-- ═══════════════════ TRANSFER FOLDER PICKER (Upload to Drive) ═══ -->
{#if showDriveFolderPicker}
<div class="absolute inset-0 z-50 bg-background flex flex-col">
	<div class="flex items-center gap-2 px-3 py-3 border-b shrink-0">
		<Button variant="ghost" size="icon" class="w-11 h-11 shrink-0" onclick={() => { showDriveFolderPicker = false; transferFile = null; pendingFileOp = null; }}>
			<ChevronLeft class="w-6 h-6" />
		</Button>
		<div class="flex-1 min-w-0">
			<p class="text-sm font-semibold">Upload to Google Drive</p>
			<p class="text-xs text-muted-foreground">{transferFile?.name ?? ''}</p>
		</div>
	</div>
	<!-- Breadcrumb -->
	{#if drivePickerPath.length > 0}
	<div class="flex items-center gap-1 px-3 py-2 text-xs text-muted-foreground border-b shrink-0 flex-wrap">
		<button class="hover:text-foreground" onclick={() => { drivePickerPath = []; void driveLibrary.loadDriveFolderPicker('root'); }}>My Drive</button>
		{#each drivePickerPath as folder, i}
			<ChevronRight class="w-3 h-3 shrink-0" />
			<button class="hover:text-foreground truncate max-w-[100px] {i === drivePickerPath.length - 1 ? 'text-foreground font-medium' : ''}" onclick={() => { drivePickerPath = drivePickerPath.slice(0, i + 1); void driveLibrary.loadDriveFolderPicker(folder.id); }}>{folder.name}</button>
		{/each}
	</div>
	{/if}
	<div class="flex-1 overflow-y-auto">
		{#if drivePickerLoading}
		<div class="flex items-center justify-center py-12"><div class="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin"></div></div>
		{:else if drivePickerFolders.length === 0}
		<p class="text-center text-muted-foreground text-sm py-12">No folders here</p>
		{:else}
		{#each drivePickerFolders as folder}
			<button class="w-full flex items-center gap-3 px-4 py-3 border-b hover:bg-accent text-left" onclick={() => driveLibrary.selectDriveFolderAndUpload(folder)}>
				<Folder class="w-5 h-5 text-primary shrink-0" />
				<span class="text-sm truncate">{folder.name}</span>
			</button>
		{/each}
		{/if}
	</div>
</div>
{/if}

<!-- ═══════════════════ DRIVE FOLDER PICKER DIALOG ═══════════════════ -->
{#if folderPicker.showFolderPicker}
<div
	class="fixed inset-0 z-50 flex items-end sm:items-center justify-center"
	role="dialog"
	aria-modal="true"
	aria-label="Choose Google Drive folder"
>
	<!-- Backdrop -->
	<button
		class="absolute inset-0 bg-black/60 backdrop-blur-sm"
		onclick={folderPicker.cancelFolderPicker}
		aria-label="Close"
		tabindex="-1"
	></button>

	<!-- Sheet -->
	<div class="relative z-10 w-full max-w-md bg-card rounded-t-2xl sm:rounded-2xl shadow-2xl border border-border flex flex-col max-h-[80dvh]">
		<!-- Handle bar -->
		<div class="flex justify-center pt-3 pb-1 sm:hidden shrink-0">
			<div class="w-10 h-1 rounded-full bg-muted-foreground/40"></div>
		</div>

		<!-- Header -->
		<div class="px-4 pt-3 pb-3 border-b shrink-0">
			<div class="flex items-center gap-2">
				{#if folderPicker.folderPickerStack.length > 0}
					<button
						class="w-8 h-8 flex items-center justify-center rounded-full hover:bg-accent transition-colors text-muted-foreground"
						onclick={folderPicker.navigateFolderPickerBack}
						aria-label="Back"
					>
						<ChevronLeft class="w-4 h-4" />
					</button>
				{/if}
				<div class="flex-1 min-w-0">
					<h2 class="text-base font-semibold leading-tight">Choose a folder</h2>
					{#if folderPicker.folderPickerStack.length > 0}
						<p class="text-xs text-muted-foreground truncate">
							{folderPicker.folderPickerStack.map(f => f.name).join(' › ')}
						</p>
					{:else}
						<p class="text-xs text-muted-foreground">Select which folder to load MP3s from</p>
					{/if}
				</div>
				<button
					class="w-8 h-8 flex items-center justify-center rounded-full hover:bg-accent transition-colors text-muted-foreground"
					onclick={folderPicker.cancelFolderPicker}
					aria-label="Cancel"
				>
					<ChevronLeft class="w-4 h-4 rotate-180" />
				</button>
			</div>
		</div>

		<!-- Folder list -->
		<div class="flex-1 overflow-y-auto min-h-0">
			{#if folderPicker.folderPickerLoading}
				<div class="flex items-center justify-center py-12">
					<div class="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin"></div>
				</div>
			{:else if folderPicker.folderPickerError}
				<div class="px-4 py-8 text-center space-y-3">
					<p class="text-sm text-destructive">{folderPicker.folderPickerError}</p>
					<Button variant="outline" size="sm" onclick={folderPicker.loadFolderPickerLevel}>Retry</Button>
				</div>
			{:else}
				<!-- "All files" option (only at root level) -->
				{#if folderPicker.folderPickerStack.length === 0}
					<button
						class="w-full flex items-center gap-3 px-4 py-3 border-b hover:bg-accent transition-colors text-left"
						onclick={() => confirmDriveFolderSelection(undefined, undefined)}
					>
						<div class="w-9 h-9 rounded-lg bg-muted/50 flex items-center justify-center shrink-0">
							<Cloud class="w-4 h-4 text-muted-foreground" />
						</div>
						<div class="flex-1 min-w-0">
							<p class="text-sm font-medium">All files</p>
							<p class="text-xs text-muted-foreground">Search entire Google Drive</p>
						</div>
						{#if !musicSettings.driveFolderId}
							<div class="w-4 h-4 rounded-full border-2 border-primary bg-primary shrink-0"></div>
						{/if}
					</button>
				{/if}

				{#if folderPicker.folderPickerFolders.length === 0}
					<p class="text-center text-muted-foreground text-sm py-8 px-4">No sub-folders found here</p>
				{:else}
					{#each folderPicker.folderPickerFolders as folder}
						{@const isSelected = musicSettings.driveFolderId === folder.id}
						{@const isFaved = folderPicker.isDriveFolderPickerFavorited(folder.id)}
						<div class="w-full flex items-center gap-3 px-4 py-3 border-b hover:bg-accent transition-colors">
							<button class="flex items-center gap-3 flex-1 min-w-0 text-left" onclick={() => folderPicker.navigateFolderPickerInto(folder)}>
								<div class="w-9 h-9 rounded-lg bg-primary/15 flex items-center justify-center shrink-0">
									<Folder class="w-4 h-4 text-primary" />
								</div>
								<p class="flex-1 text-sm font-medium truncate min-w-0">{folder.name}</p>
								{#if isSelected}
									<div class="w-4 h-4 rounded-full border-2 border-primary bg-primary shrink-0"></div>
								{/if}
							</button>
							<button
								class="w-8 h-8 flex items-center justify-center rounded-full hover:bg-accent transition-colors shrink-0 {isFaved ? 'text-yellow-400' : 'text-muted-foreground'}"
								onclick={(e) => folderPicker.toggleDriveFolderPickerFavorite(folder, e)}
								aria-label="{isFaved ? 'Remove from' : 'Add to'} favorites"
							>
								<Star class="w-4 h-4" fill={isFaved ? 'currentColor' : 'none'} />
							</button>
							<button class="shrink-0 text-muted-foreground" onclick={() => folderPicker.navigateFolderPickerInto(folder)} aria-label="Browse {folder.name}">
								<ChevronRight class="w-4 h-4" />
							</button>
						</div>
					{/each}
				{/if}
			{/if}
		</div>

		<!-- Footer -->
		<div class="px-4 py-3 border-t shrink-0 flex gap-2">
			<Button variant="outline" class="flex-1" onclick={folderPicker.cancelFolderPicker}>Cancel</Button>
			<Button class="flex-1" onclick={folderPicker.confirmCurrentFolder}>
				Select{folderPicker.folderPickerStack.length > 0 ? ` "${folderPicker.folderPickerStack.at(-1)!.name}"` : ' all'}
			</Button>
		</div>
	</div>
</div>
{/if}

<!-- The YouTube panel is rendered once in +page.svelte. Mp3PlayerView is
     mounted once per music deck, so mounting the panel here would create two
     YouTube audio elements. The toolbar button above only requests it opens. -->

<style>
	/* ── Virtualized list rows — content-visibility: auto tells the browser to skip
	   layout/paint for off-screen rows. contain-intrinsic-size gives the scrollbar
	   a reasonable estimate before rows are measured. ── */
	.browse-list-row {
		content-visibility: auto;
		contain-intrinsic-size: auto 56px;
	}

	/* The container that holds the list — contain: strict gives the browser a
	   hard layout boundary so inner reflows don't cascade upward. */
	.browse-list-container {
		contain: layout style;
	}

	/* ── Player view container — contain: layout style isolates repaints from
	   the browse view and vice versa. ── */
	.player-view-container {
		contain: layout style;
	}

	@keyframes bar1 { 0%, 100% { height: 30%; } 50% { height: 90%; } }
	@keyframes bar2 { 0%, 100% { height: 90%; } 50% { height: 30%; } }
</style>
