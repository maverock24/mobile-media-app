<script lang="ts">
	import { untrack } from 'svelte';
	import { Capacitor } from '@capacitor/core';
	import { Filesystem } from '@capacitor/filesystem';
	import { FilePicker } from '@capawesome/capacitor-file-picker';
	import Input from '$lib/components/ui/Input.svelte';
	import { DirectoryReader, type NativeDirectoryFile, type NativeDirectoryFolder } from '$lib/native/directory-reader';
	import Button from '$lib/components/ui/Button.svelte';
	import {
		checkFolderHasSubfolders,
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
	import { musicSettings } from '$lib/stores/settings.svelte';
	import { mp3TrackPositions } from '$lib/stores/settings.svelte';
	import { googleDriveSession } from '$lib/stores/googleDriveSession.svelte';
	import { driveConfigSync } from '$lib/stores/driveConfigSync.svelte';
	import { claimAudio, registerAudioSource } from '$lib/stores/activeAudio.svelte';
	import { mediaEngine } from '$lib/stores/mediaEngine.svelte';
	import {
		Play, Pause, SkipBack, SkipForward, Shuffle, Repeat,
		Volume2, VolumeX, Heart, FolderOpen, Music2,
		ChevronLeft, ChevronRight, Folder, Gauge, SlidersHorizontal,
		Cloud, RefreshCw, LogOut, Search, Star
	} from 'lucide-svelte';

	interface Track {
		id: number; title: string; artist: string;
		filename: string; url: string; duration: number;
		cleanup?: () => void;
		source: StoredAudioFile;
	}

	type StoredAudioFile =
		| { source: 'web'; name: string; relativePath: string; file: File }
		| { source: 'native'; name: string; relativePath: string; path: string; mimeType?: string; modifiedAt?: number }
		| {
			source: 'drive';
			name: string;
			relativePath: string;
			fileId: string;
			mimeType?: string;
			modifiedAt?: number;
			sizeBytes?: number;
			webViewLink?: string;
		};

	type BrowseEntry =
		| { kind: 'folder'; name: string; count: number }
		| { kind: 'file'; name: string; file: StoredAudioFile };

	const isNativeApp = typeof window !== 'undefined' && Capacitor.isNativePlatform();
	const googleDriveConfigured = isGoogleDriveConfigured();
	const googleDriveClientId = getGoogleDriveClientId();
	type CachedWebLibraryFile = { source: 'web'; name: string; relativePath: string; file: File };
	type CachedNativeLibraryFile = {
		source: 'native';
		name: string;
		relativePath: string;
		path: string;
		mimeType?: string;
		modifiedAt?: number;
	};
	type CachedLibraryFile = CachedWebLibraryFile | CachedNativeLibraryFile;
	type CachedLibrary = { folderName: string; files: CachedLibraryFile[]; savedAt: number };

	// ── IndexedDB persistence for FileSystemDirectoryHandle ──────
	function openIDB(): Promise<IDBDatabase> {
		return new Promise((res, rej) => {
			const req = indexedDB.open('music-app', 2);
			req.onupgradeneeded = () => {
				const db = req.result;
				if (!db.objectStoreNames.contains('handles')) db.createObjectStore('handles');
				if (!db.objectStoreNames.contains('libraries')) db.createObjectStore('libraries');
			};
			req.onsuccess = () => res(req.result);
			req.onerror  = () => rej(req.error);
			// Reject instead of hanging when another connection blocks the version change.
			req.onblocked = () => rej(new Error('IDB open blocked'));
		});
	}
	// ── IDB helpers — eliminate repeated Promise wrapping ──────────────────────
	function idbGet<T>(db: IDBDatabase, store: string, key: string): Promise<T | null> {
		return new Promise((res, rej) => {
			const req = db.transaction(store).objectStore(store).get(key);
			req.onsuccess = () => res((req.result ?? null) as T | null);
			req.onerror = () => rej(req.error);
		});
	}
	function idbPut(db: IDBDatabase, store: string, value: unknown, key: string): Promise<void> {
		return new Promise((res, rej) => {
			const tx = db.transaction(store, 'readwrite');
			tx.objectStore(store).put(value, key);
			tx.oncomplete = () => res();
			tx.onerror = () => rej(tx.error);
		});
	}
	function idbDelete(db: IDBDatabase, store: string, key: string): Promise<void> {
		return new Promise((res, rej) => {
			const tx = db.transaction(store, 'readwrite');
			tx.objectStore(store).delete(key);
			tx.oncomplete = () => res();
			tx.onerror = () => rej(tx.error);
		});
	}

	async function saveHandleToIDB(handle: FileSystemDirectoryHandle) {
		try { const db = await openIDB(); await idbPut(db, 'handles', handle, 'last-dir'); db.close(); }
		catch { /* storage unavailable */ }
	}
	async function loadHandleFromIDB(): Promise<FileSystemDirectoryHandle | null> {
		try { const db = await openIDB(); const h = await idbGet<FileSystemDirectoryHandle>(db, 'handles', 'last-dir'); db.close(); return h; }
		catch { return null; }
	}
	async function saveCachedLibrary(folderName: string, files: StoredAudioFile[]) {
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
		try { const db = await openIDB(); await idbPut(db, 'libraries', { folderName, files: cachedFiles, savedAt: Date.now() } satisfies CachedLibrary, 'last-library'); db.close(); }
		catch { /* ignore cache write failures */ }
	}
	async function loadCachedLibrary(): Promise<CachedLibrary | null> {
		try { const db = await openIDB(); const r = await idbGet<CachedLibrary>(db, 'libraries', 'last-library'); db.close(); return r; }
		catch { return null; }
	}

	// ── Separate IDB for Google Drive file list cache (avoids version conflicts with music-app) ─
	const DRIVE_CACHE_TTL = 60 * 60 * 1000;
	function openDriveCacheIDB(): Promise<IDBDatabase> {
		return new Promise((res, rej) => {
			const req = indexedDB.open('music-app-drive-cache', 1);
			req.onupgradeneeded = () => {
				const db = req.result;
				if (!db.objectStoreNames.contains('drive-files')) db.createObjectStore('drive-files');
			};
			req.onsuccess = () => res(req.result);
			req.onerror  = () => rej(req.error);
		});
	}
	async function saveDriveCache(cacheKey: string, files: GoogleDriveFile[]) {
		try { const db = await openDriveCacheIDB(); await idbPut(db, 'drive-files', { files, savedAt: Date.now() }, cacheKey); db.close(); }
		catch { /* ignore cache write failures */ }
	}
	async function loadDriveCache(cacheKey: string): Promise<GoogleDriveFile[] | null> {
		try {
			const db = await openDriveCacheIDB();
			const entry = await idbGet<{ files: GoogleDriveFile[]; savedAt: number }>(db, 'drive-files', cacheKey);
			db.close();
			if (!entry || Date.now() - entry.savedAt > DRIVE_CACHE_TTL) return null;
			return entry.files;
		} catch { return null; }
	}
	async function bustDriveCache(cacheKey: string) {
		try { const db = await openDriveCacheIDB(); await idbDelete(db, 'drive-files', cacheKey); db.close(); }
		catch { /* ignore */ }
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
			// Restore: keep saved position
			musicSettings.lastTrackIndex = Math.min(musicSettings.lastTrackIndex, tracks.length - 1);
			currentTime = musicSettings.lastTrackTimestamp;
		}
	}

	// EQ constants
	const EQ_FREQS  = [60, 170, 350, 1000, 3500, 10000];
	const EQ_LABELS = ['60', '170', '350', '1K', '3.5K', '10K'];
	const EQ_PRESETS: Record<string, number[]> = {
		flat:      [ 0,  0,  0,  0,  0,  0],
		bass:      [ 8,  5,  2,  0, -1, -1],
		treble:    [-1, -1,  0,  2,  5,  8],
		vocal:     [-2,  0,  4,  5,  3, -1],
		classical: [ 4,  3, -1,  0,  2,  4],
	};

	// ── ephemeral playback state ──
	let tracks      = $state<Track[]>([]);
	let currentTime = $state(0);
	let duration    = $state(0);
	let isPlaying   = $state(false);
	let isLiked     = $state(false);
	let isLoading   = $state(false);
	let showQueue   = $state(false);   // true → browse / folder view
	let showPanel   = $state<'none' | 'speed' | 'eq'>('none');
	let isRestoring = $state(true);  // true until IDB check finishes (prevents empty-state flash)
	let preloadedTrackIndex = $state<number | null>(null);
	let preloadRequestId = 0;
	// Prevents background folder scans from overwriting the track list after the user has
	// explicitly selected a song via playBrowseFile / playCurrentFolder / playFolderPath.
	let trackListLockedByUser = false;

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

	// ── Filtered browse entries (search by name) ─────────────────
	const filteredEntries = $derived(
		fileSearchQuery.trim().length === 0
			? browseEntries
			: browseEntries.filter(e =>
				e.name.toLowerCase().includes(fileSearchQuery.toLowerCase())
			)
	);

	// ── Drive folder picker dialog state ──
	let showFolderPicker      = $state(false);
	let folderPickerFolders   = $state<GoogleDriveFolder[]>([]);
	let folderPickerLoading   = $state(false);
	let folderPickerStack     = $state<{ id: string; name: string }[]>([]);
	let folderPickerToken     = $state('');
	let folderHasSubFolders   = $state<Record<string, boolean>>({}); // folderId → has subfolders

	// ── Web Audio API (lazy-init) ──
	let audioCtx: AudioContext | null = null;
	let filters: BiquadFilterNode[] = [];

	// ── refs ──
	let audioEl: HTMLAudioElement;
	let folderInputEl: HTMLInputElement;
	let nativeFileInputEl: HTMLInputElement;

	// ── derived ──
	const currentTrack    = $derived(tracks[musicSettings.lastTrackIndex] as Track | undefined);

	const hasFolderLoaded = $derived(rootDirHandle !== null || nativeTreeUri !== null || allFiles.length > 0);
	const progressPercent = $derived(
		seekingValue !== null ? seekingValue : (duration > 0 ? (currentTime / duration) * 100 : 0)
	);
	const currentLibraryLabel = $derived(
		musicSettings.librarySource === 'drive' ? 'Google Drive' : musicSettings.lastFolderName || 'Library'
	);

	// ── register stop-callback for cross-view audio exclusivity ──
	$effect(() => {
		registerAudioSource('music', () => {
			if (audioEl && isPlaying) {
				// Save position before yielding so resuming feels seamless
				musicSettings.lastTrackTimestamp = audioEl.currentTime;
				audioEl.pause();
			}
		});
	});

	// ── register MediaSession skip handlers for Android Auto / lock-screen controls ──
	$effect(() => {
		// Guard: methods may not be accessible if the $state proxy wraps them
		if (typeof mediaEngine.setSkipHandlers !== 'function') return;
		mediaEngine.setSkipHandlers(
			() => { void advanceTrack(isPlaying); },
			() => { void prevTrack(); }
		);
		return () => {
			if (typeof mediaEngine.setSkipHandlers === 'function')
				mediaEngine.setSkipHandlers(null, null);
		};
	});

	// ── register MediaSession play/pause/seek handlers for lock-screen notification ──
	$effect(() => {
		// Guard: methods may not be accessible if the $state proxy wraps them
		if (typeof mediaEngine.setPlaybackHandlers !== 'function') return;
		mediaEngine.setPlaybackHandlers(
			() => { void togglePlay(); },
			() => { void togglePlay(); },
			(pos) => { if (audioEl) { audioEl.currentTime = pos; currentTime = pos; } }
		);
		return () => {
			if (typeof mediaEngine.setPlaybackHandlers === 'function')
				mediaEngine.setPlaybackHandlers(null, null, null);
		};
	});

	function syncTrackToMediaEngine(index: number) {
		const track = tracks[index];
		if (!track) return;
		if (mediaEngine.source && mediaEngine.source !== 'music') return;
		mediaEngine.setNowPlaying({
			id:         String(track.id),
			source:     'music',
			title:      track.title,
			subtitle:   track.artist,
			audioUrl:   '',
			artworkUrl: undefined,
			duration:   track.duration > 0 ? track.duration : undefined,
		}, 'music');
	}

	// ── reload browse entries when path or folder version changes ──
	$effect(() => {
		const path = [...browsePath];
		const driveFilter = driveSearch.trim().toLowerCase();
		browseVersion; // reactive dependency
		musicSettings.librarySource;
		void loadBrowseEntries(path, driveFilter);
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
			mediaEngine.updateTime(audioEl.currentTime, isFinite(audioEl.duration) ? audioEl.duration : 0);
		};
		const onLoadedMetadata = () => {
			duration = isFinite(audioEl.duration) ? audioEl.duration : 0;
			tracks = tracks.map((t, i) =>
				i === musicSettings.lastTrackIndex
					? { ...t, duration: isFinite(audioEl.duration) ? Math.round(audioEl.duration) : 0 }
					: t
			);
		};
		const onPlay  = () => { isPlaying = true;  mediaEngine.setPlaying(true);  };
		const onPause = () => {
			isPlaying = false;
			mediaEngine.setPlaying(false);
			// Persist position so it's visible in settings and survives any future restore
			musicSettings.lastTrackTimestamp = audioEl.currentTime;
			// Per-track resume: save current position
			saveTrackPosition(musicSettings.lastTrackIndex, audioEl.currentTime);
		};
		const onEnded = () => {
			// Track finished — clear any saved resume position
			clearTrackPosition(musicSettings.lastTrackIndex);
			if (musicSettings.isRepeat) { audioEl.currentTime = 0; audioEl.play().catch(() => {}); }
			else void advanceTrack(true, false);
		};
		const onError = () => { void advanceTrack(true, false); };
		audioEl.volume = musicSettings.volume / 100;
		audioEl.muted  = musicSettings.isMuted;
		audioEl.playbackRate = musicSettings.playbackSpeed;
		audioEl.addEventListener('timeupdate',     onTimeUpdate);
		audioEl.addEventListener('loadedmetadata', onLoadedMetadata);
		audioEl.addEventListener('play',  onPlay);
		audioEl.addEventListener('pause', onPause);
		audioEl.addEventListener('ended', onEnded);
		audioEl.addEventListener('error', onError);
		return () => {
			audioEl?.removeEventListener('timeupdate',     onTimeUpdate);
			audioEl?.removeEventListener('loadedmetadata', onLoadedMetadata);
			audioEl?.removeEventListener('play',  onPlay);
			audioEl?.removeEventListener('pause', onPause);
			audioEl?.removeEventListener('ended', onEnded);
			audioEl?.removeEventListener('error', onError);
		};
	});

	// ── Sync volume / mute ──
	$effect(() => {
		if (audioEl) { audioEl.volume = musicSettings.volume / 100; audioEl.muted = musicSettings.isMuted; }
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
		musicSettings.eqBands.forEach((gain, i) => {
			if (filters[i]) filters[i].gain.value = gain;
		});
	});

	// ─────────────────────────────────────────────────────────────
	// Web Audio API
	// ─────────────────────────────────────────────────────────────
	function initAudioContext() {
		if (!audioEl) return;
		if (audioCtx) { if (audioCtx.state === 'suspended') audioCtx.resume(); return; }
		try {
			const ctx = new AudioContext();
			const src = ctx.createMediaElementSource(audioEl);
			const bands = EQ_FREQS.map((freq, i) => {
				const f = ctx.createBiquadFilter();
				f.type = (i === 0 ? 'lowshelf' : i === EQ_FREQS.length - 1 ? 'highshelf' : 'peaking') as BiquadFilterType;
				f.frequency.value = freq;
				if (f.type === 'peaking') f.Q.value = 1.4;
				f.gain.value = musicSettings.eqBands[i] ?? 0;
				return f;
			});
			let node: AudioNode = src;
			for (const b of bands) { node.connect(b); node = b; }
			node.connect(ctx.destination);
			filters = bands;
			audioCtx = ctx;
		} catch { /* AudioContext not available */ }
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
	function fmtGain(g: number): string { return (g > 0 ? '+' : '') + g; }

	// ─────────────────────────────────────────────────────────────
	// General helpers
	// ─────────────────────────────────────────────────────────────
	function formatTime(seconds: number): string {
		if (!isFinite(seconds) || seconds < 0) return '0:00';
		const m = Math.floor(seconds / 60), s = Math.floor(seconds % 60);
		return `${m}:${s.toString().padStart(2, '0')}`;
	}
	function parseFilename(filename: string): { title: string; artist: string } {
		const name = filename.replace(/\.mp3$/i, '').replace(/_/g, ' ');
		const sep = name.indexOf(' - ');
		if (sep > 0) return { artist: name.slice(0, sep).trim(), title: name.slice(sep + 3).trim() };
		return { title: name, artist: 'Unknown Artist' };
	}
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
		return [...files].sort((a, b) => {
			if (musicSettings.sortOrder === 'title')
				return parseFilename(a.name).title.localeCompare(parseFilename(b.name).title);
			if (musicSettings.sortOrder === 'artist')
				return parseFilename(a.name).artist.localeCompare(parseFilename(b.name).artist);
			return a.name.localeCompare(b.name, undefined, { numeric: true });
		});
	}

	function createStoredAudioFile(file: File): StoredAudioFile {
		const relativePath = file.webkitRelativePath?.split('/').slice(1).join('/') ?? file.name;
		return createStoredWebAudioFile(file, relativePath && relativePath.length > 0 ? relativePath : file.name);
	}

	function createStoredWebAudioFile(file: File, relativePath: string): StoredAudioFile {
		return {
			source: 'web',
			name: file.name,
			relativePath: relativePath && relativePath.length > 0 ? relativePath : file.name,
			file,
		};
	}

	function createStoredNativeAudioFile(entry: NativeDirectoryFile): StoredAudioFile {
		return {
			source: 'native',
			name: entry.name,
			relativePath: entry.relativePath,
			path: entry.path,
			mimeType: entry.mimeType,
			modifiedAt: entry.modifiedAt,
		};
	}

	function createStoredDriveAudioFile(entry: GoogleDriveFile): StoredAudioFile {
		return {
			source: 'drive',
			name: entry.name,
			relativePath: entry.relativePath ?? entry.name,
			fileId: entry.id,
			mimeType: entry.mimeType,
			modifiedAt: entry.modifiedTime ? new Date(entry.modifiedTime).getTime() : undefined,
			sizeBytes: entry.size ? Number(entry.size) : undefined,
			webViewLink: entry.webViewLink,
		};
	}

	function pathToString(path: string[]): string | undefined {
		return path.length > 0 ? path.join('/') : undefined;
	}

	function getRelativePath(file: StoredAudioFile): string {
		return file.relativePath && file.relativePath.length > 0 ? file.relativePath : file.name;
	}

	// ── Per-track resume helpers ──────────────────────────────────
	function getTrackKey(source: StoredAudioFile): string {
		if (source.source === 'drive')  return `d:${source.fileId}`;
		if (source.source === 'native') return `n:${source.relativePath}`;
		return `w:${source.relativePath}`;
	}

	function saveTrackPosition(index: number, positionSec: number) {
		const track = tracks[index];
		if (!track) return;
		const key = getTrackKey(track.source);
		// Only save if meaningfully into the track and not within 5s of the end
		const nearEnd = duration > 0 && positionSec >= duration - 5;
		if (positionSec > 5 && !nearEnd) {
			mp3TrackPositions.positions = { ...mp3TrackPositions.positions, [key]: positionSec };
		} else {
			clearTrackPosition(index);
		}
	}

	function clearTrackPosition(index: number) {
		const track = tracks[index];
		if (!track) return;
		const key = getTrackKey(track.source);
		if (!(key in mp3TrackPositions.positions)) return;
		const { [key]: _removed, ...rest } = mp3TrackPositions.positions;
		mp3TrackPositions.positions = rest;
	}

	function applyTrackPosition(index: number) {
		const track = tracks[index];
		if (!track) return;
		const pos = mp3TrackPositions.positions[getTrackKey(track.source)] ?? 0;
		if (pos > 5) {
			audioEl.addEventListener('loadedmetadata', () => { audioEl.currentTime = pos; }, { once: true });
		}
	}

	function bytesFromBase64(data: string): Uint8Array {
		const base64 = data.includes(',') ? (data.split(',').pop() ?? '') : data;
		const normalized = base64.replace(/\s/g, '');
		const binary = atob(normalized);
		const bytes = new Uint8Array(binary.length);

		for (let index = 0; index < binary.length; index += 1) {
			bytes[index] = binary.charCodeAt(index);
		}

		return bytes;
	}

	function arrayBufferFromBytes(bytes: Uint8Array): ArrayBuffer {
		return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
	}

	async function blobFromNativePath(path: string, mimeType?: string): Promise<Blob> {
		try {
			const result = await Filesystem.readFile({ path });
			if (result.data instanceof Blob) {
				return result.data;
			}

			return new Blob([arrayBufferFromBytes(bytesFromBase64(result.data))], {
				type: mimeType ?? 'audio/mpeg',
			});
		} catch {
			// Fall back to HTTP bridge reads for file:// paths if native read fails.
		}

		const candidates = [Capacitor.convertFileSrc(path), path];

		for (const candidate of candidates) {
			try {
				const response = await fetch(candidate);
				if (response.ok) {
					return await response.blob();
				}
			} catch {
				// try next candidate
			}
		}

		throw new Error(`Unable to read selected file at ${path}`);
	}

	function formatDriveAuthError(error: unknown): string {
		const message = error instanceof Error ? error.message : 'Unable to access Google Drive.';

		if (/popup_closed|popup closed|access denied|interrupted/i.test(message)) {
			return 'Google sign-in was cancelled.';
		}

		if (/public_google_client_id/i.test(message)) {
			return 'Google Drive is not configured. Add PUBLIC_GOOGLE_CLIENT_ID to enable sign-in.';
		}

		return message;
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
		driveSearch = '';
	}

	function activateDriveLibrary() {
		musicSettings.librarySource = 'drive';
		musicSettings.nativeTreeUri = '';
		musicSettings.lastFolderName = 'Google Drive';
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
			return;
		}

		isDriveAuthenticating = interactive;
		isDriveLoading = true;

		try {
			const token = await ensureDriveAccessToken(interactive);
			if (!token) {
				return;
			}

			const user = await fetchGoogleDriveUser(token);
			driveUser = user;
			driveError = '';

			// Connect config sync (appdata scope) silently, then download + apply saved settings.
			// This happens in the background — we don't block the folder picker on it.
			void (async () => {
				const connected = await driveConfigSync.connect(false);
				if (connected) {
					await driveConfigSync.downloadAndApply();
				} else {
					// First-time or needs consent — request interactively after picker resolves
					const ok = await driveConfigSync.connect(true);
					if (ok) await driveConfigSync.downloadAndApply();
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
		await loadFolderPickerLevel();
		showFolderPicker = true;
	}

	async function loadFolderPickerLevel() {
		folderPickerLoading = true;
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
		} catch {
			folderPickerFolders = [];
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
		musicSettings.driveFolderId = folderId ?? '';
		musicSettings.driveFolderName = folderName ?? '';
		const token = folderPickerToken;
		folderPickerToken = '';
		await finishDriveLoad(token, folderId);
	}

	function cancelFolderPicker() {
		showFolderPicker = false;
		folderPickerToken = '';
		folderPickerStack = [];
		folderPickerFolders = [];
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
			allFiles = [];
			activateDeviceLibrary(fav.name);
			browsePath = [];
			browseVersion++;
			showQueue = true;
			trackListLockedByUser = false;
			void (async () => {
				const cachedFiles = await collectAllFromPath([]);
				allFiles = cachedFiles;
				if (!trackListLockedByUser) hydrateTracksFromLibrary(cachedFiles);
				await saveCachedLibrary(fav.name, cachedFiles);
			})();
		}
		} finally {
			switchingToFavId = null;
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
	async function loadBrowseEntries(path: string[], driveFilter = '') {
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
			} else if (allFiles.length > 0) {
				const prefix = path.length > 0 ? path.join('/') + '/' : '';
				const seen = new Set<string>();
				const folders: BrowseEntry[] = [];
				const files: BrowseEntry[] = [];
				for (const file of allFiles) {
					const normalized = getRelativePath(file);
					if (!normalized.startsWith(prefix)) continue;
					const remaining = normalized.slice(prefix.length);
					if (!remaining) continue;
					const slash = remaining.indexOf('/');
					if (slash === -1) {
						files.push({ kind: 'file', name: remaining, file });
					} else {
						const folderName = remaining.slice(0, slash);
						if (!seen.has(folderName)) {
							seen.add(folderName);
							const subPrefix = prefix + folderName + '/';
							const count = allFiles.filter(f => {
								const p = getRelativePath(f);
								return p.startsWith(subPrefix);
							}).length;
							folders.push({ kind: 'folder', name: folderName, count });
						}
					}
				}
				folders.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
				files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
				browseEntries = [...folders, ...files];
			} else {
				browseEntries = [];
			}
		} catch { browseEntries = []; }
		browseLoading = false;
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
			const prefix = path.length > 0 ? path.join('/') + '/' : '';
			return sortFiles(allFiles.filter(f => {
				const p = getRelativePath(f);
				return prefix ? p.startsWith(prefix) : true;
			}));
		} else if (rootDirHandle) {
			const dir = await resolveDirAtPath(path);
			return dir ? (await collectFilesFromDirHandle(dir)).map((file) => createStoredAudioFile(file)) : [];
		} else if (nativeTreeUri) {
			const result = await DirectoryReader.listAudioFiles({ treeUri: nativeTreeUri, path: pathToString(path) });
			return result.files.map((file) => createStoredNativeAudioFile(file));
		} else if (allFiles.length > 0) {
			const prefix = path.length > 0 ? path.join('/') + '/' : '';
			return allFiles.filter(f => {
				const p = getRelativePath(f);
				return p.startsWith(prefix);
			});
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
			return null;
		}
	}

	function getNextTrackIndex(currentIndex: number): number | null {
		if (tracks.length === 0) {
			return null;
		}

		if (musicSettings.isShuffle) {
			if (tracks.length === 1) {
				return 0;
			}

			if (preloadedTrackIndex !== null && preloadedTrackIndex !== currentIndex && tracks[preloadedTrackIndex]) {
				return preloadedTrackIndex;
			}

			let nextIndex = currentIndex;
			while (nextIndex === currentIndex) {
				nextIndex = Math.floor(Math.random() * tracks.length);
			}

			return nextIndex;
		}

		const atEnd = currentIndex === tracks.length - 1;
		if (atEnd && !musicSettings.isRepeat) {
			return null;
		}

		return atEnd ? 0 : currentIndex + 1;
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
	function loadTracks(files: StoredAudioFile[], folder: string) {
		// Clear the audio src before revoking blob URLs to prevent a stale error event
		// from firing advanceTrack while the new track is still loading.
		if (audioEl) { audioEl.pause(); audioEl.src = ''; }
		revokeAll();
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
		currentTime = 0; duration = 0; isPlaying = false;
		trackListLockedByUser = true;
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
				try {
					await DirectoryReader.rememberTreeUri({ treeUri });
				} catch (error) {
					console.warn('Unable to persist tree URI permission.', error);
				}
				trackListLockedByUser = false;
				void (async () => {
					const cachedFiles = await collectAllFromPath([]);
					allFiles = cachedFiles;
					if (!trackListLockedByUser) hydrateTracksFromLibrary(cachedFiles);
					await saveCachedLibrary(folderName, cachedFiles);
				})();
			} catch (error) {
				console.error('Failed to open native folder.', error);
				if (nativeFileInputEl) {
					nativeFileInputEl.click();
					return;
				}
				alert('Unable to open a folder on this device. Please try again.');
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
				trackListLockedByUser = false;
				void (async () => {
					const cachedFiles = await collectStoredFilesFromDirHandle(dirHandle);
					allFiles = cachedFiles;
					if (!trackListLockedByUser) hydrateTracksFromLibrary(cachedFiles);
					await saveCachedLibrary(dirHandle.name, cachedFiles);
				})();
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
				trackListLockedByUser = false;
				void (async () => {
					const cachedFiles = await collectStoredFilesFromDirHandle(rootDirHandle);
					allFiles = cachedFiles;
					if (!trackListLockedByUser) hydrateTracksFromLibrary(cachedFiles);
					await saveCachedLibrary(rootDirHandle.name, cachedFiles);
				})();
			}
		} catch { /* user denied */ }
	}

	// ─────────────────────────────────────────────────────────────
	// Browse interactions
	// ─────────────────────────────────────────────────────────────

	// ── Shared audio start sequence — used by all user-initiated play functions ──
	async function startAudioAt(index: number): Promise<boolean> {
		if (!audioEl || !tracks[index]) return false;
		const url = await ensureTrackUrl(index, true);
		if (!url) { alert('Unable to load this track.'); return false; }
		audioEl.src = url; audioEl.load();
		syncTrackToMediaEngine(index);
		applyTrackPosition(index);
		void preloadNextTrack(index);
		claimAudio('music');
		initAudioContext();
		audioEl.play().catch(() => {});
		return true;
	}

	// Play a single file → load all siblings as context
	async function playBrowseFile(entry: BrowseEntry & { kind: 'file' }) {
		const siblings = (browseEntries.filter(e => e.kind === 'file') as (BrowseEntry & { kind: 'file' })[]).map(e => e.file);
		loadTracks(siblings, browsePath.length > 0 ? browsePath[browsePath.length - 1] : musicSettings.lastFolderName);
		const sorted = sortFiles(siblings);
		const idx = sorted.findIndex(f => f === entry.file);
		musicSettings.lastTrackIndex = Math.max(0, idx);
		currentTime = 0; duration = 0;
		await startAudioAt(musicSettings.lastTrackIndex);
	}

	// Play only the files visible in the current folder view (no recursion)
	async function playCurrentFolder() {
		const files = (browseEntries.filter(e => e.kind === 'file') as (BrowseEntry & { kind: 'file' })[]).map(e => e.file);
		if (files.length === 0) { alert('No MP3 files found.'); return; }
		const label = browsePath.length > 0 ? browsePath[browsePath.length - 1] : (musicSettings.lastFolderName || 'Library');
		loadTracks(files, label);
		await startAudioAt(0);
	}

	// Play all files under a given browse path (recursively)
	async function playFolderPath(path: string[]) {
		isLoading = true;
		const files = await collectAllFromPath(path);
		isLoading = false;
		if (files.length === 0) { alert('No MP3 files found.'); return; }
		loadTracks(files, path.length > 0 ? path[path.length - 1] : musicSettings.lastFolderName);
		await startAudioAt(0);
	}

	function navigateInto(name: string) { browsePath = [...browsePath, name]; }
	function navigateUp() {
		if (browsePath.length > 0) browsePath = browsePath.slice(0, -1);
		else showQueue = false;
	}

	// ─────────────────────────────────────────────────────────────
	// Playback controls
	// ─────────────────────────────────────────────────────────────
	async function togglePlay() {
		if (!audioEl || !currentTrack) return;
		initAudioContext();
		if (isPlaying) { audioEl.pause(); }
		else {
			claimAudio('music');
			if (!audioEl.src || audioEl.src === window.location.href) {
				const url = await ensureTrackUrl(musicSettings.lastTrackIndex, true);
				if (!url) {
					alert('Unable to load this track.');
					return;
				}
				audioEl.src = url;
				audioEl.load();
				syncTrackToMediaEngine(musicSettings.lastTrackIndex);
				applyTrackPosition(musicSettings.lastTrackIndex);
			}
			void preloadNextTrack(musicSettings.lastTrackIndex);
			audioEl.play().catch(() => {});
		}
	}

	async function selectTrack(index: number) {
		releaseTrackUrl(musicSettings.lastTrackIndex);
		musicSettings.lastTrackIndex = index;
		musicSettings.lastTrackTimestamp = 0;
		currentTime = 0; duration = 0;
		await startAudioAt(index);
	}

	async function advanceTrack(wasPlaying: boolean, interactiveAuth = false) {
		if (tracks.length === 0) return;
		const idx = musicSettings.lastTrackIndex;
		const nextIndex = getNextTrackIndex(idx);
		if (nextIndex === null) {
			isPlaying = false; currentTime = 0;
			if (audioEl) { audioEl.pause(); audioEl.currentTime = 0; }
			return;
		}
		releaseTrackUrl(idx);
		musicSettings.lastTrackIndex = nextIndex;
		musicSettings.lastTrackTimestamp = 0;
		currentTime = 0; duration = 0;
		if (audioEl && tracks[nextIndex]) {
			const url = await ensureTrackUrl(nextIndex, interactiveAuth);
			if (!url) {
				isPlaying = false;
				return;
			}
			audioEl.src = url; audioEl.load();
			syncTrackToMediaEngine(nextIndex);
			applyTrackPosition(nextIndex);
			void preloadNextTrack(nextIndex);
			if (wasPlaying) audioEl.play().catch(() => { isPlaying = false; });
		}
	}

	async function prevTrack() {
		if (tracks.length === 0) return;
		if (musicSettings.rewindOnPrev && currentTime > 3 && audioEl) { audioEl.currentTime = 0; return; }
		releaseTrackUrl(musicSettings.lastTrackIndex);
		const prevIndex = (musicSettings.lastTrackIndex - 1 + tracks.length) % tracks.length;
		musicSettings.lastTrackIndex = prevIndex;
		musicSettings.lastTrackTimestamp = 0;
		currentTime = 0; duration = 0;
		if (audioEl && tracks[prevIndex]) {
			const url = await ensureTrackUrl(prevIndex, true);
			if (!url) {
				return;
			}
			audioEl.src = url; audioEl.load();
			syncTrackToMediaEngine(prevIndex);
			applyTrackPosition(prevIndex);
			void preloadNextTrack(prevIndex);
			if (isPlaying) audioEl.play().catch(() => {});
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
	function handleVolume(e: Event) {
		const input = e.target as HTMLInputElement;
		musicSettings.volume = parseFloat(input.value);
		musicSettings.isMuted = musicSettings.volume === 0;
	}
	function toggleMute() { musicSettings.isMuted = !musicSettings.isMuted; }
	function togglePanel(p: 'speed' | 'eq') {
		showPanel = showPanel === p ? 'none' : p;
		if (showPanel !== 'none') initAudioContext();
	}

	// ── Restore last folder handle from IndexedDB on mount ───────
	// untrack() prevents any reactive reads in the sync preamble (e.g. driveAccessToken reads
	// inside ensureDriveAccessToken) from becoming effect dependencies, which would otherwise
	// cause this effect to re-run when those signals are written during hydration — leading to
	// multiple concurrent finishDriveLoad calls and a spinner that never resolves.
	$effect(() => {
		untrack(() => {
		if (musicSettings.librarySource === 'drive') {
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
				const [handle, cachedLibrary] = await Promise.all([loadHandleFromIDB(), loadCachedLibrary()]);
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
	<div class="flex flex-col h-full">

		<!-- Header -->
		<div class="flex items-center gap-2 px-3 py-3 border-b shrink-0">
			<Button variant="ghost" size="icon" class="shrink-0" onclick={navigateUp}>
				<ChevronLeft class="w-5 h-5" />
			</Button>

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

			<!-- Play All current path + Change folder -->
			<div class="flex items-center gap-1 shrink-0">
				<Button size="sm" variant="default" class="gap-1 text-xs h-9 px-3"
					onclick={playCurrentFolder} disabled={isLoading}>
					{#if isLoading}
						<div class="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin"></div>
					{:else}
						<Play class="w-4 h-4 ml-0.5" />
					{/if}
					All
				</Button>
				{#if currentFolderAsFavorite()}
					<Button variant="ghost" size="icon" class={`h-10 w-10 ${isCurrentFolderFavorited() ? 'text-yellow-400' : ''}`} onclick={toggleCurrentFolderFavorite} aria-label={isCurrentFolderFavorited() ? 'Remove from favorites' : 'Add to favorites'} title={isCurrentFolderFavorited() ? 'Remove from favorites' : 'Add to favorites'}>
						<Star class="w-5 h-5" fill={isCurrentFolderFavorited() ? 'currentColor' : 'none'} />
					</Button>
				{/if}
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

		{#if musicSettings.librarySource === 'drive'}
			<div class="px-4 py-3 border-b space-y-3 bg-card/40 shrink-0">
				<div class="flex items-center justify-between gap-3">
					<div class="min-w-0">
						<p class="text-sm font-medium truncate">{driveUser?.displayName || 'Google Drive'}</p>
						<p class="text-xs text-muted-foreground truncate">
							{driveUser?.emailAddress || 'Connected account'}
							{#if allFiles.length > 0}
								· {allFiles.length} MP3 file{allFiles.length === 1 ? '' : 's'}
							{/if}
						</p>
						{#if musicSettings.driveFolderName}
							<p class="text-xs text-primary truncate mt-0.5">
								<Folder class="w-3 h-3 inline mr-0.5 -mt-0.5" />{musicSettings.driveFolderName}
							</p>
						{:else}
							<p class="text-xs text-muted-foreground truncate mt-0.5">All files</p>
						{/if}
					</div>
					<div class="flex items-center gap-1 shrink-0">
						<Button variant="ghost" size="sm" class="text-xs h-10 px-3" onclick={changeDriveFolder} title="Change folder">
							<FolderOpen class="w-5 h-5" />
						</Button>
						<Button variant="ghost" size="sm" class={`text-xs h-10 px-2 ${isCurrentFolderFavorited() ? 'text-yellow-400' : ''}`} onclick={toggleCurrentFolderFavorite} title={isCurrentFolderFavorited() ? 'Remove from favorites' : 'Add to favorites'}>
							<Star class="w-5 h-5" fill={isCurrentFolderFavorited() ? 'currentColor' : 'none'} />
						</Button>
						<!-- Config sync indicator -->
						{#if driveConfigSync.isConnected}
							<button
								class="w-8 h-8 flex items-center justify-center rounded-full hover:bg-accent transition-colors shrink-0"
								onclick={() => driveConfigSync.save()}
								title={driveConfigSync.lastSyncedAt ? `Config synced ${driveConfigSync.lastSyncedAt.toLocaleTimeString()}` : 'Sync settings to Drive'}
							>
								{#if driveConfigSync.status === 'syncing'}
									<RefreshCw class="w-4 h-4 text-primary animate-spin" />
								{:else if driveConfigSync.status === 'saved'}
									<Cloud class="w-4 h-4 text-green-500" />
								{:else if driveConfigSync.status === 'error'}
									<Cloud class="w-4 h-4 text-destructive" />
								{:else}
									<Cloud class="w-4 h-4 text-primary" />
								{/if}
							</button>
						{:else}
							<Cloud class="w-5 h-5 text-primary shrink-0" />
						{/if}
					</div>
				</div>
				<div class="relative">
					<Search class="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
					<Input bind:value={driveSearch} placeholder="Search Google Drive MP3s" class="pl-9" />
				</div>
				{#if isDriveLoading}
					<div class="flex items-center gap-2 text-xs text-muted-foreground bg-muted/40 rounded-lg px-3 py-2">
						<div class="w-3 h-3 border border-primary border-t-transparent rounded-full animate-spin shrink-0"></div>
						<span class="flex-1 min-w-0 truncate">
							{#if driveLoadProgress.foldersScanned > 0}
								{driveLoadProgress.filesFound} file{driveLoadProgress.filesFound === 1 ? '' : 's'} found
								· {driveLoadProgress.foldersScanned} folder{driveLoadProgress.foldersScanned === 1 ? '' : 's'} scanned
								{#if driveLoadProgress.foldersQueued > 0}
									· {driveLoadProgress.foldersQueued} remaining
								{/if}
							{:else}
								Scanning Drive…
							{/if}
						</span>
						<button class="text-xs underline hover:text-foreground shrink-0" onclick={cancelDriveLoad}>Cancel</button>
					</div>
				{/if}
				{#if driveError}
					<p class="text-xs text-destructive">{driveError}</p>
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
						: (musicSettings.librarySource === 'device' && nativeTreeUri === fav.treeUri)}
					<div class="flex items-center gap-0.5 shrink-0 rounded-full border pl-2.5 pr-1 py-1 text-xs {isActive ? 'bg-primary text-primary-foreground border-primary' : 'bg-muted/40 border-border'}">
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
			{#if browseEntries.length > 0}
				<div class="px-4 pt-3 pb-1">
					<div class="relative">
						<Search class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
						<input
							type="search"
							placeholder="Filter files…"
							bind:value={fileSearchQuery}
							class="w-full pl-9 pr-3 py-2 rounded-lg border bg-muted/40 text-sm outline-none focus:ring-2 focus:ring-primary/50"
							aria-label="Filter files"
						/>
					</div>
				</div>
			{/if}
			{#if browseLoading}
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
					<!-- Folder row -->
					<div class="flex items-center gap-3 px-4 py-3 border-b hover:bg-accent transition-colors">
						<div class="w-9 h-9 rounded-lg bg-primary/15 flex items-center justify-center shrink-0">
							<Folder class="w-4.5 h-4.5 text-primary" />
						</div>
						<button class="flex-1 min-w-0 text-left" onclick={() => navigateInto(entry.name)}>
							<p class="font-medium text-sm truncate">{entry.name}</p>
							<p class="text-xs text-muted-foreground">{entry.count > 0 ? entry.count + ' MP3 file' + (entry.count !== 1 ? 's' : '') : 'folder'}</p>
						</button>
						<!-- Play all in this subfolder -->
						<button
							class="w-9 h-9 rounded-full bg-primary/20 hover:bg-primary/40 flex items-center justify-center text-primary shrink-0 transition-colors"
							onclick={() => playFolderPath([...browsePath, entry.name])}
							aria-label="Play {entry.name}"
						>
							<Play class="w-4 h-4 ml-0.5" />
						</button>
						<!-- Navigate into -->
						<button class="text-muted-foreground shrink-0" onclick={() => navigateInto(entry.name)} aria-label="Browse {entry.name}">
							<ChevronRight class="w-5 h-5" />
						</button>
					</div>
					{:else}
					<!-- File row -->
					<div class="flex items-center gap-3 px-4 py-3 border-b hover:bg-accent transition-colors">
						<div class="w-9 h-9 rounded-lg bg-muted/40 flex items-center justify-center shrink-0">
							<Music2 class="w-4 h-4 text-muted-foreground" />
						</div>
						<button class="flex-1 min-w-0 text-left" onclick={() => playBrowseFile(entry)}>
							<p class="font-medium text-sm truncate">{parseFilename(entry.name).title}</p>
							<p class="text-xs text-muted-foreground truncate">{parseFilename(entry.name).artist}</p>
						</button>
						<button
							class="w-9 h-9 rounded-full bg-primary/20 hover:bg-primary/40 flex items-center justify-center text-primary shrink-0 transition-colors"
							onclick={() => playBrowseFile(entry)}
							aria-label="Play {entry.name}"
						>
							<Play class="w-4 h-4 ml-0.5" />
						</button>
					</div>
					{/if}
				{/each}
			{/if}
		</div>

		<!-- ─── Mini player bar ─── -->
		{#if currentTrack}
		<div class="border-t bg-background shrink-0 pb-safe">
			<!-- Track info row – tap to expand full player -->
			<div class="flex items-center gap-3 px-4 pt-3 pb-1">
				<button class="flex items-center gap-3 flex-1 min-w-0 text-left" onclick={() => (showQueue = false)}>
					<div class="w-10 h-10 rounded-xl bg-gradient-to-br from-cyan-500 to-blue-800 flex items-center justify-center shrink-0">
						{#if isPlaying}
							<span class="flex gap-0.5 items-end h-4">
								<span class="w-0.5 rounded bg-white animate-[bar1_0.8s_ease-in-out_infinite]" style="height:55%"></span>
								<span class="w-0.5 rounded bg-white animate-[bar2_0.8s_ease-in-out_infinite_0.2s]" style="height:100%"></span>
								<span class="w-0.5 rounded bg-white animate-[bar1_0.8s_ease-in-out_infinite_0.4s]" style="height:40%"></span>
							</span>
						{:else}
							<Music2 class="w-5 h-5 text-white" />
						{/if}
					</div>
					<div class="flex-1 min-w-0">
						<p class="text-sm font-semibold truncate">{currentTrack.title}</p>
						<p class="text-xs text-muted-foreground truncate">{currentTrack.artist}</p>
					</div>
				</button>
				<!-- Playback controls -->
				<div class="flex items-center gap-2 shrink-0">
					<button class="w-10 h-10 flex items-center justify-center rounded-full hover:bg-accent transition-colors text-muted-foreground hover:text-foreground" onclick={prevTrack} aria-label="Previous">
						<SkipBack class="w-6 h-6" />
					</button>
					<button class="w-12 h-12 flex items-center justify-center rounded-full bg-primary text-primary-foreground hover:bg-primary/90 transition-colors shadow-md" onclick={togglePlay} aria-label={isPlaying ? 'Pause' : 'Play'}>
						{#if isPlaying}<Pause class="w-6 h-6" />{:else}<Play class="w-6 h-6 ml-0.5" />{/if}
					</button>
					<button class="w-10 h-10 flex items-center justify-center rounded-full hover:bg-accent transition-colors text-muted-foreground hover:text-foreground" onclick={() => advanceTrack(isPlaying, true)} aria-label="Next">
						<SkipForward class="w-6 h-6" />
					</button>
				</div>
			</div>
			<!-- Seek slider + times -->
			<div class="px-4 pb-3 space-y-0.5">
				<input
					type="range" min="0" max="100" value={progressPercent}
					oninput={handleSeekInput}
					onchange={handleSeekCommit}
					class="w-full h-2 rounded-full appearance-none cursor-pointer bg-secondary accent-primary"
				/>
				<div class="flex justify-between text-[10px] text-muted-foreground">
					<span>{formatTime(currentTime)}</span>
					<span>{formatTime(duration)}</span>
				</div>
			</div>
		</div>
		{/if}
	</div>

	<!-- ════════════════════════════════ PLAYER VIEW ════════════════════════════════ -->
	{:else if currentTrack}

	<!-- Scrollable player content -->
	<div class="flex flex-col items-center px-6 pt-5 pb-4 gap-4 flex-1 overflow-y-auto">

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
				onclick={() => (isLiked = !isLiked)}
				class="{isLiked ? 'text-red-500' : 'text-muted-foreground'} ml-2 shrink-0"
			>
				<Heart class="w-6 h-6" fill={isLiked ? 'currentColor' : 'none'} />
			</Button>
		</div>

		<!-- Progress -->
		<div class="w-full space-y-1">
			<input type="range" min="0" max="100" value={progressPercent}
				oninput={handleSeekInput}
				onchange={handleSeekCommit}
				class="w-full h-1.5 rounded-full appearance-none cursor-pointer bg-secondary accent-primary" />
			<div class="flex justify-between text-xs text-muted-foreground">
				<span>{formatTime(currentTime)}</span>
				<span class="text-muted-foreground/60 text-[10px]">{musicSettings.lastTrackIndex + 1} / {tracks.length}</span>
				<span>{formatTime(duration)}</span>
			</div>
		</div>

		<!-- Playback Controls -->
		<div class="flex items-center justify-between w-full">
			<Button variant="ghost" size="icon"
				onclick={() => (musicSettings.isShuffle = !musicSettings.isShuffle)}
				class={musicSettings.isShuffle ? 'text-primary' : 'text-muted-foreground'}>
				<Shuffle class="w-6 h-6" />
			</Button>
			<Button variant="ghost" size="icon" onclick={prevTrack}>
				<SkipBack class="w-8 h-8" />
			</Button>
			<Button size="icon" onclick={togglePlay}
				class="w-14 h-14 rounded-full bg-primary text-primary-foreground hover:bg-primary/90 shadow-lg">
				{#if isPlaying}<Pause class="w-7 h-7" />{:else}<Play class="w-7 h-7 ml-0.5" />{/if}
			</Button>
			<Button variant="ghost" size="icon" onclick={() => advanceTrack(isPlaying, true)}>
				<SkipForward class="w-8 h-8" />
			</Button>
			<Button variant="ghost" size="icon"
				onclick={() => (musicSettings.isRepeat = !musicSettings.isRepeat)}
				class={musicSettings.isRepeat ? 'text-primary' : 'text-muted-foreground'}>
				<Repeat class="w-6 h-6" />
			</Button>
		</div>

		<!-- Volume -->
		<div class="flex items-center gap-3 w-full">
			<Button variant="ghost" size="icon" onclick={toggleMute} class="text-muted-foreground shrink-0">
				{#if musicSettings.isMuted || musicSettings.volume === 0}
					<VolumeX class="w-5 h-5" />
				{:else}
					<Volume2 class="w-5 h-5" />
				{/if}
			</Button>
			<input type="range" min="0" max="100"
				value={musicSettings.isMuted ? 0 : musicSettings.volume}
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
	<div class="border-t bg-card/95 px-4 pt-3 pb-3 shrink-0">
		<div class="flex items-center justify-between mb-2">
			<p class="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Equalizer</p>
			<button class="text-xs text-muted-foreground hover:text-foreground px-2 py-0.5 rounded hover:bg-accent transition-colors"
				onclick={() => applyEqPreset('flat')}>Reset</button>
		</div>
		<div class="flex gap-1.5 flex-wrap mb-3">
			{#each Object.keys(EQ_PRESETS) as preset}
				<button
					class="px-2.5 py-1 rounded-full text-xs capitalize border transition-colors {musicSettings.equalizerPreset === preset ? 'bg-primary text-primary-foreground border-primary' : 'border-border hover:bg-accent'}"
					onclick={() => applyEqPreset(preset)}
				>{preset}</button>
			{/each}
		</div>
		<div class="space-y-2">
			{#each EQ_FREQS as _freq, i}
				<div class="flex items-center gap-2">
					<span class="text-[10px] text-muted-foreground w-9 text-right shrink-0 tabular-nums">{EQ_LABELS[i]}</span>
					<input type="range" min="-12" max="12" step="1"
						value={musicSettings.eqBands[i]}
						oninput={(e) => setEqBand(i, +(e.target as HTMLInputElement).value)}
						class="flex-1 h-1.5 rounded-full appearance-none cursor-pointer bg-secondary accent-primary" />
					<span class="text-[10px] text-muted-foreground w-9 text-right shrink-0 tabular-nums">{fmtGain(musicSettings.eqBands[i])}dB</span>
				</div>
			{/each}
		</div>
	</div>
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
