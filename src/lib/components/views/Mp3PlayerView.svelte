<script lang="ts">
	import Button from '$lib/components/ui/Button.svelte';
	import { musicSettings } from '$lib/stores/settings.svelte';
	import { claimAudio, registerAudioSource } from '$lib/stores/activeAudio.svelte';
	import {
		Play, Pause, SkipBack, SkipForward, Shuffle, Repeat,
		Volume2, VolumeX, Heart, ListMusic, FolderOpen, Music2,
		ChevronLeft, ChevronRight, Folder, Gauge, SlidersHorizontal
	} from 'lucide-svelte';

	interface Track {
		id: number; title: string; artist: string;
		filename: string; url: string; duration: number;
	}

	type BrowseEntry =
		| { kind: 'folder'; name: string; count: number }
		| { kind: 'file'; name: string; file: File };

	// ── IndexedDB persistence for FileSystemDirectoryHandle ──────
	function openIDB(): Promise<IDBDatabase> {
		return new Promise((res, rej) => {
			const req = indexedDB.open('music-app', 1);
			req.onupgradeneeded = () => req.result.createObjectStore('handles');
			req.onsuccess = () => res(req.result);
			req.onerror  = () => rej(req.error);
		});
	}
	async function saveHandleToIDB(handle: FileSystemDirectoryHandle) {
		try {
			const db = await openIDB();
			const tx = db.transaction('handles', 'readwrite');
			tx.objectStore('handles').put(handle, 'last-dir');
			await new Promise<void>((res, rej) => { tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); });
			db.close();
		} catch { /* storage unavailable */ }
	}
	async function loadHandleFromIDB(): Promise<FileSystemDirectoryHandle | null> {
		try {
			const db = await openIDB();
			const tx = db.transaction('handles', 'readonly');
			const result = await new Promise<FileSystemDirectoryHandle | null>((res, rej) => {
				const req = tx.objectStore('handles').get('last-dir');
				req.onsuccess = () => res((req.result as FileSystemDirectoryHandle) ?? null);
				req.onerror  = () => rej(req.error);
			});
			db.close();
			return result;
		} catch { return null; }
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

	// ── folder browse state ──
	// rootDirHandle and allFiles MUST be $state so hasFolderLoaded $derived updates
	let rootDirHandle    = $state<FileSystemDirectoryHandle | null>(null);
	let pendingHandle    = $state<FileSystemDirectoryHandle | null>(null); // needs permission
	let allFiles         = $state<File[]>([]);                // webkitdirectory fallback
	let browsePath       = $state<string[]>([]);                 // navigation stack
	let browseEntries    = $state<BrowseEntry[]>([]);
	let browseLoading    = $state(false);
	let browseVersion    = $state(0);                          // bump to force reload

	// ── Web Audio API (lazy-init) ──
	let audioCtx: AudioContext | null = null;
	let filters: BiquadFilterNode[] = [];

	// ── refs ──
	let audioEl: HTMLAudioElement;
	let folderInputEl: HTMLInputElement;

	// ── derived ──
	const currentTrack    = $derived(tracks[musicSettings.lastTrackIndex] as Track | undefined);
	const progressPercent = $derived(duration > 0 ? (currentTime / duration) * 100 : 0);
	const hasFolderLoaded = $derived(rootDirHandle !== null || allFiles.length > 0);

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

	// ── reload browse entries when path or folder version changes ──
	$effect(() => {
		const path = [...browsePath];
		browseVersion; // reactive dependency
		void loadBrowseEntries(path);
	});

	// ── audio element event wiring ──
	$effect(() => {
		if (!audioEl) return;
		const onTimeUpdate = () => { currentTime = audioEl.currentTime; };
		const onLoadedMetadata = () => {
			duration = isFinite(audioEl.duration) ? audioEl.duration : 0;
			tracks = tracks.map((t, i) =>
				i === musicSettings.lastTrackIndex
					? { ...t, duration: isFinite(audioEl.duration) ? Math.round(audioEl.duration) : 0 }
					: t
			);
		};
		const onPlay  = () => { isPlaying = true; };
		const onPause = () => {
			isPlaying = false;
			// Persist position so it's visible in settings and survives any future restore
			musicSettings.lastTrackTimestamp = audioEl.currentTime;
		};
		const onEnded = () => {
			if (musicSettings.isRepeat) { audioEl.currentTime = 0; audioEl.play().catch(() => {}); }
			else advanceTrack(true);
		};
		const onError = () => { advanceTrack(true); };
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
	function revokeAll() { tracks.forEach((t) => URL.revokeObjectURL(t.url)); }
	function sortFiles(files: File[]): File[] {
		return [...files].sort((a, b) => {
			if (musicSettings.sortOrder === 'title')
				return parseFilename(a.name).title.localeCompare(parseFilename(b.name).title);
			if (musicSettings.sortOrder === 'artist')
				return parseFilename(a.name).artist.localeCompare(parseFilename(b.name).artist);
			return a.name.localeCompare(b.name, undefined, { numeric: true });
		});
	}

	// ─────────────────────────────────────────────────────────────
	// Browse — async entry loading
	// ─────────────────────────────────────────────────────────────
	async function loadBrowseEntries(path: string[]) {
		browseLoading = true;
		try {
			if (rootDirHandle) {
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
						files.push({ kind: 'file', name, file: await (handle as FileSystemFileHandle).getFile() });
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
					// strip root folder name from path
					const normalized = file.webkitRelativePath.split('/').slice(1).join('/');
					if (!normalized.startsWith(prefix)) continue;
					const remaining = normalized.slice(prefix.length);
					const slash = remaining.indexOf('/');
					if (slash === -1) {
						files.push({ kind: 'file', name: remaining, file });
					} else {
						const folderName = remaining.slice(0, slash);
						if (!seen.has(folderName)) {
							seen.add(folderName);
							const subPrefix = prefix + folderName + '/';
							const count = allFiles.filter(f => {
								const p = f.webkitRelativePath.split('/').slice(1).join('/');
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
	async function collectAllFromPath(path: string[]): Promise<File[]> {
		if (rootDirHandle) {
			const dir = await resolveDirAtPath(path);
			return dir ? await collectFilesFromDirHandle(dir) : [];
		} else if (allFiles.length > 0) {
			const prefix = path.length > 0 ? path.join('/') + '/' : '';
			return allFiles.filter(f => {
				const p = f.webkitRelativePath.split('/').slice(1).join('/');
				return p.startsWith(prefix);
			});
		}
		return [];
	}

	// ─────────────────────────────────────────────────────────────
	// loadTracks — internal, always called with sorted File[]
	// ─────────────────────────────────────────────────────────────
	function loadTracks(files: File[], folder: string) {
		revokeAll();
		const sorted = sortFiles(files);
		tracks = sorted.map((f, i) => {
			const { title, artist } = parseFilename(f.name);
			return { id: i, title, artist, filename: f.name, url: URL.createObjectURL(f), duration: 0 };
		});
		musicSettings.lastFolderName = folder;
		musicSettings.lastTrackIndex = 0;
		musicSettings.lastTrackTimestamp = 0;
		currentTime = 0; duration = 0; isPlaying = false;
	}

	// ─────────────────────────────────────────────────────────────
	// Folder picker
	// ─────────────────────────────────────────────────────────────
	async function openFolder() {
		if ('showDirectoryPicker' in window) {
			try {
				const dirHandle = await (window as unknown as {
					showDirectoryPicker(o: object): Promise<FileSystemDirectoryHandle>;
				}).showDirectoryPicker({ mode: 'read' });
				rootDirHandle = dirHandle;
				pendingHandle = null;
				allFiles = [];
				musicSettings.lastFolderName = dirHandle.name;
				browsePath = [];
				browseVersion++;  // triggers browse entry reload
				showQueue = true;
				void saveHandleToIDB(dirHandle);
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
		allFiles = files;
		musicSettings.lastFolderName = files[0].webkitRelativePath?.split('/')[0] ?? 'Selected Folder';
		browsePath = [];
		browseVersion++;  // triggers browse entry reload
		showQueue = true;
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
				pendingHandle = null;
				allFiles = [];
				browseVersion++;
				showQueue = true;
				void saveHandleToIDB(rootDirHandle);
			}
		} catch { /* user denied */ }
	}

	// ─────────────────────────────────────────────────────────────
	// Browse interactions
	// ─────────────────────────────────────────────────────────────

	// Play a single file → load all siblings as context
	function playBrowseFile(entry: BrowseEntry & { kind: 'file' }) {
		const siblings = (browseEntries.filter(e => e.kind === 'file') as (BrowseEntry & { kind: 'file' })[]).map(e => e.file);
		revokeAll();
		const sorted = sortFiles(siblings);
		tracks = sorted.map((f, i) => {
			const { title, artist } = parseFilename(f.name);
			return { id: i, title, artist, filename: f.name, url: URL.createObjectURL(f), duration: 0 };
		});
		const idx = sorted.findIndex(f => f === entry.file);
		musicSettings.lastTrackIndex = Math.max(0, idx);
		currentTime = 0; duration = 0;
		if (audioEl && tracks.length > 0) {
			audioEl.src = tracks[musicSettings.lastTrackIndex].url;
			audioEl.load();
			claimAudio('music');
			initAudioContext();
			audioEl.play().catch(() => {});
		}
	}

	// Play all files under a given browse path (recursively)
	async function playFolderPath(path: string[]) {
		isLoading = true;
		const files = await collectAllFromPath(path);
		isLoading = false;
		if (files.length === 0) { alert('No MP3 files found.'); return; }
		loadTracks(files, path.length > 0 ? path[path.length - 1] : musicSettings.lastFolderName);
		if (audioEl && tracks.length > 0) {
			audioEl.src = tracks[0].url;
			audioEl.load();
			claimAudio('music');
			initAudioContext();
			audioEl.play().catch(() => {});
		}
	}

	function navigateInto(name: string) { browsePath = [...browsePath, name]; }
	function navigateUp() {
		if (browsePath.length > 0) browsePath = browsePath.slice(0, -1);
		else showQueue = false;
	}

	// ─────────────────────────────────────────────────────────────
	// Playback controls
	// ─────────────────────────────────────────────────────────────
	function togglePlay() {
		if (!audioEl || !currentTrack) return;
		initAudioContext();
		if (isPlaying) { audioEl.pause(); }
		else {
			claimAudio('music');
			if (!audioEl.src || audioEl.src === window.location.href) { audioEl.src = currentTrack.url; audioEl.load(); }
			audioEl.play().catch(() => {});
		}
	}

	function selectTrack(index: number) {
		musicSettings.lastTrackIndex = index;
		musicSettings.lastTrackTimestamp = 0;
		currentTime = 0; duration = 0;
		if (audioEl && tracks[index]) {
			audioEl.src = tracks[index].url; audioEl.load();
			claimAudio('music');
			audioEl.play().catch(() => {});
		}
	}

	function advanceTrack(wasPlaying: boolean) {
		if (tracks.length === 0) return;
		const idx = musicSettings.lastTrackIndex;
		const nextIndex = musicSettings.isShuffle
			? Math.floor(Math.random() * tracks.length)
			: (idx + 1) % tracks.length;
		const atEnd = !musicSettings.isShuffle && idx === tracks.length - 1;
		if (atEnd && !musicSettings.isRepeat) {
			isPlaying = false; currentTime = 0;
			if (audioEl) { audioEl.pause(); audioEl.currentTime = 0; }
			return;
		}
		musicSettings.lastTrackIndex = nextIndex;
		musicSettings.lastTrackTimestamp = 0;
		currentTime = 0; duration = 0;
		if (audioEl && tracks[nextIndex]) {
			audioEl.src = tracks[nextIndex].url; audioEl.load();
			if (wasPlaying) audioEl.play().catch(() => { isPlaying = false; });
		}
	}

	function prevTrack() {
		if (tracks.length === 0) return;
		if (musicSettings.rewindOnPrev && currentTime > 3 && audioEl) { audioEl.currentTime = 0; return; }
		const prevIndex = (musicSettings.lastTrackIndex - 1 + tracks.length) % tracks.length;
		musicSettings.lastTrackIndex = prevIndex;
		musicSettings.lastTrackTimestamp = 0;
		currentTime = 0; duration = 0;
		if (audioEl && tracks[prevIndex]) {
			audioEl.src = tracks[prevIndex].url; audioEl.load();
			if (isPlaying) audioEl.play().catch(() => {});
		}
	}

	function handleSeek(e: Event) {
		const input = e.target as HTMLInputElement;
		const newTime = (parseFloat(input.value) / 100) * duration;
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
	$effect(() => {
		if (!('showDirectoryPicker' in window)) { isRestoring = false; return; }
		void (async () => {
			try {
				const handle = await loadHandleFromIDB();
				if (!handle) return;
				type FSHandle = { queryPermission(o: object): Promise<string> };
				// queryPermission is safe to call without a user gesture.
				// If Chrome still has the permission in this session, we restore silently.
				// Otherwise we show the "Reconnect" button — requestPermission happens there
				// (inside reconnectFolder) where a real user gesture exists.
				const perm = await (handle as unknown as FSHandle).queryPermission({ mode: 'read' });
				if (perm === 'granted') {
					rootDirHandle = handle;
					allFiles = [];
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

	$effect(() => { return () => { revokeAll(); audioCtx?.close(); }; });
</script>

<!-- Hidden audio element -->
<audio bind:this={audioEl} preload="metadata"></audio>

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

<div class="flex flex-col h-full bg-background">

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
				Select a folder from your device. Sub-folders and files will be shown for browsing.
			</p>
		</div>
		{#if pendingHandle}
			<div class="flex flex-col items-center gap-3 w-full max-w-xs">
				<Button onclick={reconnectFolder} class="gap-2 px-6 h-12 text-base w-full">
					<FolderOpen class="w-5 h-5" /> Reconnect "{musicSettings.lastFolderName}"
				</Button>
				<Button variant="outline" onclick={openFolder} class="gap-2 h-10 text-sm w-full" disabled={isLoading}>
					<FolderOpen class="w-4 h-4" /> Choose a different folder
				</Button>
			</div>
		{:else}
			<Button onclick={openFolder} class="gap-2 px-6 h-12 text-base" disabled={isLoading}>
				{#if isLoading}
					<div class="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin"></div>
					Loading…
				{:else}
					<FolderOpen class="w-5 h-5" /> Open Folder
				{/if}
			</Button>
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
				<button class="text-xs text-muted-foreground hover:text-foreground truncate shrink-0 max-w-[90px]"
					onclick={() => (browsePath = [])}
				>{musicSettings.lastFolderName || 'Library'}</button>
				{#each browsePath as seg, i}
					<ChevronRight class="w-3 h-3 text-muted-foreground shrink-0" />
					<button
						class="text-xs truncate max-w-[90px] {i === browsePath.length - 1 ? 'text-foreground font-medium' : 'text-muted-foreground hover:text-foreground'}"
						onclick={() => (browsePath = browsePath.slice(0, i + 1))}
					>{seg}</button>
				{/each}
			</div>

			<!-- Play All current path + Change folder -->
			<div class="flex items-center gap-1 shrink-0">
				<Button size="sm" variant="default" class="gap-1 text-xs h-7 px-2"
					onclick={() => playFolderPath(browsePath)} disabled={isLoading}>
					{#if isLoading}
						<div class="w-3 h-3 border-2 border-current border-t-transparent rounded-full animate-spin"></div>
					{:else}
						<Play class="w-3 h-3" />
					{/if}
					All
				</Button>
				<Button variant="ghost" size="sm" class="text-xs h-7 px-2" onclick={openFolder}>
					<FolderOpen class="w-3.5 h-3.5" />
				</Button>
			</div>
		</div>



		<!-- Entry list -->
		<div class="flex-1 overflow-y-auto min-h-0">
			{#if browseLoading}
				<div class="flex items-center justify-center h-32">
					<div class="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin"></div>
				</div>
			{:else if browseEntries.length === 0}
				<p class="text-center text-muted-foreground text-sm py-12">No MP3 files or folders here</p>
			{:else}
				{#each browseEntries as entry}
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
							class="w-7 h-7 rounded-full bg-primary/20 hover:bg-primary/40 flex items-center justify-center text-primary shrink-0 transition-colors"
							onclick={() => playFolderPath([...browsePath, entry.name])}
							aria-label="Play {entry.name}"
						>
							<Play class="w-3.5 h-3.5 ml-0.5" />
						</button>
						<!-- Navigate into -->
						<button class="text-muted-foreground shrink-0" onclick={() => navigateInto(entry.name)} aria-label="Browse {entry.name}">
							<ChevronRight class="w-4 h-4" />
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
							class="w-7 h-7 rounded-full bg-primary/20 hover:bg-primary/40 flex items-center justify-center text-primary shrink-0 transition-colors"
							onclick={() => playBrowseFile(entry)}
							aria-label="Play {entry.name}"
						>
							<Play class="w-3.5 h-3.5 ml-0.5" />
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
						<SkipBack class="w-5 h-5" />
					</button>
					<button class="w-12 h-12 flex items-center justify-center rounded-full bg-primary text-primary-foreground hover:bg-primary/90 transition-colors shadow-md" onclick={togglePlay} aria-label={isPlaying ? 'Pause' : 'Play'}>
						{#if isPlaying}<Pause class="w-6 h-6" />{:else}<Play class="w-6 h-6 ml-0.5" />{/if}
					</button>
					<button class="w-10 h-10 flex items-center justify-center rounded-full hover:bg-accent transition-colors text-muted-foreground hover:text-foreground" onclick={() => advanceTrack(isPlaying)} aria-label="Next">
						<SkipForward class="w-5 h-5" />
					</button>
				</div>
			</div>
			<!-- Seek slider + times -->
			<div class="px-4 pb-3 space-y-0.5">
				<input
					type="range" min="0" max="100" value={progressPercent}
					oninput={handleSeek}
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
				<FolderOpen class="w-3.5 h-3.5 shrink-0" />
				<span class="truncate">{musicSettings.lastFolderName}</span>
			</div>
			<Button variant="ghost" size="sm" onclick={openFolder} class="text-xs h-7 px-2 gap-1 shrink-0">
				<FolderOpen class="w-3 h-3" /> Change
			</Button>
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
				<Heart class="w-5 h-5" fill={isLiked ? 'currentColor' : 'none'} />
			</Button>
		</div>

		<!-- Progress -->
		<div class="w-full space-y-1">
			<input type="range" min="0" max="100" value={progressPercent}
				oninput={handleSeek}
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
				<Shuffle class="w-5 h-5" />
			</Button>
			<Button variant="ghost" size="icon" onclick={prevTrack}>
				<SkipBack class="w-8 h-8" />
			</Button>
			<Button size="icon" onclick={togglePlay}
				class="w-14 h-14 rounded-full bg-primary text-primary-foreground hover:bg-primary/90 shadow-lg">
				{#if isPlaying}<Pause class="w-7 h-7" />{:else}<Play class="w-7 h-7 ml-0.5" />{/if}
			</Button>
			<Button variant="ghost" size="icon" onclick={() => advanceTrack(isPlaying)}>
				<SkipForward class="w-8 h-8" />
			</Button>
			<Button variant="ghost" size="icon"
				onclick={() => (musicSettings.isRepeat = !musicSettings.isRepeat)}
				class={musicSettings.isRepeat ? 'text-primary' : 'text-muted-foreground'}>
				<Repeat class="w-5 h-5" />
			</Button>
		</div>

		<!-- Volume -->
		<div class="flex items-center gap-3 w-full">
			<Button variant="ghost" size="icon" onclick={toggleMute} class="text-muted-foreground shrink-0">
				{#if musicSettings.isMuted || musicSettings.volume === 0}
					<VolumeX class="w-4 h-4" />
				{:else}
					<Volume2 class="w-4 h-4" />
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
				>{speed}\xd7</button>
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
	<div class="border-t bg-background px-3 py-2 shrink-0 flex gap-2">
		<Button variant={showQueue ? 'default' : 'outline'} size="sm"
			class="flex-1 gap-1.5 text-xs"
			onclick={() => { showQueue = !showQueue; showPanel = 'none'; }}>
			<ListMusic class="w-3.5 h-3.5" /> Browse
		</Button>
		<Button variant={showPanel === 'speed' ? 'default' : 'outline'} size="sm"
			class="flex-1 gap-1.5 text-xs"
			onclick={() => togglePanel('speed')}>
			<Gauge class="w-3.5 h-3.5" /> {musicSettings.playbackSpeed}\xd7
		</Button>
		<Button variant={showPanel === 'eq' ? 'default' : 'outline'} size="sm"
			class="flex-1 gap-1.5 text-xs"
			onclick={() => togglePanel('eq')}>
			<SlidersHorizontal class="w-3.5 h-3.5" /> EQ
		</Button>
	</div>

	{/if}
</div>

<style>
	@keyframes bar1 { 0%, 100% { height: 30%; } 50% { height: 90%; } }
	@keyframes bar2 { 0%, 100% { height: 90%; } 50% { height: 30%; } }
</style>
