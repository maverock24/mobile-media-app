<script lang="ts">
	import { untrack } from 'svelte';
	import { swipeBack } from '$lib/actions/touch';
	import { Capacitor } from '@capacitor/core';
	import { Filesystem } from '@capacitor/filesystem';
	import { FilePicker } from '@capawesome/capacitor-file-picker';
	import Input from '$lib/components/ui/Input.svelte';
	import { DirectoryReader, type NativeDirectoryFile, type NativeDirectoryFolder } from '$lib/native/directory-reader';
	import MusicEqPanel from '$lib/components/ui/MusicEqPanel.svelte';
	import { createEqFilterChain, applyEqGains } from '$lib/audio/equalizer';
	import { bytesFromBase64, arrayBufferFromBytes, blobFromNativePath } from '$lib/audio/fileResolver';
	import { getRelativePath, buildBrowseEntries } from '$lib/models/browse';
	import {
		type StoredAudioFile,
		type BrowseEntry,
		type CachedLibrary,
		type CachedLibraryFile,
		type CachedWebLibraryFile,
		type CachedNativeLibraryFile,
		EQ_LABELS,
		EQ_PRESETS,
		formatTime,
		getStoredFileKey,
		getTrackKey,
		mergeStoredFiles,
		fmtGain,
		getNextTrackIndex as getNextTrackIndexPure,
		parseFilename,
		sortFiles as sortStoredFiles,
		createStoredAudioFile,
		createStoredWebAudioFile,
		createStoredNativeAudioFile,
		createStoredDriveAudioFile,
	} from '$lib/models/music';
	import {
		idbGet, idbPut, idbDelete,
		openIDB,
		saveHandleToIDB, loadHandleFromIDB,
		loadCachedLibrary, deleteCachedLibrary,
		saveDriveCache, loadDriveCache, bustDriveCache,
	} from '$lib/utils/idb';
	import { triggerPlaybackHaptic, triggerSwipeBackHaptic } from '$lib/native/haptics';
	import { marqueeTitle } from '$lib/actions/marqueeTitle';
	import Button from '$lib/components/ui/Button.svelte';
	import {
		checkFolderHasSubfolders,
		consumePendingGoogleDriveAccessToken,
		downloadGoogleDriveFile,
		fetchGoogleDriveUser,
		getGoogleDriveClientId,
		isGoogleDriveConfigured,
		listGoogleDriveFolders,
		streamGoogleDriveMp3Files,
		requestGoogleDriveAccessToken,
		revokeGoogleDriveAccess,
		type GoogleDriveFile,
		type GoogleDriveFolder,
		type GoogleDriveUser
	} from '$lib/google-drive';
	import { formatGoogleDriveAuthError } from '$lib/google-drive-auth-error';
	import { appSettings, musicSettings } from '$lib/stores/settings.svelte';
	import { googleDriveSession } from '$lib/stores/googleDriveSession.svelte';
	import { driveConfigSync } from '$lib/stores/driveConfigSync.svelte';
	import { getListTileToneClasses } from '$lib/utils/listTileTone';
	
	import { mediaEngine, claimAudio, registerAudioSource } from '$lib/stores/mediaEngine.svelte';
	import { addToast } from '$lib/stores/toastStore.svelte';
	import {
		Play, Pause, SkipBack, SkipForward, Shuffle, Repeat,
		Volume2, VolumeX, FolderOpen, Music2,
		ChevronLeft, ChevronRight, Folder, Gauge, SlidersHorizontal,
		Cloud, RefreshCw, LogOut, Search, Star
	} from 'lucide-svelte';

	interface Track {
		id: number; title: string; artist: string;
		filename: string; url: string; duration: number;
		cleanup?: () => void;
		source: StoredAudioFile;
	}

	type FavoriteTrack = (typeof musicSettings.favoriteTracks)[number];

	const isNativeApp = typeof window !== 'undefined' && Capacitor.isNativePlatform();

	let { deck = 'A' as 'A' | 'B' }: { deck?: 'A' | 'B' } = $props();
	const deckVolKey = $derived(deck === 'A' ? 'deckAVolume' as const : 'deckBVolume' as const);
	const googleDriveConfigured = isGoogleDriveConfigured();
	const googleDriveClientId = getGoogleDriveClientId();

	const LAST_LIBRARY_CACHE_KEY = 'last-library';
	const BACKGROUND_LIBRARY_SCAN_BATCH_SIZE = 120;
	const FOLDER_PLAY_SCAN_BATCH_SIZE = 48;
	const listTileToneClasses = $derived(getListTileToneClasses(appSettings.listTileTone));
	const FOLDER_PLAY_INITIAL_BATCH_SIZE = 1;
	const FOLDER_PLAY_PRIME_COUNT = 1;
	const FOLDER_PLAY_QUEUE_FLUSH_SIZE = 400;
	const BROWSE_LONG_PRESS_MS = 450;

	function getDeviceLibraryCacheKey(options: { treeUri?: string | null; folderName?: string | null } = {}): string {
		if (options.treeUri) return `device:${options.treeUri}`;
		if (options.folderName) return `device-folder:${options.folderName}`;
		return LAST_LIBRARY_CACHE_KEY;
	}

	// ── IndexedDB persistence (primitives live in $lib/utils/idb) ───
	// saveCachedLibrary / loadDeviceCachedLibrary are view-coupled (they derive
	// the cache key from nativeTreeUri via getDeviceLibraryCacheKey); the generic
	// idbGet/Put/Delete, openIDB, openDriveCacheIDB, handle/library/drive-cache
	// helpers are imported from $lib/utils/idb.
	async function saveCachedLibrary(folderName: string, files: StoredAudioFile[], cacheKey = getDeviceLibraryCacheKey({ treeUri: nativeTreeUri, folderName })) {
		const cachedFiles = files.reduce<CachedLibraryFile[]>((accumulator, file) => {
			if (file.source === 'web') {
				accumulator.push({
					source: 'web',
					name: file.name,
					relativePath: file.relativePath,
					file: file.file,
				});
				return accumulator;
			}

			if (file.source === 'native') {
				accumulator.push({
					source: 'native',
					name: file.name,
					relativePath: file.relativePath,
					path: file.path,
					mimeType: file.mimeType,
					modifiedAt: file.modifiedAt,
				});
			}

			return accumulator;
		}, []);

		if (cachedFiles.length === 0) return;
		try {
			const db = await openIDB();
			const payload = { folderName, files: cachedFiles, savedAt: Date.now(), cacheKey } satisfies CachedLibrary;
			await idbPut(db, 'libraries', payload, cacheKey);
			if (cacheKey !== LAST_LIBRARY_CACHE_KEY) {
				await idbPut(db, 'libraries', payload, LAST_LIBRARY_CACHE_KEY);
			}
			db.close();
		}
		catch { /* ignore cache write failures */ }
	}
	async function loadDeviceCachedLibrary(treeUri: string | null, folderName: string): Promise<CachedLibrary | null> {
		const cacheKey = getDeviceLibraryCacheKey({ treeUri, folderName });
		const cached = await loadCachedLibrary(cacheKey);
		if (cached) return cached;
		if (cacheKey === LAST_LIBRARY_CACHE_KEY) return null;
		const fallback = await loadCachedLibrary(LAST_LIBRARY_CACHE_KEY);
		return fallback?.folderName === folderName ? fallback : null;
	}

	function restoreStoredFilesFromCache(cachedLibrary: CachedLibrary): StoredAudioFile[] {
		return cachedLibrary.files.map((file) => {
			if (file.source === 'web') {
				return createStoredWebAudioFile(file.file, file.relativePath);
			}

			return {
				source: 'native',
				name: file.name,
				relativePath: file.relativePath,
				path: file.path,
				mimeType: file.mimeType,
				modifiedAt: file.modifiedAt,
			} satisfies StoredAudioFile;
		});
	}

	function hydrateTracksFromLibrary(files: StoredAudioFile[], resetToStart = false) {
		const sorted = sortFiles(files);
		tracks = sorted.map((file, index) => {
			const { title, artist } = parseFilename(file.name);
			return {
				id: index,
				title,
				artist,
				filename: file.name,
				url: '',
				duration: 0,
				cleanup: undefined,
				source: file,
			};
		});
		mediaEngine.musicSelectionLoopActive = false;

		if (tracks.length === 0) {
			musicSettings.lastTrackIndex = 0;
			musicSettings.lastTrackTimestamp = 0;
			currentTime = 0;
			duration = 0;
			isPlaying = false;
			if (audioEl) { audioEl.pause(); audioEl.src = ''; }
			return;
		}

		if (resetToStart) {
			// New folder: stop playback, clear audio, reset to track 0
			if (audioEl) { audioEl.pause(); audioEl.src = ''; }
			isPlaying = false;
			musicSettings.lastTrackIndex = 0;
			musicSettings.lastTrackTimestamp = 0;
			currentTime = 0;
			duration = 0;
		} else {
			// Restore: find track by key (survives re-sort), fallback to saved index
			if (musicSettings.lastTrackKey) {
				const keyMatch = tracks.findIndex(t => getTrackKey(t.source) === musicSettings.lastTrackKey);
				if (keyMatch >= 0) {
					musicSettings.lastTrackIndex = keyMatch;
				} else {
					musicSettings.lastTrackIndex = Math.min(musicSettings.lastTrackIndex, tracks.length - 1);
				}
			} else {
				musicSettings.lastTrackIndex = Math.min(musicSettings.lastTrackIndex, tracks.length - 1);
			}
			currentTime = 0;
		}
	}

	// ── ephemeral playback state ──
	let tracks      = $state<Track[]>([]);
	let currentTime = $state(0);
	let duration    = $state(0);
	let isPlaying      = $state(false);
	let isBuffering    = $state(false);
	let isChangingTrack = $state(false); // prevents concurrent skip/select calls
	let isLoading        = $state(false);
	let loadingFolderPath = $state<string | null>(null); // per-folder spinner key
	let queueSessionId = 0;
	let showQueue   = $state(false);   // true → browse / folder view
	let showFavoriteTracks = $state(false);

	// ── Swipe left in full player → go back to browse list ───────
	// Wired via use:swipeBack on the player container in the template below.

	let showPanel   = $state<'none' | 'speed' | 'eq'>('none');
	let isRestoring = $state(true);  // true until IDB check finishes (prevents empty-state flash)
	let preloadedTrackIndex = $state<number | null>(null);
	let preloadRequestId = 0;
	// Prevents background folder scans from overwriting the track list after the user has
	// explicitly selected a song via playBrowseFile / playCurrentFolder / playFolderPath.
	let trackListLockedByUser = false;
	let libraryScanPromise: Promise<StoredAudioFile[]> | null = null;
	// Progress of the background full-library index scan (null when not scanning)
	let scanProgress = $state<{ pct: number; filesFound: number } | null>(null);

	// ── folder browse state ──
	// rootDirHandle and allFiles MUST be $state so hasFolderLoaded $derived updates
	let rootDirHandle    = $state<FileSystemDirectoryHandle | null>(null);
	let nativeTreeUri    = $state<string | null>(null);
	let pendingHandle    = $state<FileSystemDirectoryHandle | null>(null); // needs permission
	let allFiles         = $state<StoredAudioFile[]>([]);     // web/native metadata-backed library
	let browsePath       = $state<string[]>([]);                 // navigation stack
	let browseEntries    = $state<BrowseEntry[]>([]);
	let fileSearchQuery  = $state('');
	let browseLoading    = $state(false);
	let browseVersion    = $state(0);                          // bump to force reload
	let deckFolderLabel  = $state('Library');                      // per-deck folder name
	let selectedBrowseFileKeys = $state<string[]>([]);
	let driveAccessToken = $state('');
	let driveTokenExpiresAt = $state(0);
	let driveUser        = $state<GoogleDriveUser | null>(null);
	let driveError       = $state('');
	let driveSearch      = $state('');
	let isDriveAuthenticating = $state(false);
	let isDriveLoading   = $state(false);
	let driveLoadProgress = $state({ filesFound: 0, foldersScanned: 0, foldersQueued: 0 });
	let driveLoadAbort   = $state<AbortController | null>(null);
	let switchingToFavId = $state<string | null>(null); // fav id currently loading
	let seekingValue     = $state<number | null>(null); // % while slider is dragged
	let browseLongPressTimer: ReturnType<typeof setTimeout> | null = null;
	let longPressHandledFileKey = $state<string | null>(null);

	// ── Filtered browse entries (search by name) ─────────────────
	const filteredEntries = $derived(
		fileSearchQuery.trim().length === 0
			? browseEntries
			: browseEntries.filter(e =>
				e.name.toLowerCase().includes(fileSearchQuery.toLowerCase())
			)
	);
	const selectedBrowseCount = $derived(selectedBrowseFileKeys.length);
	const filteredFavoriteTracks = $derived.by(() => {
		const query = fileSearchQuery.trim().toLowerCase();
		const favorites = musicSettings.favoriteTracks.map((favorite) => ({
			favorite,
			file: resolveFavoriteTrackFile(favorite),
		}));

		if (!query) return favorites;

		return favorites.filter(({ favorite }) => {
			const haystack = `${favorite.title} ${favorite.artist} ${favorite.name}`.toLowerCase();
			return haystack.includes(query);
		});
	});
	const DRIVE_FOLDER_PICKER_PENDING_KEY = 'google-drive-folder-picker-pending';
	// ── Drive folder picker dialog state ──
	let showFolderPicker      = $state(false);
	let folderPickerFolders   = $state<GoogleDriveFolder[]>([]);
	let folderPickerLoading   = $state(false);
	let folderPickerError     = $state('');
	let folderPickerStack     = $state<{ id: string; name: string }[]>([]);
	let folderPickerToken     = $state('');
	let folderHasSubFolders   = $state<Record<string, boolean>>({}); // folderId → has subfolders
	let hasRestoredPendingDriveFolderPicker = false;
	let isRestoringPendingDriveFolderPicker = false;
	let pendingDriveFolderPickerRestoreTimers: number[] = [];

	// ── Web Audio API (lazy-init) ──
	let audioCtx: AudioContext | null = null;
	let eqAvailable = $state(true);  // false if AudioContext creation fails
	let filters: BiquadFilterNode[] = [];

	// ── refs ──
	let audioEl: HTMLAudioElement;
	let folderInputEl: HTMLInputElement;
	let nativeFileInputEl: HTMLInputElement;

	// ── derived ──
	const currentTrack    = $derived(tracks[musicSettings.lastTrackIndex] as Track | undefined);
	const currentTrackIsFavorite = $derived(currentTrack ? isFavoriteTrack(currentTrack.source) : false);
	const currentMusicTrackKey = $derived(
		musicSettings.lastTrackKey || (currentTrack ? getStoredFileKey(currentTrack.source) : '')
	);

	const hasFolderLoaded = $derived(rootDirHandle !== null || nativeTreeUri !== null || allFiles.length > 0);
	const currentLibraryLabel = $derived(
		musicSettings.librarySource === 'drive' ? 'Google Drive' : deckFolderLabel
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
			if (audioEl && isPlaying) {
				audioEl.pause();
			}
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
				() => { void advanceTrack(isPlaying || isBuffering); },
				() => { void prevTrack(); }
			);
		}
	}

	// ── When this deck becomes the active music deck, claim transport controls
	//     and sync track info / progress / volume / playing state to the
	//     MiniPlayer so it always reflects the deck you're looking at. ──
	$effect(() => {
		if (mediaEngine.activeMusicDeck === deck) {
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
					audioEl?.currentTime ?? 0,
					isFinite(audioEl?.duration ?? 0) ? (audioEl?.duration ?? 0) : (currentTrack.duration ?? 0)
				);
				if (deck === 'A') {
					mediaEngine.musicPlayingA = isPlaying;
				} else {
					mediaEngine.musicPlayingB = isPlaying;
				}
			} else {
				// No track loaded in this deck — clear the display but keep
				// source='music' so the MiniPlayer stays visible if the other
				// deck is actively playing.
				mediaEngine.item = null;
				mediaEngine.currentTime = 0;
				mediaEngine.duration = 0;
			}
		}
	});

	// MediaSession play/pause/seek handlers are managed by mediaEngine directly.

	function syncTrackToMediaEngine(index: number) {
		const track = tracks[index];
		if (!track) return;
		mediaEngine.setNowPlaying({
			id:         String(track.id),
			source:     'music',
			title:      track.title,
			subtitle:   track.artist,
			audioUrl:   '',
			artworkUrl: undefined,
			duration:   track.duration > 0 ? track.duration : undefined,
		}, 'music');
		claimMusicControls();
	}

	// ── reload browse entries when path or folder version changes ──
	$effect(() => {
		const path = [...browsePath];
		const driveFilter = driveSearch.trim().toLowerCase();
		browseVersion; // reactive dependency
		musicSettings.librarySource;
		void loadBrowseEntries(path, driveFilter);
	});

	$effect(() => {
		const availableBrowseFileKeys = new Set(
			browseEntries
				.filter((entry): entry is BrowseEntry & { kind: 'file' } => entry.kind === 'file')
				.map((entry) => getStoredFileKey(entry.file))
		);
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

	// ── audio element event wiring ──
	$effect(() => {
		if (!audioEl) return;
		// Throttle timeupdate to ~4Hz — smooth for seek bar, 15× less CPU than 60fps
		let _lastTimeUpdate = 0;
		const onTimeUpdate = () => {
			if (seekingValue !== null) return;
			const now = Date.now();
			if (now - _lastTimeUpdate < 250) return;
			_lastTimeUpdate = now;
			currentTime = audioEl.currentTime;
			// Only push progress to the MiniPlayer when this deck is active,
			// otherwise both decks fight over mediaEngine.currentTime and the
			// slider jumps between the two positions.
			if (mediaEngine.activeMusicDeck === deck) {
				mediaEngine.updateTime(audioEl.currentTime, isFinite(audioEl.duration) ? audioEl.duration : 0);
			}
		};
		const onLoadedMetadata = () => {
			duration = isFinite(audioEl.duration) ? audioEl.duration : 0;
			tracks = tracks.map((t, i) =>
				i === musicSettings.lastTrackIndex
					? { ...t, duration: isFinite(audioEl.duration) ? Math.round(audioEl.duration) : 0 }
					: t
			);
		};
		const onPlay  = () => { isPlaying = true;  isBuffering = false; mediaEngine[deck === 'A' ? 'musicPlayingA' : 'musicPlayingB'] = true;  };
		const onPause = () => {
			isPlaying = false;
			mediaEngine[deck === 'A' ? 'musicPlayingA' : 'musicPlayingB'] = false;
			musicSettings.lastTrackTimestamp = 0;
		};
		const onEnded = () => {
			// Track finished — clear any saved resume position
			isBuffering = false;
			musicSettings.lastTrackTimestamp = 0;
			if (mediaEngine.musicSelectionLoopActive) { void advanceTrack(true, false); }
			else if (musicSettings.isRepeat) { audioEl.currentTime = 0; safePlay(); }
			else void advanceTrack(true, false);
		};
		const onWaiting = () => { isBuffering = true; };
		const onPlaying = () => { isBuffering = false; };
		const onError = () => { isBuffering = false; void advanceTrack(true, false); };
		audioEl.volume = musicSettings[deckVolKey] / 100;
		audioEl.muted  = musicSettings.isMuted;
		audioEl.playbackRate = musicSettings.playbackSpeed;
		audioEl.addEventListener('timeupdate',     onTimeUpdate);
		audioEl.addEventListener('loadedmetadata', onLoadedMetadata);
		audioEl.addEventListener('play',    onPlay);
		audioEl.addEventListener('pause',   onPause);
		audioEl.addEventListener('ended',   onEnded);
		audioEl.addEventListener('error',   onError);
		audioEl.addEventListener('waiting', onWaiting);
		audioEl.addEventListener('playing', onPlaying);
		return () => {
			audioEl?.removeEventListener('timeupdate',     onTimeUpdate);
			audioEl?.removeEventListener('loadedmetadata', onLoadedMetadata);
			audioEl?.removeEventListener('play',    onPlay);
			audioEl?.removeEventListener('pause',   onPause);
			audioEl?.removeEventListener('ended',   onEnded);
			audioEl?.removeEventListener('error',   onError);
			audioEl?.removeEventListener('waiting', onWaiting);
			audioEl?.removeEventListener('playing', onPlaying);
		};
	});

	// ── Sync volume / mute ──
	$effect(() => {
		if (audioEl) { audioEl.volume = musicSettings[deckVolKey] / 100; audioEl.muted = musicSettings.isMuted; }
	});

	// ── Sync playback speed ──
	$effect(() => { if (audioEl) audioEl.playbackRate = musicSettings.playbackSpeed; });

	// ── Auto-save to Drive when key music settings change ──
	$effect(() => {
		// Access reactive fields so Svelte tracks them
		void musicSettings.driveFolderId;
		void musicSettings.driveFolderName;
		void musicSettings.favoriteFolders;
		void musicSettings.playbackSpeed;
		void musicSettings.equalizerPreset;
		void musicSettings.sortOrder;
		driveConfigSync.scheduleSave();
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
		if (!audioEl || !eqAvailable) return;
		if (audioCtx) { if (audioCtx.state === 'suspended') audioCtx.resume(); return; }
		try {
			const ctx = new AudioContext();
			void ctx.resume();
			const src = ctx.createMediaElementSource(audioEl);
			const bands = createEqFilterChain(ctx, musicSettings.eqBands);
			src.connect(bands[0]);
			bands[bands.length - 1].connect(ctx.destination);
			filters = bands;
			audioCtx = ctx;
		} catch (e) {
			eqAvailable = false;
			addToast({ message: 'Equalizer not available on this device.', type: 'warning' });
			console.warn('AudioContext creation failed:', e);
		}
	}

	/** Retry audioEl.play() on AbortError — Android WebView can abort when
	 *  the source isn't ready yet, especially after setting src. */
	function safePlay(onFailure?: () => void, onSuccess?: () => void) {
		const tryPlay = (attempt: number) => {
			audioEl!.play().then(() => {
				onSuccess?.();
			}).catch((err: Error) => {
				if (err?.name === 'AbortError' && attempt < 3) {
					setTimeout(() => tryPlay(attempt + 1), 150);
				} else {
					onFailure?.();
				}
			});
		};
		tryPlay(0);
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

	// ─────────────────────────────────────────────────────────────
	// General helpers
	// ─────────────────────────────────────────────────────────────
	function revokeAll() {
		preloadRequestId += 1;
		preloadedTrackIndex = null;
		tracks.forEach((track) => {
			track.cleanup?.();
			if (track.url?.startsWith('blob:')) {
				URL.revokeObjectURL(track.url);
			}
		});
	}

	function releaseTrackUrl(index: number) {
		const track = tracks[index];
		if (!track?.url && !track?.cleanup) {
			return;
		}

		if (preloadedTrackIndex === index) {
			preloadedTrackIndex = null;
		}

		track.cleanup?.();
		if (track.url?.startsWith('blob:')) {
			URL.revokeObjectURL(track.url);
		}

		tracks = tracks.map((current, currentIndex) => {
			return currentIndex === index ? { ...current, url: '', cleanup: undefined } : current;
		});
	}
	function sortFiles(files: StoredAudioFile[]): StoredAudioFile[] {
		return sortStoredFiles(files, musicSettings.sortOrder);
	}

	function pathToString(path: string[]): string | undefined {
		return path.length > 0 ? path.join('/') : undefined;
	}
	function createFavoriteTrack(file: StoredAudioFile): FavoriteTrack {
		const parsed = parseFilename(file.name);
		const baseFavorite = {
			key: getStoredFileKey(file),
			name: file.name,
			title: parsed.title,
			artist: parsed.artist,
			relativePath: getRelativePath(file),
			source: file.source,
		};

		if (file.source === 'native') {
			return {
				...baseFavorite,
				path: file.path,
				mimeType: file.mimeType,
				modifiedAt: file.modifiedAt,
			};
		}

		if (file.source === 'drive') {
			return {
				...baseFavorite,
				fileId: file.fileId,
				mimeType: file.mimeType,
				modifiedAt: file.modifiedAt,
				sizeBytes: file.sizeBytes,
				webViewLink: file.webViewLink,
			};
		}

		return baseFavorite;
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
		return musicSettings.favoriteTracks.some((favorite) => favorite.key === key);
	}

	function toggleFavoriteTrack(file: StoredAudioFile): void {
		const favorite = createFavoriteTrack(file);
		const exists = musicSettings.favoriteTracks.some((entry) => entry.key === favorite.key);
		musicSettings.favoriteTracks = exists
			? musicSettings.favoriteTracks.filter((entry) => entry.key !== favorite.key)
			: [...musicSettings.favoriteTracks, favorite];
	}

	function removeFavoriteTrack(key: string): void {
		musicSettings.favoriteTracks = musicSettings.favoriteTracks.filter((favorite) => favorite.key !== key);
	}

	function getResolvedFavoriteTrackFiles(): StoredAudioFile[] {
		const seen = new Set<string>();
		const files: StoredAudioFile[] = [];

		for (const favorite of musicSettings.favoriteTracks) {
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
		}
	}

	/** Load selected tracks into the queue without starting playback.
	 *  Updates tracks, mediaEngine item, and musicSelectionLoopActive so the
	 *  MiniPlayer and media notification show the loaded track immediately. */
	function preloadLoopSelection() {
		const selectedFiles = getSelectedBrowseFilesInOrder();
		if (selectedFiles.length === 0) return;
		const label = browsePath.length > 0 ? browsePath[browsePath.length - 1] : musicSettings.lastFolderName;
		loadTracks(selectedFiles, label, { selectionLoop: true });
		musicSettings.lastTrackIndex = 0;
		musicSettings.lastTrackTimestamp = 0;
		syncTrackToMediaEngine(0);
	}

	function clearBrowseSelection() {
		selectedBrowseFileKeys = [];
		mediaEngine.musicSelectionLoopActive = false;
	}

	async function playFavoriteTrack(favorite: FavoriteTrack) {
		if (isChangingTrack) return;
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

			loadTracks(files, 'Favorite Tracks');
			const sortedFiles = sortFiles(files);
			const nextIndex = sortedFiles.findIndex((file) => getStoredFileKey(file) === favorite.key);
			setCurrentTrack(Math.max(0, nextIndex));
			currentTime = 0;
			duration = 0;
			await startAudioAt(musicSettings.lastTrackIndex);
		} finally {
			isChangingTrack = false;
		}
	}

	function getCurrentBrowseFileEntries(): (BrowseEntry & { kind: 'file' })[] {
		return browseEntries.filter((entry): entry is BrowseEntry & { kind: 'file' } => entry.kind === 'file');
	}

	function getSelectedBrowseFilesInOrder(): StoredAudioFile[] {
		if (selectedBrowseFileKeys.length === 0) return [];
		const fileByKey = new Map(
			getCurrentBrowseFileEntries().map((entry) => [getStoredFileKey(entry.file), entry.file])
		);
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

	function collectStoredFilesFromSnapshot(files: StoredAudioFile[], path: string[]): StoredAudioFile[] {
		const prefix = path.length > 0 ? path.join('/') + '/' : '';
		return sortFiles(files.filter((file) => {
			const relativePath = getRelativePath(file);
			return prefix ? relativePath.startsWith(prefix) : true;
		}));
	}
	async function yieldScanToUi(): Promise<void> {
		if (typeof window === 'undefined') return;
		await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
	}

	async function scanNativeAudioFiles(
		path: string[],
		batchSize: number,
		options: { initialBatchSize?: number } = {},
		onBatch?: (batch: StoredAudioFile[], state: { done: boolean; foldersScanned: number; foldersQueued: number; totalFiles: number }) => Promise<void> | void,
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
				const mappedBatch = batch.files.map((file) => createStoredNativeAudioFile(file));
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

	function startLibraryScan(folderName: string, options: { resetExistingFiles?: boolean } = {}) {
		if (options.resetExistingFiles) {
			allFiles = [];
			browseVersion += 1;
		}
		scanProgress = { pct: 0, filesFound: 0 };
		let scanPromise: Promise<StoredAudioFile[]> | null = null;
		scanPromise = (async (): Promise<StoredAudioFile[]> => {
			if (rootDirHandle) {
				// Web File System API — no batch progress available; scan runs to completion
				const result = await collectStoredFilesFromDirHandle(rootDirHandle);
				return result;
			}

			if (nativeTreeUri) {
				return scanNativeAudioFiles([], BACKGROUND_LIBRARY_SCAN_BATCH_SIZE, {}, async (mappedBatch: StoredAudioFile[], state) => {
					if (scanPromise && libraryScanPromise === scanPromise) {
						allFiles = [...allFiles, ...mappedBatch];
						browseVersion += 1;
						const total = state.foldersScanned + state.foldersQueued;
						const pct = total > 0 ? Math.min(99, Math.round((state.foldersScanned / total) * 100)) : 1;
						scanProgress = { pct, filesFound: allFiles.length };
					}
				});
			}

			return allFiles;
		})();

		libraryScanPromise = scanPromise;
		void scanPromise
			.then(async (scannedFiles) => {
				if (libraryScanPromise !== scanPromise) return;
				allFiles = scannedFiles;
				scanProgress = null;
				if (!trackListLockedByUser) hydrateTracksFromLibrary(scannedFiles);
				await saveCachedLibrary(folderName, scannedFiles, getDeviceLibraryCacheKey({ treeUri: nativeTreeUri, folderName }));
			})
			.catch((error) => {
				console.error('Failed to scan selected library.', error);
			})
			.finally(() => {
				if (libraryScanPromise === scanPromise) {
					libraryScanPromise = null;
					scanProgress = null;
				}
			});
	}

	// ── Per-track resume helpers ──────────────────────────────────

	/** Sync both lastTrackIndex and lastTrackKey together */
	function setCurrentTrack(index: number) {
		musicSettings.lastTrackIndex = index;
		musicSettings.lastTrackKey = tracks[index] ? getTrackKey(tracks[index].source) : '';
	}
	const formatDriveAuthError = formatGoogleDriveAuthError;

	function hasPendingDriveFolderPickerIntent(): boolean {
		if (typeof localStorage === 'undefined') {
			return false;
		}

		return localStorage.getItem(DRIVE_FOLDER_PICKER_PENDING_KEY) === '1';
	}

	function markDriveFolderPickerPending() {
		if (typeof localStorage === 'undefined') {
			return;
		}

		localStorage.setItem(DRIVE_FOLDER_PICKER_PENDING_KEY, '1');
	}

	function clearPendingDriveFolderPickerIntent() {
		if (typeof localStorage === 'undefined') {
			return;
		}

		localStorage.removeItem(DRIVE_FOLDER_PICKER_PENDING_KEY);
	}

	async function restorePendingDriveFolderPickerIfNeeded(): Promise<boolean> {
		if (!hasPendingDriveFolderPickerIntent() || isRestoringPendingDriveFolderPicker) {
			return false;
		}

		isRestoringPendingDriveFolderPicker = true;
		try {
			const token = await ensureDriveAccessToken(false);
			if (!token) {
				return false;
			}

			folderPickerToken = token;
			isDriveAuthenticating = false;
			isDriveLoading = false;
			clearPendingDriveFolderPickerRestoreTimers();
			if (!showFolderPicker) {
				await openFolderPicker();
			}

			return true;
		} finally {
			isRestoringPendingDriveFolderPicker = false;
		}
	}

	function schedulePendingDriveFolderPickerRestore() {
		if (typeof window === 'undefined') {
			return;
		}

		pendingDriveFolderPickerRestoreTimers.forEach((timer) => window.clearTimeout(timer));
		pendingDriveFolderPickerRestoreTimers = [750, 1500, 3000, 6000].map((delay) => window.setTimeout(() => {
			if (!hasPendingDriveFolderPickerIntent() || showFolderPicker) {
				return;
			}

			void restorePendingDriveFolderPickerIfNeeded();
		}, delay));
	}

	function clearPendingDriveFolderPickerRestoreTimers() {
		if (typeof window === 'undefined') {
			return;
		}

		pendingDriveFolderPickerRestoreTimers.forEach((timer) => window.clearTimeout(timer));
		pendingDriveFolderPickerRestoreTimers = [];
	}

	function hasValidDriveToken(): boolean {
		return driveAccessToken.length > 0 && Date.now() < driveTokenExpiresAt - 60_000;
	}

	async function ensureDriveAccessToken(interactive: boolean): Promise<string | null> {
		if (hasValidDriveToken()) {
			return driveAccessToken;
		}

		// Hydrate silently from the persisted session (survives page refresh)
		googleDriveSession.hydrateFromStorage();
		if (googleDriveSession.hasValidToken()) {
			driveAccessToken = googleDriveSession.accessToken;
			driveTokenExpiresAt = googleDriveSession.expiresAt;
			driveUser = googleDriveSession.user;
			return driveAccessToken;
		}

		try {
			const pendingNativeAuthorization = await consumePendingGoogleDriveAccessToken();
			if (pendingNativeAuthorization?.access_token) {
				driveAccessToken = pendingNativeAuthorization.access_token;
				driveTokenExpiresAt = Date.now() + Number(pendingNativeAuthorization.expires_in ?? 3600) * 1000;
				driveUser = googleDriveSession.user;
				driveError = '';
				googleDriveSession.accessToken = driveAccessToken;
				googleDriveSession.expiresAt = driveTokenExpiresAt;
				googleDriveSession.persist();
				return driveAccessToken;
			}
		} catch {
			// Native auth recovery is best-effort; fall through to the normal flow.
		}

		if (!interactive) {
			return null;
		}

		try {
			const response = await requestGoogleDriveAccessToken({
				clientId: googleDriveClientId,
				prompt: driveAccessToken ? '' : 'consent'
			});

			driveAccessToken = response.access_token;
			driveTokenExpiresAt = Date.now() + Number(response.expires_in ?? 3600) * 1000;
			driveError = '';
			// Persist so HMR / page reload can silently restore without re-signing in
			googleDriveSession.accessToken = driveAccessToken;
			googleDriveSession.expiresAt = driveTokenExpiresAt;
			googleDriveSession.persist();
			return driveAccessToken;
		} catch (error) {
			driveError = formatDriveAuthError(error);
			return null;
		}
	}

	function activateDeviceLibrary(folderName: string) {
		musicSettings.librarySource = 'device';
		musicSettings.lastFolderName = folderName;
		deckFolderLabel = folderName;
		driveSearch = '';
	}

	function activateDriveLibrary() {
		musicSettings.librarySource = 'drive';
		musicSettings.nativeTreeUri = '';
		musicSettings.lastFolderName = 'Google Drive';
		libraryScanPromise = null;
		rootDirHandle = null;
		nativeTreeUri = null;
		pendingHandle = null;
		browsePath = [];
		showQueue = true;
		showPanel = 'none';
		browseVersion += 1;
	}

	async function loadDriveLibrary(interactive: boolean) {
		if (!googleDriveConfigured) {
			driveError = 'Google Drive is not configured. Add PUBLIC_GOOGLE_CLIENT_ID to enable sign-in.';
			clearPendingDriveFolderPickerIntent();
			return;
		}

		if (interactive) {
			markDriveFolderPickerPending();
			schedulePendingDriveFolderPickerRestore();
		}

		isDriveAuthenticating = interactive;
		isDriveLoading = true;

		try {
			const token = await ensureDriveAccessToken(interactive);
			if (!token) {
				clearPendingDriveFolderPickerIntent();
				return;
			}
			driveError = '';

			void fetchGoogleDriveUser(token)
				.then((user) => {
					driveUser = user;
				})
				.catch(() => {
					// Folder selection should still work even if the user profile request fails.
				});

			// Connect config sync (appdata scope) silently, then download + apply saved settings.
			// This happens in the background — we don't block the folder picker on it,
			// and we never start a second interactive auth flow from this button press.
			void (async () => {
				const connected = await driveConfigSync.connect(false);
				if (connected) {
					await driveConfigSync.downloadAndApply();
				}
			})();

			// Show folder picker before loading files
			folderPickerToken = token;
			folderPickerStack = [];
			isDriveLoading = false;
			isDriveAuthenticating = false;
			await openFolderPicker();
		} catch (error) {
			driveError = formatDriveAuthError(error);
		} finally {
			isDriveAuthenticating = false;
			isDriveLoading = false;
		}
	}

	async function openFolderPicker() {
		folderPickerStack = [];
		folderPickerFolders = [];
		folderPickerError = '';
		showFolderPicker = true;
		await loadFolderPickerLevel();
	}

	async function loadFolderPickerLevel() {
		folderPickerLoading = true;
		folderPickerError = '';
		try {
			const parentId = folderPickerStack.at(-1)?.id;
			folderPickerFolders = await listGoogleDriveFolders(folderPickerToken, parentId);
			// Fire parallel sub-folder existence checks for any unchecked folders
			const unchecked = folderPickerFolders.filter(f => !(f.id in folderHasSubFolders));
			if (unchecked.length > 0) {
				const results = await Promise.allSettled(
					unchecked.map(f => checkFolderHasSubfolders(folderPickerToken, f.id))
				);
				const updates: Record<string, boolean> = {};
				unchecked.forEach((f, i) => {
					const r = results[i];
					updates[f.id] = r.status === 'fulfilled' ? r.value : false;
				});
				folderHasSubFolders = { ...folderHasSubFolders, ...updates };
			}
		} catch (error) {
			folderPickerFolders = [];
			folderPickerError = formatDriveAuthError(error);
		} finally {
			folderPickerLoading = false;
		}
	}

	async function navigateFolderPickerInto(folder: GoogleDriveFolder) {
		folderPickerStack = [...folderPickerStack, { id: folder.id, name: folder.name }];
		await loadFolderPickerLevel();
	}

	async function navigateFolderPickerBack() {
		folderPickerStack = folderPickerStack.slice(0, -1);
		await loadFolderPickerLevel();
	}

	async function confirmDriveFolderSelection(folderId?: string, folderName?: string) {
		showFolderPicker = false;
		clearPendingDriveFolderPickerIntent();
		musicSettings.driveFolderId = folderId ?? '';
		musicSettings.driveFolderName = folderName ?? '';
		// Switch to drive source immediately so the restoration $effect doesn't
		// re-hydrate the device library during async pauses inside finishDriveLoad.
		musicSettings.librarySource = 'drive';
		rootDirHandle = null;
		nativeTreeUri = null;
		libraryScanPromise = null;
		const token = folderPickerToken;
		folderPickerToken = '';
		await finishDriveLoad(token, folderId);
	}

	function cancelFolderPicker() {
		showFolderPicker = false;
		clearPendingDriveFolderPickerIntent();
		folderPickerToken = '';
		folderPickerStack = [];
		folderPickerFolders = [];
		folderPickerError = '';
	}

	// ── Folder favorites ──────────────────────────────────────────
	function currentFolderAsFavorite() {
		if (musicSettings.librarySource === 'drive') {
			return {
				id: musicSettings.driveFolderId || '_all',
				name: musicSettings.driveFolderName || 'All files',
				source: 'drive' as const,
			};
		}
		if (nativeTreeUri) {
			return {
				id: nativeTreeUri,
				name: musicSettings.lastFolderName,
				source: 'device' as const,
				treeUri: nativeTreeUri,
			};
		}
		return null;
	}

	function isCurrentFolderFavorited(): boolean {
		const entry = currentFolderAsFavorite();
		if (!entry) return false;
		return musicSettings.favoriteFolders.some(f => f.id === entry.id && f.source === entry.source);
	}

	function toggleCurrentFolderFavorite() {
		const entry = currentFolderAsFavorite();
		if (!entry) return;
		const idx = musicSettings.favoriteFolders.findIndex(f => f.id === entry.id && f.source === entry.source);
		if (idx >= 0) {
			musicSettings.favoriteFolders = musicSettings.favoriteFolders.filter((_, i) => i !== idx);
		} else {
			musicSettings.favoriteFolders = [...musicSettings.favoriteFolders, entry];
		}
	}

	function removeFavoriteFolder(id: string, source: string) {
		musicSettings.favoriteFolders = musicSettings.favoriteFolders.filter(f => !(f.id === id && f.source === source));
	}

	function isDriveFolderPickerFavorited(folderId: string): boolean {
		return musicSettings.favoriteFolders.some(f => f.id === folderId && f.source === 'drive');
	}

	function toggleDriveFolderPickerFavorite(folder: GoogleDriveFolder, e: MouseEvent) {
		e.stopPropagation();
		const idx = musicSettings.favoriteFolders.findIndex(f => f.id === folder.id && f.source === 'drive');
		if (idx >= 0) {
			musicSettings.favoriteFolders = musicSettings.favoriteFolders.filter((_, i) => i !== idx);
		} else {
			musicSettings.favoriteFolders = [...musicSettings.favoriteFolders, { id: folder.id, name: folder.name, source: 'drive' as const }];
		}
	}

	async function switchToFavorite(fav: (typeof musicSettings.favoriteFolders)[0]) {
		showFavoriteTracks = false;
		switchingToFavId = fav.id;
		try {
		if (fav.source === 'drive') {
			const folderId = fav.id === '_all' ? undefined : fav.id;
			musicSettings.librarySource = 'drive';
			musicSettings.driveFolderId = folderId ?? '';
			musicSettings.driveFolderName = folderId ? fav.name : '';
			const token = await ensureDriveAccessToken(true);
			if (!token) { switchingToFavId = null; return; }
			if (!driveUser) {
				try { driveUser = await fetchGoogleDriveUser(token); } catch { /* ignore */ }
			}
			await finishDriveLoad(token, folderId);
		} else if (fav.source === 'device' && fav.treeUri) {
			rootDirHandle = null;
			nativeTreeUri = fav.treeUri;
			musicSettings.nativeTreeUri = fav.treeUri;
			pendingHandle = null;
			libraryScanPromise = null;
			allFiles = [];
			activateDeviceLibrary(fav.name);
			browsePath = [];
			browseVersion++;
			showQueue = true;
			const cachedLibrary = await loadDeviceCachedLibrary(fav.treeUri, fav.name);
			if (cachedLibrary && cachedLibrary.files.length > 0) {
				allFiles = restoreStoredFilesFromCache(cachedLibrary);
				hydrateTracksFromLibrary(allFiles);
				browseVersion++;
			}
		}
		} finally {
			switchingToFavId = null;
		}
	}

	async function rescanCurrentLibraryIndex() {
		if (musicSettings.librarySource === 'drive') {
			await refreshGoogleDrive();
			return;
		}

		const folderName = musicSettings.lastFolderName || 'Library';
		const cacheKey = getDeviceLibraryCacheKey({ treeUri: nativeTreeUri, folderName });
		await deleteCachedLibrary(cacheKey);
		if (cacheKey !== LAST_LIBRARY_CACHE_KEY) {
			await deleteCachedLibrary(LAST_LIBRARY_CACHE_KEY);
		}

		if (nativeTreeUri || rootDirHandle) {
			startLibraryScan(folderName, { resetExistingFiles: true });
		}
	}

	function confirmCurrentFolder() {
		const current = folderPickerStack.at(-1);
		if (current) {
			void confirmDriveFolderSelection(current.id, current.name);
		} else {
			void confirmDriveFolderSelection(undefined, undefined);
		}
	}

	async function finishDriveLoad(token: string, folderId?: string, forceRefresh = false) {
		// Cancel any in-progress load
		driveLoadAbort?.abort();
		const ctrl = new AbortController();
		driveLoadAbort = ctrl;

		isDriveLoading = true;
		driveLoadProgress = { filesFound: 0, foldersScanned: 0, foldersQueued: 0 };
		driveError = '';

		const cacheKey = folderId ?? '_all';

		try {
			if (!forceRefresh) {
				const cached = await loadDriveCache(cacheKey);
				if (cached && !ctrl.signal.aborted) {
					// Instant restore from IDB — use cached file list immediately
					if (audioEl) { audioEl.pause(); audioEl.src = ''; }
					isPlaying = false; currentTime = 0; duration = 0; tracks = [];
					allFiles = cached.map(createStoredDriveAudioFile);
					driveLoadProgress = { filesFound: cached.length, foldersScanned: 0, foldersQueued: 0 };
					activateDriveLibrary();
					isDriveLoading = false;

					// Background refresh — update silently without blocking UI
					void (async () => {
						const freshFiles: GoogleDriveFile[] = [];
						try {
							for await (const batch of streamGoogleDriveMp3Files(token, { folderId, signal: ctrl.signal })) {
								if (ctrl.signal.aborted) return;
								freshFiles.push(...batch.files);
							}
							if (!ctrl.signal.aborted) {
								allFiles = freshFiles.map(createStoredDriveAudioFile);
								browseVersion += 1;
								await saveDriveCache(cacheKey, freshFiles);
							}
						} catch { /* ignore background refresh errors */ }
					})();
					return;
				}
			}

			// Fresh scan — stop playback then stream files progressively into the UI
			if (audioEl) { audioEl.pause(); audioEl.src = ''; }
			isPlaying = false; currentTime = 0; duration = 0; tracks = [];
			allFiles = [];

			const collectedFiles: GoogleDriveFile[] = [];
			let libraryActivated = false;

			for await (const batch of streamGoogleDriveMp3Files(token, { folderId, signal: ctrl.signal })) {
				if (ctrl.signal.aborted) break;
				collectedFiles.push(...batch.files);
				driveLoadProgress = {
					filesFound: collectedFiles.length,
					foldersScanned: batch.foldersScanned,
					foldersQueued: batch.foldersQueued
				};
				// Append batch to the reactive array as a single assignment (not one-at-a-time)
				const newMapped = batch.files.map(createStoredDriveAudioFile);
				allFiles = [...allFiles, ...newMapped];
				browseVersion += 1; // trigger browse view to refresh with new files

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
				driveError = formatDriveAuthError(error);
			}
		} finally {
			if (driveLoadAbort === ctrl) {
				isDriveLoading = false;
				driveLoadAbort = null;
			}
		}
	}

	function cancelDriveLoad() {
		driveLoadAbort?.abort();
		driveLoadAbort = null;
		isDriveLoading = false;
	}

	async function connectGoogleDrive() {
		await loadDriveLibrary(true);
	}

	async function refreshGoogleDrive() {
		const token = await ensureDriveAccessToken(true);
		if (!token) return;
		const cacheKey = musicSettings.driveFolderId || '_all';
		await bustDriveCache(cacheKey);
		await finishDriveLoad(token, musicSettings.driveFolderId || undefined, true);
	}

	async function changeDriveFolder() {
		markDriveFolderPickerPending();
		const token = await ensureDriveAccessToken(false);
		if (!token) { await loadDriveLibrary(true); return; }
		folderPickerToken = token;
		await openFolderPicker();
	}

	async function signOutGoogleDrive() {
		try {
			await revokeGoogleDriveAccess(driveAccessToken);
		} catch {
			// Ignore revoke failures and clear local session state regardless.
		}

		clearPendingDriveFolderPickerIntent();
		if (tracks.some((track) => track.source.source === 'drive')) {
			audioEl?.pause();
			revokeAll();
			tracks = [];
			currentTime = 0;
			duration = 0;
			isPlaying = false;
		}

		driveAccessToken = '';
		driveTokenExpiresAt = 0;
		driveUser = null;
		driveError = '';
		driveSearch = '';
		driveConfigSync.disconnect();

		if (musicSettings.librarySource === 'drive') {
			allFiles = [];
			browseEntries = [];
			browsePath = [];
			showQueue = false;
			musicSettings.librarySource = 'device';
			musicSettings.lastFolderName = '';
		}
	}

	async function materializeStoredFile(entry: StoredAudioFile, interactiveAuth = false): Promise<File> {
		if (entry.source === 'web') {
			return entry.file;
		}

		if (entry.source === 'drive') {
			const accessToken = await ensureDriveAccessToken(interactiveAuth);
			if (!accessToken) {
				throw new Error('Your Google Drive session has expired. Sign in again to continue playback.');
			}

			return downloadGoogleDriveFile({
				accessToken,
				fileId: entry.fileId,
				fileName: entry.name,
				mimeType: entry.mimeType,
				modifiedAt: entry.modifiedAt,
			});
		}

		const blob = await blobFromNativePath(entry.path, entry.mimeType);
		return new File([blob], entry.name, {
			type: entry.mimeType ?? blob.type ?? 'audio/mpeg',
			lastModified: entry.modifiedAt ?? Date.now(),
		});
	}

	async function pickNativeAudioDirectory(): Promise<{ treeUri: string; folderName: string }> {
		const result = await FilePicker.pickDirectory();
		const directory = await DirectoryReader.listEntries({ treeUri: result.path });
		return {
			treeUri: result.path,
			folderName: directory.folderName,
		};
	}

	// ─────────────────────────────────────────────────────────────
	// Browse — async entry loading
	// ─────────────────────────────────────────────────────────────
	let _browseLoadId = 0;
	async function loadBrowseEntries(path: string[], driveFilter = '') {
		const loadId = ++_browseLoadId;
		browseLoading = true;
		try {
			if (musicSettings.librarySource === 'drive' && driveFilter.trim()) {
			// Search mode: flat filtered list across all Drive files
			const filter = driveFilter.trim();
			const files = sortFiles(allFiles).filter((file) => {
				if (file.source !== 'drive') return false;
				const parsed = parseFilename(file.name);
				const haystack = `${file.name} ${parsed.title} ${parsed.artist}`.toLowerCase();
				return haystack.includes(filter);
			});
			browseEntries = files.map((file) => ({ kind: 'file', name: file.name, file }));
		} else if (allFiles.length > 0) {
			const snapshot = buildBrowseEntries(allFiles, path);
			if (snapshot.length > 0 || libraryScanPromise === null) {
				// Index is complete or partial but has entries for this path — use it instantly
				browseEntries = snapshot;
			} else if (nativeTreeUri) {
				// Scan in progress and this subfolder not yet indexed — live single-level call
				const result = await DirectoryReader.listEntries({ treeUri: nativeTreeUri, path: pathToString(path) });
				if (loadId !== _browseLoadId) return;
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
				browseEntries = [...folders, ...files];
			} else {
				browseEntries = snapshot; // empty but nothing else we can do
			}
		} else if (rootDirHandle) {
				// Navigate to the directory at `path`
				let dir: FileSystemDirectoryHandle = rootDirHandle;
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
								if (h2.kind === 'file' && n2.toLowerCase().endsWith('.mp3')) count++;
							}
						} catch { /* skip */ }
						folders.push({ kind: 'folder', name, count });
					} else if (handle.kind === 'file' && name.toLowerCase().endsWith('.mp3')) {
						files.push({ kind: 'file', name, file: createStoredAudioFile(await (handle as FileSystemFileHandle).getFile()) });
					}
				}
				folders.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
				files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
				browseEntries = [...folders, ...files];
			} else if (nativeTreeUri) {
				const result = await DirectoryReader.listEntries({ treeUri: nativeTreeUri, path: pathToString(path) });
				if (loadId !== _browseLoadId) return;
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
				browseEntries = [...folders, ...files];
			} else {
				if (loadId === _browseLoadId) browseEntries = [];
			}
		} catch { if (loadId === _browseLoadId) browseEntries = []; }
		if (loadId === _browseLoadId) browseLoading = false;
	}

	// ── Collect all MP3s from a directory handle recursively ──
	async function collectFilesFromDirHandle(dir: FileSystemDirectoryHandle): Promise<File[]> {
		const result: File[] = [];
		for await (const [name, handle] of (dir as unknown as AsyncIterable<[string, FileSystemHandle]>)) {
			if (handle.kind === 'file' && name.toLowerCase().endsWith('.mp3')) {
				result.push(await (handle as FileSystemFileHandle).getFile());
			} else if (handle.kind === 'directory') {
				result.push(...await collectFilesFromDirHandle(handle as FileSystemDirectoryHandle));
			}
		}
		return result;
	}

	async function collectStoredFilesFromDirHandle(
		dir: FileSystemDirectoryHandle,
		pathSegments: string[] = []
	): Promise<StoredAudioFile[]> {
		const result: StoredAudioFile[] = [];
		for await (const [name, handle] of (dir as unknown as AsyncIterable<[string, FileSystemHandle]>)) {
			if (handle.kind === 'file' && name.toLowerCase().endsWith('.mp3')) {
				const file = await (handle as FileSystemFileHandle).getFile();
				result.push(createStoredWebAudioFile(file, [...pathSegments, name].join('/')));
			} else if (handle.kind === 'directory') {
				result.push(...await collectStoredFilesFromDirHandle(handle as FileSystemDirectoryHandle, [...pathSegments, name]));
			}
		}
		return result;
	}

	// ── Navigate to a dir handle following a path ──
	async function resolveDirAtPath(path: string[]): Promise<FileSystemDirectoryHandle | null> {
		if (!rootDirHandle) return null;
		let dir: FileSystemDirectoryHandle = rootDirHandle;
		for (const segment of path) {
			let found = false;
			for await (const [name, handle] of (dir as unknown as AsyncIterable<[string, FileSystemHandle]>)) {
				if (handle.kind === 'directory' && name === segment) {
					dir = handle as FileSystemDirectoryHandle; found = true; break;
				}
			}
			if (!found) return null;
		}
		return dir;
	}

	// ── Collect all files under a browse path ──
	async function collectAllFromPath(path: string[]): Promise<StoredAudioFile[]> {
		if (musicSettings.librarySource === 'drive') {
			return collectStoredFilesFromSnapshot(allFiles, path);
		} else if (allFiles.length > 0) {
			return collectStoredFilesFromSnapshot(allFiles, path);
		} else if (libraryScanPromise) {
			const scannedFiles = await libraryScanPromise;
			return collectStoredFilesFromSnapshot(scannedFiles, path);
		} else if (rootDirHandle) {
			const dir = await resolveDirAtPath(path);
			return dir ? (await collectFilesFromDirHandle(dir)).map((file) => createStoredAudioFile(file)) : [];
		} else if (nativeTreeUri) {
			const result = await DirectoryReader.listAudioFiles({ treeUri: nativeTreeUri, path: pathToString(path) });
			return result.files.map((file) => createStoredNativeAudioFile(file));
		}
		return [];
	}

	async function ensureTrackUrl(index: number, interactiveAuth = false): Promise<string | null> {
		const track = tracks[index];
		if (!track) {
			return null;
		}

		if (track.url) {
			return track.url;
		}

		// Fast path for native files: Capacitor converts content:// / file:// paths to a local
		// HTTP bridge URL (http://localhost/_capacitor_content_/... or _capacitor_file_/...).
		// The audio element streams the file progressively via range requests — no need to read
		// the entire file into memory before playback can start.
		if (isNativeApp && track.source.source === 'native') {
			const bridgeUrl = Capacitor.convertFileSrc(track.source.path);
			// convertFileSrc returns the original string unchanged if it cannot convert the scheme.
			// Only use the bridge URL when Capacitor actually transformed it.
			if (bridgeUrl !== track.source.path) {
				tracks = tracks.map((current, currentIndex) =>
					currentIndex === index ? { ...current, url: bridgeUrl } : current
				);
				return bridgeUrl;
			}
		}

		try {
			const file = await materializeStoredFile(track.source, interactiveAuth);
			const url = URL.createObjectURL(file);
			tracks = tracks.map((current, currentIndex) => {
				return currentIndex === index ? { ...current, url, cleanup: undefined } : current;
			});
			return url;
		} catch (error) {
			console.error('Failed to prepare track for playback.', error);
			const msg = error instanceof Error ? error.message : 'Failed to load track.';
			addToast({ message: msg, type: 'error' });
			return null;
		}
	}

	function getNextTrackIndex(currentIndex: number): number | null {
		return getNextTrackIndexPure(currentIndex, {
			trackCount: tracks.length,
			isShuffle: musicSettings.isShuffle,
			isRepeat: musicSettings.isRepeat,
			selectionLoop: mediaEngine.musicSelectionLoopActive,
			preloadedIndex: preloadedTrackIndex,
		});
	}

	async function preloadNextTrack(currentIndex: number) {
		const previousPreloadIndex = preloadedTrackIndex;
		const nextIndex = getNextTrackIndex(currentIndex);
		const requestId = ++preloadRequestId;

		if (previousPreloadIndex !== null && previousPreloadIndex !== currentIndex && previousPreloadIndex !== nextIndex) {
			releaseTrackUrl(previousPreloadIndex);
		}

		if (nextIndex === null || !tracks[nextIndex] || nextIndex === currentIndex) {
			preloadedTrackIndex = null;
			return;
		}

		preloadedTrackIndex = nextIndex;

		if (tracks[nextIndex].url) {
			return;
		}

		const url = await ensureTrackUrl(nextIndex, false);
		if (requestId !== preloadRequestId) {
			if (url && nextIndex !== musicSettings.lastTrackIndex && preloadedTrackIndex !== nextIndex) {
				releaseTrackUrl(nextIndex);
			}
			return;
		}

		if (!url && preloadedTrackIndex === nextIndex) {
			preloadedTrackIndex = null;
		}
	}

	// ─────────────────────────────────────────────────────────────
	// loadTracks — internal, always called with sorted stored entries
	// ─────────────────────────────────────────────────────────────
	function loadTracks(files: StoredAudioFile[], folder: string, options: { selectionLoop?: boolean } = {}) {
		// Clear the audio src before revoking blob URLs to prevent a stale error event
		// from firing advanceTrack while the new track is still loading.
		if (audioEl) { audioEl.pause(); audioEl.src = ''; }
		revokeAll();
		queueSessionId += 1;
		const sorted = sortFiles(files);
		tracks = sorted.map((f, i) => {
			const { title, artist } = parseFilename(f.name);
			return { id: i, title, artist, filename: f.name, url: '', duration: 0, cleanup: undefined, source: f };
		});
		musicSettings.lastFolderName = folder;
		musicSettings.lastTrackIndex = 0;
		musicSettings.lastTrackTimestamp = 0;
		preloadedTrackIndex = null;
		preloadRequestId += 1;
		currentTime = 0; duration = 0; isPlaying = false; isBuffering = false;
		trackListLockedByUser = true;
		mediaEngine.musicSelectionLoopActive = options.selectionLoop ?? false;
	}

	function appendTracksToQueue(files: StoredAudioFile[], folder: string, expectedQueueSessionId: number) {
		if (files.length === 0 || queueSessionId !== expectedQueueSessionId) return;
		const previousTracks = tracks;
		const currentTrack = previousTracks[musicSettings.lastTrackIndex];
		const currentTrackKey = currentTrack ? getTrackKey(currentTrack.source) : '';
		const preloadedTrackKey = preloadedTrackIndex !== null && previousTracks[preloadedTrackIndex]
			? getTrackKey(previousTracks[preloadedTrackIndex].source)
			: '';
		const mergedFiles = mergeStoredFiles(previousTracks.map((track) => track.source), files);
		if (mergedFiles.length === previousTracks.length) return;

		const existingByKey = new Map(previousTracks.map((track) => [getTrackKey(track.source), track]));
		tracks = sortFiles(mergedFiles).map((file, index) => {
			const existing = existingByKey.get(getTrackKey(file));
			const { title, artist } = parseFilename(file.name);
			return {
				id: index,
				title,
				artist,
				filename: file.name,
				url: existing?.url ?? '',
				duration: existing?.duration ?? 0,
				cleanup: existing?.cleanup,
				source: file,
			};
		});
		musicSettings.lastFolderName = folder;

		if (currentTrackKey) {
			const nextIndex = tracks.findIndex((track) => getTrackKey(track.source) === currentTrackKey);
			if (nextIndex >= 0) {
				setCurrentTrack(nextIndex);
			}
		}

		if (preloadedTrackKey) {
			const nextPreloadedIndex = tracks.findIndex((track) => getTrackKey(track.source) === preloadedTrackKey);
			preloadedTrackIndex = nextPreloadedIndex >= 0 ? nextPreloadedIndex : null;
		}
	}

	// ─────────────────────────────────────────────────────────────
	// Folder picker
	// ─────────────────────────────────────────────────────────────
	async function openFolder() {
		if (isNativeApp) {
			const canUseNativePlugin = Capacitor.isPluginAvailable('FilePicker');
			isLoading = true;

			try {
				const { treeUri, folderName } = canUseNativePlugin
					? await pickNativeAudioDirectory()
					: { treeUri: '', folderName: 'Selected Folder' };
				if (!treeUri) {
					if (!canUseNativePlugin) {
						nativeFileInputEl?.click();
						return;
					}

					alert('No MP3 files were found in the selected folder.');
					return;
				}
				rootDirHandle = null;
				nativeTreeUri = treeUri;
				musicSettings.nativeTreeUri = treeUri;
				pendingHandle = null;
				allFiles = [];
				activateDeviceLibrary(folderName);
				browsePath = [];
				browseVersion++;
				showQueue = true;
				const cachedLibrary = await loadDeviceCachedLibrary(treeUri, folderName);
				try {
					await DirectoryReader.rememberTreeUri({ treeUri });
				} catch (error) {
					console.warn('Unable to persist tree URI permission.', error);
				}
				if (cachedLibrary && cachedLibrary.files.length > 0) {
					allFiles = restoreStoredFilesFromCache(cachedLibrary);
					hydrateTracksFromLibrary(allFiles);
					browseVersion++;
				}
			} catch (error) {
				const isCancel = error instanceof Error && /cancel/i.test(error.message);
				if (!isCancel) {
					console.error('Failed to open native folder.', error);
				}
				if (nativeFileInputEl) {
					nativeFileInputEl.click();
					return;
				}
				if (!isCancel) {
					alert('Unable to open a folder on this device. Please try again.');
				}
			} finally {
				isLoading = false;
			}
			return;
		}

		if ('showDirectoryPicker' in window) {
			try {
				const dirHandle = await (window as unknown as {
					showDirectoryPicker(o: object): Promise<FileSystemDirectoryHandle>;
				}).showDirectoryPicker({ mode: 'read' });
				rootDirHandle = dirHandle;
				musicSettings.nativeTreeUri = '';
				pendingHandle = null;
				allFiles = [];
				activateDeviceLibrary(dirHandle.name);
				browsePath = [];
				browseVersion++;  // triggers browse entry reload
				showQueue = true;
				void saveHandleToIDB(dirHandle);
				const cachedLibrary = await loadDeviceCachedLibrary(null, dirHandle.name);
				if (cachedLibrary && cachedLibrary.files.length > 0) {
					allFiles = restoreStoredFilesFromCache(cachedLibrary);
					hydrateTracksFromLibrary(allFiles);
					browseVersion++;
				}
			} catch { /* user cancelled */ }
		} else {
			folderInputEl?.click();
		}
	}

	function handleFolderInput(e: Event) {
		const input = e.target as HTMLInputElement;
		const files = Array.from(input.files ?? []).filter(f => f.name.toLowerCase().endsWith('.mp3'));
		if (files.length === 0) { alert('No MP3 files found in selected folder.'); return; }
		rootDirHandle = null;
		nativeTreeUri = null;
		musicSettings.nativeTreeUri = '';
		libraryScanPromise = null;
		allFiles = files.map((file) => createStoredAudioFile(file));
		activateDeviceLibrary(files[0].webkitRelativePath?.split('/')[0] ?? 'Selected Files');
		browsePath = [];
		browseVersion++;  // triggers browse entry reload
		showQueue = true;
		hydrateTracksFromLibrary(allFiles);
		void saveCachedLibrary(musicSettings.lastFolderName || 'Selected Files', allFiles);
		input.value = '';
	}

	function handleNativeFileInput(e: Event) {
		const input = e.target as HTMLInputElement;
		const files = Array.from(input.files ?? []).filter((file) => {
			return file.name.toLowerCase().endsWith('.mp3') || file.type.startsWith('audio/');
		});

		if (files.length === 0) {
			alert('No MP3 files were selected.');
			input.value = '';
			return;
		}

		rootDirHandle = null;
		nativeTreeUri = null;
		musicSettings.nativeTreeUri = '';
		pendingHandle = null;
		libraryScanPromise = null;
		allFiles = files.map((file) => createStoredAudioFile(file));
		activateDeviceLibrary('Selected Files');
		browsePath = [];
		browseVersion++;
		showQueue = true;
		hydrateTracksFromLibrary(allFiles, true);
		void saveCachedLibrary('Selected Files', allFiles);
		input.value = '';
	}

	// ─────────────────────────────────────────────────────────────
	// Reconnect a pending handle (needs user gesture for permission)
	// ─────────────────────────────────────────────────────────────
	async function reconnectFolder() {
		if (!pendingHandle) return;
		try {
			const perm = await (pendingHandle as unknown as { requestPermission(o: object): Promise<string> })
				.requestPermission({ mode: 'read' });
			if (perm === 'granted') {
				rootDirHandle = pendingHandle;
				nativeTreeUri = null;
				musicSettings.nativeTreeUri = '';
				pendingHandle = null;
				allFiles = [];
				activateDeviceLibrary(rootDirHandle.name);
				browseVersion++;
				showQueue = true;
				void saveHandleToIDB(rootDirHandle);
				const cachedLibrary = await loadDeviceCachedLibrary(null, rootDirHandle.name);
				if (cachedLibrary && cachedLibrary.files.length > 0) {
					allFiles = restoreStoredFilesFromCache(cachedLibrary);
					hydrateTracksFromLibrary(allFiles);
					browseVersion++;
				}
			}
		} catch { /* user denied */ }
	}

	// ─────────────────────────────────────────────────────────────
	// Browse interactions
	// ─────────────────────────────────────────────────────────────

	// ── Shared audio start sequence — used by all user-initiated play functions ──
	async function startAudioAt(index: number, options: { suppressAlert?: boolean } = {}): Promise<boolean> {
		if (!audioEl || !tracks[index]) return false;
		const url = await ensureTrackUrl(index, true);
		if (!url) {
			if (!options.suppressAlert) {
				alert('Unable to load this track.');
			}
			return false;
		}
		// Do NOT call audioEl.load() — calling load() then play() immediately causes an AbortError
		// ("play() request was interrupted by a new load request") in Chromium/Android WebView.
		// Setting src and calling play() directly is sufficient; the browser loads internally.
		audioEl.src = url;
		syncTrackToMediaEngine(index);
		void preloadNextTrack(index);
		claimAudio(deck === 'A' ? 'musicA' : 'musicB');
		initAudioContext();
		isBuffering = true;
		safePlay(() => { isBuffering = false; isPlaying = false; });
		return true;
	}

	async function startFirstPlayableTrack(startIndex = 0): Promise<boolean> {
		for (let index = startIndex; index < tracks.length; index += 1) {
			setCurrentTrack(index);
			currentTime = 0;
			duration = 0;
			if (await startAudioAt(index, { suppressAlert: true })) {
				return true;
			}
		}
		return false;
	}

	async function playNativeFolderFromScan(path: string[], folderLabel: string): Promise<boolean> {
		if (!nativeTreeUri) return false;

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
			path,
			FOLDER_PLAY_SCAN_BATCH_SIZE,
			{ initialBatchSize: FOLDER_PLAY_INITIAL_BATCH_SIZE },
			async (mappedBatch, state) => {
			const mergedFiles = mergeStoredFiles(collectedFiles, mappedBatch);
			if (mergedFiles.length === collectedFiles.length) return;
			collectedFiles.splice(0, collectedFiles.length, ...mergedFiles);

			if (!playbackStarted) {
				if (collectedFiles.length < FOLDER_PLAY_PRIME_COUNT && !state.done) return;
				loadTracks(collectedFiles, folderLabel);
				activePlaybackQueueSessionId = queueSessionId;
				queuedFileCount = collectedFiles.length;
				playbackStarted = await startFirstPlayableTrack();
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
				loadTracks(collectedFiles, folderLabel);
				activePlaybackQueueSessionId = queueSessionId;
				queuedFileCount = collectedFiles.length;
				playbackStarted = await startFirstPlayableTrack();
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
				await saveCachedLibrary(folderLabel, collectedFiles, getDeviceLibraryCacheKey({ treeUri: nativeTreeUri, folderName: folderLabel }));
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
			loadTracks(files, browsePath.length > 0 ? browsePath[browsePath.length - 1] : musicSettings.lastFolderName, { selectionLoop });
			const sorted = sortFiles(files);
			const entryKey = getStoredFileKey(entry.file);
			const idx = sorted.findIndex((file) => getStoredFileKey(file) === entryKey);
			setCurrentTrack(Math.max(0, idx));
			currentTime = 0; duration = 0;
			await startAudioAt(musicSettings.lastTrackIndex);
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
			loadTracks(files, label, { selectionLoop });
			if (!(await startFirstPlayableTrack())) {
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
			const indexedFiles = collectStoredFilesFromSnapshot(allFiles, path);
			if (indexedFiles.length > 0) {
				loadTracks(indexedFiles, folderLabel);
				if (!(await startFirstPlayableTrack())) {
					alert('No playable audio files were found in this folder.');
				}
				return;
			}

			if (nativeTreeUri) {
				if (!(await playNativeFolderFromScan(path, folderLabel))) {
					alert('No audio files found in this folder.');
				}
				return;
			}

			const files = await collectAllFromPath(path);
			if (files.length === 0) { alert('No audio files found in this folder.'); return; }
			loadTracks(files, folderLabel);
			if (!(await startFirstPlayableTrack())) {
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

	function navigateInto(name: string) {
		showFavoriteTracks = false;
		browsePath = [...browsePath, name];
	}
	function navigateToParentFolderFromSwipe() {
		if (browsePath.length === 0) return;
		showFavoriteTracks = false;
		browsePath = browsePath.slice(0, -1);
	}
	function navigateUp() {
		if (showFavoriteTracks) {
			showFavoriteTracks = false;
			return;
		}
		if (browsePath.length > 0) {
			browsePath = browsePath.slice(0, -1);
		}
	}

	// ─────────────────────────────────────────────────────────────
	// Playback controls
	// ─────────────────────────────────────────────────────────────
	async function togglePlay() {
		if (isPlaying) { audioEl.pause(); }
		else void resumePlayback();
	}

	function pausePlayback() {
		if (!audioEl || !currentTrack || !isPlaying) return;
		void triggerPlaybackHaptic(false);
		audioEl.pause();
	}

	async function resumePlayback() {
		if (!audioEl || isPlaying) return;

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
		claimAudio(deck === 'A' ? 'musicA' : 'musicB');
		if (!audioEl.src || audioEl.src === window.location.href) {
			const url = await ensureTrackUrl(musicSettings.lastTrackIndex, true);
			if (!url) {
				alert('Unable to load this track.');
				return;
			}
			audioEl.src = url;
			syncTrackToMediaEngine(musicSettings.lastTrackIndex);
		}
		void preloadNextTrack(musicSettings.lastTrackIndex);
		safePlay();
	}

	async function selectTrack(index: number) {
		if (isChangingTrack) return;
		isChangingTrack = true;
		const oldIndex = musicSettings.lastTrackIndex;
		try {
			setCurrentTrack(index);
			musicSettings.lastTrackTimestamp = 0;
			currentTime = 0; duration = 0;
			await startAudioAt(index);
			// Release old URL only after new src is loaded to avoid streaming error
			if (oldIndex !== index) releaseTrackUrl(oldIndex);
		} finally {
			isChangingTrack = false;
		}
	}

	// ── Rebuild tracks from current selection when loop is active.
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

		// Preserve the currently-playing track's index across the rebuild
		const currentTrackKey =
			tracks[musicSettings.lastTrackIndex]
				? getStoredFileKey(tracks[musicSettings.lastTrackIndex].source)
				: null;
		const sorted = sortFiles(selectedFiles);
		tracks = sorted.map((f, i) => ({
			id: i,
			...parseFilename(f.name),
			filename: f.name,
			url: '',
			duration: 0,
			cleanup: undefined,
			source: f,
		}));
		if (currentTrackKey) {
			const newIdx = tracks.findIndex((t) => getStoredFileKey(t.source) === currentTrackKey);
			if (newIdx >= 0) {
				musicSettings.lastTrackIndex = newIdx;
			} else {
				// Currently playing track was removed — reset to first
				musicSettings.lastTrackIndex = 0;
			}
		}
		queueSessionId += 1;
	}

	async function advanceTrack(wasPlaying: boolean, interactiveAuth = false) {
		if (isChangingTrack || tracks.length === 0) return;
		isChangingTrack = true;
		try {
			// Sync selection so newly added/removed loop tracks take effect
			syncLoopTracksToSelection();

			const idx = musicSettings.lastTrackIndex;
			const nextIndex = getNextTrackIndex(idx);
			if (nextIndex === null) {
				isPlaying = false; currentTime = 0;
				if (audioEl) { audioEl.pause(); audioEl.currentTime = 0; }
				return;
			}

			// Same-track loop (single selected track, or repeat): just seek to
			// start and play. Avoids the ensureTrackUrl → set src dance which is
			// a no-op on Android native (Capacitor.convertFileSrc returns the same
			// bridge URL every time, so audioEl.src = sameUrl doesn't reload).
			if (nextIndex === idx) {
				setCurrentTrack(nextIndex);
				currentTime = 0;
				musicSettings.lastTrackTimestamp = 0;
				if (audioEl) {
					audioEl.currentTime = 0;
					if (wasPlaying) {
						isBuffering = false;
						safePlay(() => { isPlaying = false; });
					}
				}
				isChangingTrack = false;
				return;
			}

			setCurrentTrack(nextIndex);
			musicSettings.lastTrackTimestamp = 0;
			currentTime = 0; duration = 0;
			if (audioEl && tracks[nextIndex]) {
				const url = await ensureTrackUrl(nextIndex, interactiveAuth);
				if (!url) {
					isPlaying = false; isBuffering = false;
					return;
				}
				// Release old URL only after new URL is ready so streaming doesn't error
				releaseTrackUrl(idx);
				audioEl.src = url;
				syncTrackToMediaEngine(nextIndex);
				void preloadNextTrack(nextIndex);
				claimAudio(deck === 'A' ? 'musicA' : 'musicB');
				initAudioContext();
				if (wasPlaying) {
					isBuffering = true;
					safePlay(() => { isPlaying = false; isBuffering = false; });
				}
			}
		} finally {
			isChangingTrack = false;
		}
	}

	async function prevTrack() {
		if (isChangingTrack || tracks.length === 0) return;
		isChangingTrack = true;
		try {
			const wasPlaying = isPlaying || isBuffering;
			if (musicSettings.rewindOnPrev && currentTime > 3 && audioEl) { audioEl.currentTime = 0; return; }
			const oldIndex = musicSettings.lastTrackIndex;
			const prevIndex = (oldIndex - 1 + tracks.length) % tracks.length;
			setCurrentTrack(prevIndex);
			musicSettings.lastTrackTimestamp = 0;
			currentTime = 0; duration = 0;
			if (audioEl && tracks[prevIndex]) {
				const url = await ensureTrackUrl(prevIndex, true);
				if (!url) {
					return;
				}
				// Release old URL only after new URL is ready
				releaseTrackUrl(oldIndex);
				audioEl.src = url;
				syncTrackToMediaEngine(prevIndex);
				void preloadNextTrack(prevIndex);
				claimAudio(deck === 'A' ? 'musicA' : 'musicB');
				initAudioContext();
				if (wasPlaying) {
					isBuffering = true;
					safePlay(() => { isPlaying = false; isBuffering = false; });
				}
			}
		} finally {
			isChangingTrack = false;
		}
	}

	function handleSeekInput(e: Event) {
		// Track drag position visually without touching audio (prevents timeupdate reset)
		seekingValue = parseFloat((e.target as HTMLInputElement).value);
	}
	function handleSeekCommit(e: Event) {
		// User released – now actually seek the audio
		const pct = parseFloat((e.target as HTMLInputElement).value);
		const newTime = (pct / 100) * duration;
		seekingValue = null;
		currentTime = newTime;
		if (audioEl) audioEl.currentTime = newTime;
	}
	function handleSeekSeconds(seconds: number) {
		seekingValue = null;
		currentTime = seconds;
		if (audioEl) audioEl.currentTime = seconds;
	}
	function handleVolume(e: Event) {
		const input = e.target as HTMLInputElement;
		musicSettings[deckVolKey] = parseFloat(input.value);
		musicSettings.isMuted = musicSettings[deckVolKey] === 0;
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
			const restored = await restorePendingDriveFolderPickerIfNeeded();
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

			void restorePendingDriveFolderPickerIfNeeded();
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
			clearPendingDriveFolderPickerRestoreTimers();
		};
	});

	// ── Restore last folder handle from IndexedDB on mount ───────
	// untrack() prevents any reactive reads in the sync preamble (e.g. driveAccessToken reads
	// inside ensureDriveAccessToken) from becoming effect dependencies, which would otherwise
	// cause this effect to re-run when those signals are written during hydration — leading to
	// multiple concurrent finishDriveLoad calls and a spinner that never resolves.
	$effect(() => {
		untrack(() => {
		if (musicSettings.librarySource === 'drive') {
			// Skip if a Drive load is already running (e.g. triggered by folder picker confirmation)
			if (isDriveLoading) return;
			// Silently restore Drive library using the persisted session token (survives refresh)
			void (async () => {
				try {
					const token = await ensureDriveAccessToken(false);
					if (token) {
						await finishDriveLoad(token, musicSettings.driveFolderId || undefined);
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
					activateDeviceLibrary(cachedLibrary.folderName);
					hydrateTracksFromLibrary(allFiles);
					showQueue = true;
					browseVersion++;
				}
				if (isNativeApp && musicSettings.nativeTreeUri) {
					nativeTreeUri = musicSettings.nativeTreeUri;
					rootDirHandle = null;
					pendingHandle = null;
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
					rootDirHandle = handle;
					nativeTreeUri = null;
					allFiles = cachedLibrary?.files.length ? allFiles : [];
					browseVersion++;
					showQueue = true;
				} else {
					// 'prompt' or 'denied' — need user gesture to re-request
					pendingHandle = handle;
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
		const onRescan = () => { void rescanCurrentLibraryIndex(); };
		window.addEventListener('music-library:rescan', onRescan);
		return () => window.removeEventListener('music-library:rescan', onRescan);
	});

	$effect(() => { return () => { revokeAll(); audioCtx?.close(); }; });
</script>

<!-- Hidden audio element -->
<audio bind:this={audioEl} preload="none"></audio>

<!-- Hidden folder input fallback -->
<input
	bind:this={folderInputEl}
	type="file"
	accept=".mp3,audio/mpeg"
	multiple
	webkitdirectory
	class="hidden"
	onchange={handleFolderInput}
/>

<input
	bind:this={nativeFileInputEl}
	type="file"
	accept=".mp3,audio/*"
	multiple
	class="hidden"
	onchange={handleNativeFileInput}
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
			{#if pendingHandle}
				<Button onclick={reconnectFolder} class="gap-2 px-6 h-12 text-base w-full">
					<FolderOpen class="w-5 h-5" /> Reconnect "{musicSettings.lastFolderName}"
				</Button>
				<Button variant="outline" onclick={openFolder} class="gap-2 h-10 text-sm w-full" disabled={isLoading}>
					<FolderOpen class="w-4 h-4" /> Choose a different folder
				</Button>
			{:else}
				<Button onclick={openFolder} class="gap-2 px-6 h-12 text-base w-full" disabled={isLoading}>
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
				onclick={connectGoogleDrive}
				class="gap-2 px-6 h-12 text-base w-full"
				disabled={!googleDriveConfigured || isDriveLoading || isDriveAuthenticating}
			>
				{#if isDriveLoading || isDriveAuthenticating}
					<div class="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin"></div>
					Connecting…
				{:else}
					<Cloud class="w-5 h-5" /> Connect Google Drive
				{/if}
			</Button>
		</div>
		{#if !googleDriveConfigured}
			<p class="text-xs text-muted-foreground max-w-xs">
				Google Drive sign-in is disabled until PUBLIC_GOOGLE_CLIENT_ID is configured.
			</p>
		{/if}
		{#if driveError}
			<p class="text-xs text-destructive max-w-xs">{driveError}</p>
		{/if}
	</div>

	<!-- ════════════════════════════════ BROWSE VIEW ════════════════════════════════ -->
	{:else if showQueue}
	<div class="flex flex-col h-full"
		use:swipeBack={{
			onBack: () => {
				if (browsePath.length === 0) return;
				void triggerSwipeBackHaptic();
				navigateToParentFolderFromSwipe();
			},
		}}
	>

		<!-- Header -->
		<div class="flex items-center gap-2 px-3 py-3 border-b shrink-0">
			{#if browsePath.length > 0 || showFavoriteTracks}
			<Button
				variant="ghost"
				size="icon"
				class="w-11 h-11 shrink-0"
				onclick={navigateUp}
				aria-label={showFavoriteTracks
					? 'Back from favorite tracks'
					: 'Back to parent folder'}
			>
				<ChevronLeft class="w-6 h-6" />
			</Button>
			{/if}

			<!-- Breadcrumb -->
			<div class="flex items-center gap-1 flex-1 min-w-0 overflow-hidden">
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
			</div>

			<!-- Favorites toggle + Change folder -->
			<div class="flex items-center gap-1 shrink-0">
				<Button
					variant="ghost"
					size="icon"
					class={`h-10 w-10 ${showFavoriteTracks ? 'text-yellow-400' : 'text-muted-foreground'}`}
					onclick={() => {
						showFavoriteTracks = !showFavoriteTracks;
						clearBrowseSelection();
					}}
					aria-label={showFavoriteTracks ? 'Hide favorite tracks' : 'Show favorite tracks'}
					title={showFavoriteTracks ? 'Hide favorite tracks' : 'Show favorite tracks'}
				>
					<Star class="w-5 h-5" fill={showFavoriteTracks ? 'currentColor' : 'none'} />
				</Button>
				<Button variant="ghost" size="icon" class="h-10 w-10" onclick={openFolder} aria-label="Open local folder" title="Open local folder">
					<FolderOpen class="w-5 h-5" />
				</Button>
				<Button variant="ghost" size="icon" class="h-10 w-10" onclick={driveUser ? changeDriveFolder : connectGoogleDrive} disabled={isDriveAuthenticating} aria-label={driveUser ? 'Change Drive folder' : 'Connect Google Drive'} title={driveUser ? 'Change Google Drive folder' : 'Connect Google Drive'}>
					{#if isDriveAuthenticating}
						<div class="w-5 h-5 border-2 border-current border-t-transparent rounded-full animate-spin"></div>
					{:else}
						<Cloud class="w-5 h-5" />
					{/if}
				</Button>
			</div>
		</div>

		<!-- Index scan progress bar (shown while building the in-memory folder index) -->
		{#if scanProgress !== null && musicSettings.librarySource !== 'drive'}
		<div class="px-4 py-2 border-b shrink-0 bg-muted/20">
			<div class="flex items-center gap-2 text-xs text-muted-foreground mb-1.5">
				<div class="w-3 h-3 border border-primary border-t-transparent rounded-full animate-spin shrink-0"></div>
				<span class="flex-1 truncate">Indexing library… {scanProgress.pct}% · {scanProgress.filesFound} file{scanProgress.filesFound === 1 ? '' : 's'} found</span>
			</div>
			<div class="h-1 rounded-full bg-muted overflow-hidden">
				<div class="h-full bg-primary rounded-full transition-[width] duration-300" style="width: {scanProgress.pct}%"></div>
			</div>
		</div>
		{/if}

		<!-- Favorites strip -->
		{#if musicSettings.favoriteFolders.length > 0}
		<div class="px-4 py-2 border-b shrink-0">
				<div class="flex items-center gap-2 overflow-x-auto" style="scrollbar-width:none">
				{#each musicSettings.favoriteFolders as fav}
					{@const isActive = fav.source === 'drive'
						? (musicSettings.librarySource === 'drive' && (fav.id === '_all' ? !musicSettings.driveFolderId : musicSettings.driveFolderId === fav.id))
						: (musicSettings.librarySource === 'device' && nativeTreeUri === fav.treeUri)}
					<div class="mini-player-control-surface flex items-center gap-0.5 shrink-0 rounded-full pl-2.5 pr-1 py-1 text-xs {isActive ? 'bg-primary text-primary-foreground border-primary' : 'text-foreground'}">
						<button class="flex items-center gap-1.5 min-w-0" onclick={() => switchToFavorite(fav)} title="Switch to {fav.name}" disabled={switchingToFavId !== null}>
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
							onclick={() => removeFavoriteFolder(fav.id, fav.source)}
							aria-label="Remove {fav.name} from favorites"
						>×</button>
					</div>
				{/each}
			</div>
		</div>
		{/if}

		<!-- Entry list -->
		<div class="flex-1 overflow-y-auto min-h-0">

			{#if showFavoriteTracks}
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
						{@const isCurrentTrack = mediaEngine.source === 'music' && currentMusicTrackKey === entry.favorite.key}
						<div class="list-row-surface flex items-center gap-2 px-4 py-2 border-b transition-colors {isCurrentTrack ? 'bg-primary/10 ring-1 ring-inset ring-primary/25' : listTileToneClasses.usesTint ? listTileToneClasses.rowClass : 'hover:bg-accent'}">
							<button
								class="tap-feedback flex-1 min-w-0 flex items-center gap-2 rounded-xl px-2 py-2 transition-colors text-left {entry.file ? (isCurrentTrack ? 'bg-primary/10 ring-1 ring-inset ring-primary/30 active:bg-primary/15' : listTileToneClasses.usesTint ? listTileToneClasses.actionClass : 'active:bg-accent/80') : 'opacity-60'}"
								onclick={() => playFavoriteTrack(entry.favorite)}
								disabled={!entry.file}
								aria-label={entry.file ? `Play ${entry.favorite.title}` : `${entry.favorite.title} is unavailable`}
								aria-current={isCurrentTrack ? 'true' : undefined}
							>
								<div class="flex-1 min-w-0">
									<p class="font-semibold text-[0.95rem] leading-tight title-marquee"><span class="title-marquee-inner" data-text={entry.favorite.title}>{entry.favorite.title}</span></p>
									<p class="text-xs text-muted-foreground truncate">
										{entry.favorite.artist}
										{#if !entry.file}
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
			{:else if browseLoading}
				<div class="flex items-center justify-center h-32">
					<div class="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin"></div>
				</div>
			{:else if filteredEntries.length === 0}
				<p class="text-center text-muted-foreground text-sm py-12">
					{#if fileSearchQuery.trim()}
						No files match “{fileSearchQuery}”
					{:else if musicSettings.librarySource === 'drive'}
						{driveSearch ? 'No Google Drive MP3s match your search' : 'No MP3 files were found in Google Drive'}
					{:else}
						No MP3 files or folders here
					{/if}
				</p>
			{:else}
				{#each filteredEntries as entry}
					{#if entry.kind === 'folder'}
					{@const folderKey = [...browsePath, entry.name].join('/')}
					<!-- Folder row -->
					<div class="list-row-surface flex items-center gap-3 px-4 py-3 border-b transition-colors {listTileToneClasses.usesTint ? listTileToneClasses.rowClass : 'hover:bg-accent'}">
						<div class="w-9 h-9 rounded-lg bg-primary/15 flex items-center justify-center shrink-0">
							<Folder class="w-4.5 h-4.5 text-primary" />
						</div>
						<button class="tap-feedback flex-1 min-w-0 -my-2 -ml-2 rounded-xl px-2 py-2 text-left {listTileToneClasses.usesTint ? listTileToneClasses.actionClass : 'active:bg-accent/80'}" onclick={() => navigateInto(entry.name)}>
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
						<button class="text-muted-foreground shrink-0" onclick={() => navigateInto(entry.name)} aria-label="Browse {entry.name}">
							<ChevronRight class="w-5 h-5" />
						</button>
					</div>
					{:else}
					<!-- File row — click anywhere to play -->
					{@const isSelected = isBrowseFileSelected(entry.file)}
					{@const isCurrentTrack = mediaEngine.source === 'music' && currentMusicTrackKey === getStoredFileKey(entry.file)}
					<div class="list-row-surface flex items-center gap-2 px-4 py-2 border-b transition-colors {isSelected ? 'bg-primary/12 ring-1 ring-inset ring-primary/35' : isCurrentTrack ? 'bg-primary/10 ring-1 ring-inset ring-primary/25' : listTileToneClasses.usesTint ? listTileToneClasses.rowClass : 'hover:bg-accent'}">
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
					{/if}
				{/each}
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
				<Button variant="ghost" size="icon" onclick={openFolder} title="Open local folder" class="h-10 w-10">
					<FolderOpen class="w-5 h-5" />
				</Button>
				<Button variant="ghost" size="icon" onclick={driveUser ? changeDriveFolder : connectGoogleDrive} title={driveUser ? 'Change Google Drive folder' : 'Connect Google Drive'} class="h-10 w-10">
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

		<!-- Volume -->
		<div class="flex items-center gap-3 w-full">
			<Button variant="ghost" size="icon" onclick={toggleMute} class="text-muted-foreground shrink-0">
				{#if musicSettings.isMuted || musicSettings[deckVolKey] === 0}
					<VolumeX class="w-5 h-5" />
				{:else}
					<Volume2 class="w-5 h-5" />
				{/if}
			</Button>
			<input type="range" min="0" max="100"
				value={musicSettings.isMuted ? 0 : musicSettings[deckVolKey]}
				oninput={handleVolume}
				class="w-full h-1.5 rounded-full appearance-none cursor-pointer bg-secondary accent-primary" />
		</div>
	</div>

	<!-- Speed panel -->
	{#if showPanel === 'speed'}
	<div class="border-t bg-card/95 px-4 pt-3 pb-3 shrink-0">
		<p class="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">Playback Speed</p>
		<div class="flex flex-wrap gap-2">
			{#each [0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0] as speed}
				<button
					class="px-3 py-1.5 rounded-full text-sm font-medium border transition-colors {musicSettings.playbackSpeed === speed ? 'bg-primary text-primary-foreground border-primary' : 'border-border hover:bg-accent'}"
					onclick={() => (musicSettings.playbackSpeed = speed)}
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
			<span class="text-[11px] font-semibold tracking-wide">{musicSettings.playbackSpeed}×</span>
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
	</div>

	{/if}
</div>

<!-- ═══════════════════ DRIVE FOLDER PICKER DIALOG ═══════════════════ -->
{#if showFolderPicker}
<div
	class="fixed inset-0 z-50 flex items-end sm:items-center justify-center"
	role="dialog"
	aria-modal="true"
	aria-label="Choose Google Drive folder"
>
	<!-- Backdrop -->
	<button
		class="absolute inset-0 bg-black/60 backdrop-blur-sm"
		onclick={cancelFolderPicker}
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
				{#if folderPickerStack.length > 0}
					<button
						class="w-8 h-8 flex items-center justify-center rounded-full hover:bg-accent transition-colors text-muted-foreground"
						onclick={navigateFolderPickerBack}
						aria-label="Back"
					>
						<ChevronLeft class="w-4 h-4" />
					</button>
				{/if}
				<div class="flex-1 min-w-0">
					<h2 class="text-base font-semibold leading-tight">Choose a folder</h2>
					{#if folderPickerStack.length > 0}
						<p class="text-xs text-muted-foreground truncate">
							{folderPickerStack.map(f => f.name).join(' › ')}
						</p>
					{:else}
						<p class="text-xs text-muted-foreground">Select which folder to load MP3s from</p>
					{/if}
				</div>
				<button
					class="w-8 h-8 flex items-center justify-center rounded-full hover:bg-accent transition-colors text-muted-foreground"
					onclick={cancelFolderPicker}
					aria-label="Cancel"
				>
					<ChevronLeft class="w-4 h-4 rotate-180" />
				</button>
			</div>
		</div>

		<!-- Folder list -->
		<div class="flex-1 overflow-y-auto min-h-0">
			{#if folderPickerLoading}
				<div class="flex items-center justify-center py-12">
					<div class="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin"></div>
				</div>
			{:else if folderPickerError}
				<div class="px-4 py-8 text-center space-y-3">
					<p class="text-sm text-destructive">{folderPickerError}</p>
					<Button variant="outline" size="sm" onclick={loadFolderPickerLevel}>Retry</Button>
				</div>
			{:else}
				<!-- "All files" option (only at root level) -->
				{#if folderPickerStack.length === 0}
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

				{#if folderPickerFolders.length === 0}
					<p class="text-center text-muted-foreground text-sm py-8 px-4">No sub-folders found here</p>
				{:else}
					{#each folderPickerFolders as folder}
						{@const isSelected = musicSettings.driveFolderId === folder.id}
						{@const isFaved = isDriveFolderPickerFavorited(folder.id)}
						<div class="w-full flex items-center gap-3 px-4 py-3 border-b hover:bg-accent transition-colors">
							<button class="flex items-center gap-3 flex-1 min-w-0 text-left" onclick={() => navigateFolderPickerInto(folder)}>
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
								onclick={(e) => toggleDriveFolderPickerFavorite(folder, e)}
								aria-label="{isFaved ? 'Remove from' : 'Add to'} favorites"
							>
								<Star class="w-4 h-4" fill={isFaved ? 'currentColor' : 'none'} />
							</button>
							<button class="shrink-0 text-muted-foreground" onclick={() => navigateFolderPickerInto(folder)} aria-label="Browse {folder.name}">
								<ChevronRight class="w-4 h-4" />
							</button>
						</div>
					{/each}
				{/if}
			{/if}
		</div>

		<!-- Footer -->
		<div class="px-4 py-3 border-t shrink-0 flex gap-2">
			<Button variant="outline" class="flex-1" onclick={cancelFolderPicker}>Cancel</Button>
			<Button class="flex-1" onclick={confirmCurrentFolder}>
				Select{folderPickerStack.length > 0 ? ` "${folderPickerStack.at(-1)!.name}"` : ' all'}
			</Button>
		</div>
	</div>
</div>
{/if}

<style>
	@keyframes bar1 { 0%, 100% { height: 30%; } 50% { height: 90%; } }
	@keyframes bar2 { 0%, 100% { height: 90%; } 50% { height: 30%; } }
</style>
