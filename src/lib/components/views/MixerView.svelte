<script lang="ts">
	import { onMount } from 'svelte';
	import { ArrowLeft, Folder, Play, Pause, Square, Volume2, ListMusic, Star, ChevronRight, Repeat, Save, Download, Trash2, Clock } from 'lucide-svelte';
	import { type BrowseEntry, type StoredAudioFile } from '$lib/stores/library.svelte';
	import { getRelativePath, buildBrowseEntries } from '$lib/models/browse';
	import { formatClock as formatTime } from '$lib/models/music';
	import { mixerShared } from '$lib/stores/mixerShared.svelte';
	import { getJSON, setJSON } from '$lib/utils/storage';
	import { musicSettings } from '$lib/stores/settings.svelte';
	import { resolveStoredFileToUrl } from '$lib/audio/fileResolver';
	import { mediaEngine, claimAudio, registerAudioSource } from '$lib/stores/mediaEngine.svelte';
	import { addToast } from '$lib/stores/toastStore.svelte';

	// ── Audio elements (one per deck) ────────────────────────────
	let audioA: HTMLAudioElement | null = $state(null);
	let audioB: HTMLAudioElement | null = $state(null);

	interface DeckState {
		name: string;
		hasTrack: boolean;
		loading: boolean;
		playing: boolean;
		volume: number;
		loop: boolean;
		/** Serializable file reference for persistence across component recreation. */
		_savedFile: TrackRef | null;
	}
	let deckA = $state<DeckState>({ name: '', hasTrack: false, loading: false, playing: false, volume: 0.85, loop: false, _savedFile: null });
	let deckB = $state<DeckState>({ name: '', hasTrack: false, loading: false, playing: false, volume: 0.85, loop: false, _savedFile: null });
	let revokeA: (() => void) | null = null;
	let revokeB: (() => void) | null = null;

	// ── Library browser (independent navigation, data from Music tab's allFiles) ──
	type PickerMode = 'library' | 'favorites' | 'sessions';
	let mode = $state<PickerMode>('library');

	// Independent folder path for the mixer — computed from allFiles, not synced from Music tab.
	let browsePath = $state<string[]>([]);

	const allFiles = $derived(mixerShared.allFiles);
	const browseLoading = $derived(mixerShared.browseLoading);


	const entries = $derived(buildBrowseEntries(allFiles, browsePath));
	const folders = $derived(entries.filter((e): e is Extract<BrowseEntry, { kind: 'folder' }> => e.kind === 'folder'));
	const files = $derived(entries.filter((e): e is Extract<BrowseEntry, { kind: 'file' }> => e.kind === 'file'));

	/** Flat list of all scanned MP3 files — for the root-level picker when no folders exist. */
	const rootFiles = $derived(allFiles);

	function openFolder(name: string) { browsePath = [...browsePath, name]; }
	function goUp() { if (browsePath.length > 0) browsePath = browsePath.slice(0, -1); }
	function goToCrumb(index: number) { browsePath = browsePath.slice(0, index); }

	const resolvableFavorites = $derived(
		musicSettings.favoriteTracks.filter((f) => (f.source === 'native' && f.path) || (f.source === 'drive' && f.fileId))
	);

	function prettyTitle(name: string): string {
		return name.replace(/\.mp3$/i, '').replace(/_/g, ' ').trim();
	}

	function favoriteToStoredFile(fav: (typeof musicSettings.favoriteTracks)[number]): StoredAudioFile | null {
		if (fav.source === 'native' && fav.path) {
			return { source: 'native', name: fav.name, relativePath: fav.relativePath, path: fav.path, mimeType: fav.mimeType, modifiedAt: fav.modifiedAt };
		}
		if (fav.source === 'drive' && fav.fileId) {
			return { source: 'drive', name: fav.name, relativePath: fav.relativePath, fileId: fav.fileId, mimeType: fav.mimeType, modifiedAt: fav.modifiedAt, sizeBytes: fav.sizeBytes, webViewLink: fav.webViewLink };
		}
		return null;
	}

	// ── Deck persistence (survives component recreation on Android) ──
	const DECK_STATE_KEY = 'mixer-deck-state';

	interface SavedDeck {
		file: { source: 'native' | 'drive' | 'web'; name: string; relativePath: string; path?: string; fileId?: string; mimeType?: string; modifiedAt?: number; sizeBytes?: number; webViewLink?: string };
		displayName: string;
		currentTime: number;
		volume: number;
		loop: boolean;
	}

	function saveDeckState() {
		const state: { A: SavedDeck | null; B: SavedDeck | null } = { A: null, B: null };
		if (deckA.hasTrack && deckA._savedFile) {
			state.A = { file: deckA._savedFile, displayName: deckA.name, currentTime: audioA?.currentTime ?? 0, volume: deckA.volume, loop: deckA.loop };
		}
		if (deckB.hasTrack && deckB._savedFile) {
			state.B = { file: deckB._savedFile, displayName: deckB.name, currentTime: audioB?.currentTime ?? 0, volume: deckB.volume, loop: deckB.loop };
		}
		setJSON(DECK_STATE_KEY, state);
	}

	/** Snapshot the current decks (file, position, volume, loop) into a {A,B} pair. */
	function captureDeckSnapshot(): { A: SavedDeck | null; B: SavedDeck | null } {
		const A = deckA.hasTrack && deckA._savedFile
			? { file: deckA._savedFile, displayName: deckA.name, currentTime: audioA?.currentTime ?? 0, volume: deckA.volume, loop: deckA.loop }
			: null;
		const B = deckB.hasTrack && deckB._savedFile
			? { file: deckB._savedFile, displayName: deckB.name, currentTime: audioB?.currentTime ?? 0, volume: deckB.volume, loop: deckB.loop }
			: null;
		return { A, B };
	}

	/** Resolve a saved deck file reference back to a playable StoredAudioFile.
	 *  Native and Drive refs carry enough to resolve directly. Web refs can't
	 *  serialise the File object, so we match against the currently-loaded library
	 *  by path/name (the library must be loaded for web sessions to restore). */
	function resolveSessionFile(ref: SavedDeck['file']): StoredAudioFile | null {
		if (ref.source === 'web') {
			const byPath = mixerShared.allFiles.find((f) => f.relativePath === ref.relativePath && f.name === ref.name);
			if (byPath) return byPath;
			const byName = mixerShared.allFiles.find((f) => f.name === ref.name);
			return byName ?? null;
		}
		return savedToStoredFile(ref);
	}

	/** Apply a deck snapshot (file, position, volume, loop) to both decks. Used both for
	 *  restoring on mount and for loading a saved session. Replaces the current decks. */
	async function loadDeckSnapshot(snapshot: { A: SavedDeck | null; B: SavedDeck | null }) {
		// Pause current playback before swapping decks
		audioA?.pause();
		audioB?.pause();
		if (!snapshot.A && deckA.hasTrack) clearDeck('A');
		if (!snapshot.B && deckB.hasTrack) clearDeck('B');
		if (snapshot.A) {
			const file = resolveSessionFile(snapshot.A.file);
			if (file) await loadIntoDeck('A', file, snapshot.A.displayName);
			else addToast({ message: `Deck A track “${snapshot.A.displayName}” is not in the loaded library.`, type: 'warning' });
			deckA.volume = snapshot.A.volume;
			deckA.loop = snapshot.A.loop;
			if (audioA) { audioA.volume = snapshot.A.volume; audioA.loop = snapshot.A.loop; audioA.currentTime = snapshot.A.currentTime; }
		}
		if (snapshot.B) {
			const file = resolveSessionFile(snapshot.B.file);
			if (file) await loadIntoDeck('B', file, snapshot.B.displayName);
			else addToast({ message: `Deck B track “${snapshot.B.displayName}” is not in the loaded library.`, type: 'warning' });
			deckB.volume = snapshot.B.volume;
			deckB.loop = snapshot.B.loop;
			if (audioB) { audioB.volume = snapshot.B.volume; audioB.loop = snapshot.B.loop; audioB.currentTime = snapshot.B.currentTime; }
		}
		saveDeckState();
	}

	async function restoreDeckState() {
		const parsed = getJSON<{ A: SavedDeck | null; B: SavedDeck | null }>(DECK_STATE_KEY, { A: null, B: null });
		if (!parsed.A && !parsed.B) return;
		await loadDeckSnapshot(parsed);
	}

	function savedToStoredFile(s: SavedDeck['file']): StoredAudioFile | null {
		if (s.source === 'native' && s.path) {
			return { source: 'native', name: s.name, relativePath: s.relativePath, path: s.path, mimeType: s.mimeType, modifiedAt: s.modifiedAt };
		}
		if (s.source === 'drive' && s.fileId) {
			return { source: 'drive', name: s.name, relativePath: s.relativePath, fileId: s.fileId, mimeType: s.mimeType, modifiedAt: s.modifiedAt, sizeBytes: s.sizeBytes, webViewLink: s.webViewLink };
		}
		return null;
	}

	// ── Mixer sessions — save / load full deck snapshots ─────────────
	const SESSIONS_KEY = 'mixer-sessions';
	/** localStorage key for the id of the session currently loaded into the decks,
	 *  so live deck changes (position/volume/loop) auto-persist back into it. */
	const ACTIVE_SESSION_KEY = 'mixer-active-session';

	interface MixerSession {
		id: string;
		name: string;
		createdAt: number;
		updatedAt: number;
		A: SavedDeck | null;
		B: SavedDeck | null;
	}

	let sessions = $state<MixerSession[]>([]);
	/** Id of the session whose decks are currently loaded. Null when the decks don't
	 *  correspond to any saved session (e.g. fresh load, or after clearing). */
	let activeSessionId = $state<string | null>(null);
	let newSessionName = $state('');

	function loadSessions() {
		sessions = getJSON<MixerSession[]>(SESSIONS_KEY, []);
		activeSessionId = getJSON<string | null>(ACTIVE_SESSION_KEY, null);
	}

	/** Persist the named-sessions list and the active-session id. Saved sessions
	 *  are immutable snapshots: live deck edits are NEVER written back into a
	 *  saved session (that was the bug where saving a new session silently
	 *  overwrote the previously-active one). Deck-resume-on-mount is handled
	 *  separately by saveDeckState()/DECK_STATE_KEY. */
	function persistSessions() {
		setJSON(SESSIONS_KEY, sessions);
	}

	function persistActiveSessionId() {
		setJSON(ACTIVE_SESSION_KEY, activeSessionId);
	}

	function saveCurrentSession() {
		const snapshot = captureDeckSnapshot();
		if (!snapshot.A && !snapshot.B) {
			addToast({ message: 'Load at least one track into the mixer before saving a session.', type: 'info' });
			return;
		}
		const name = newSessionName.trim() || `Session ${sessions.length + 1}`;
		const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
		const now = Date.now();
		sessions = [{ id, name, createdAt: now, updatedAt: now, ...snapshot }, ...sessions];
		persistSessions();
		// The freshly saved session becomes the active one.
		activeSessionId = id;
		persistActiveSessionId();
		newSessionName = '';
		addToast({ message: `Saved session “${name}”`, type: 'info' });
	}

	async function loadSession(session: MixerSession) {
		// Saved sessions are immutable snapshots — do NOT persist the outgoing
		// decks into the previously-active session. Just load the chosen snapshot.
		await loadDeckSnapshot({ A: session.A, B: session.B });
		activeSessionId = session.id;
		persistActiveSessionId();
		addToast({ message: `Loaded session “${session.name}”`, type: 'info' });
	}

	function deleteSession(session: MixerSession) {
		sessions = sessions.filter((s) => s.id !== session.id);
		persistSessions();
		if (activeSessionId === session.id) {
			activeSessionId = null;
			persistActiveSessionId();
		}
	}

	// ── Deck loading / playback ──────────────────────────────────
	interface TrackRef { source: 'native' | 'drive' | 'web'; name: string; relativePath: string; path?: string; fileId?: string; mimeType?: string; modifiedAt?: number; sizeBytes?: number; webViewLink?: string }

	async function loadIntoDeck(which: 'A' | 'B', file: StoredAudioFile, displayName: string) {
		const deck = which === 'A' ? deckA : deckB;
		const el = which === 'A' ? audioA : audioB;
		if (!el) return;
		deck.loading = true;
		try {
			const resolved = await resolveStoredFileToUrl(file);
			if (which === 'A') { revokeA?.(); revokeA = resolved.revoke; }
			else { revokeB?.(); revokeB = resolved.revoke; }
			el.src = resolved.url;
			el.volume = deck.volume;
			el.load();
			deck.name = displayName;
			deck.hasTrack = true;
			deck.playing = false;
			// Save a serializable file reference for persistence. Web File objects
			// cannot be serialised, so for web sources we store only name/relativePath
			// and re-resolve the actual file from the loaded library at load time.
			if (file.source === 'web') {
				deck._savedFile = { source: 'web', name: file.name, relativePath: file.relativePath };
			} else {
				deck._savedFile = { source: file.source as 'native' | 'drive', name: file.name, relativePath: file.relativePath, path: (file as any).path, fileId: (file as any).fileId, mimeType: (file as any).mimeType, modifiedAt: (file as any).modifiedAt, sizeBytes: (file as any).sizeBytes, webViewLink: (file as any).webViewLink };
			}
			saveDeckState();
		} catch (e) {
			addToast({ message: e instanceof Error ? e.message : 'Failed to load track.', type: 'error' });
		} finally {
			deck.loading = false;
		}
	}

	function toggleDeck(which: 'A' | 'B') {
		const el = which === 'A' ? audioA : audioB;
		const deck = which === 'A' ? deckA : deckB;
		if (!el || !deck.hasTrack) return;
		if (el.paused) el.play().catch(() => {});
		else { el.pause(); syncMixerPlayingFlag(); }
	}

	function toggleLoop(which: 'A' | 'B') {
		const el = which === 'A' ? audioA : audioB;
		const deck = which === 'A' ? deckA : deckB;
		if (!el) return;
		deck.loop = !deck.loop;
		el.loop = deck.loop;
		saveDeckState();
	}

	function stopDeck(which: 'A' | 'B') {
		const el = which === 'A' ? audioA : audioB;
		if (!el) return;
		el.pause();
		el.currentTime = 0;
		syncMixerPlayingFlag();
	}

	/** Unload a deck entirely, releasing its object URL. */
	function clearDeck(which: 'A' | 'B') {
		const el = which === 'A' ? audioA : audioB;
		const deck = which === 'A' ? deckA : deckB;
		if (el) { el.pause(); el.removeAttribute('src'); el.load(); }
		deck.hasTrack = false;
		deck.name = '';
		deck.playing = false;
		deck.loop = false;
		deck._savedFile = null;
		if (which === 'A') { revokeA?.(); revokeA = null; }
		else { revokeB?.(); revokeB = null; }
		syncMixerPlayingFlag();
	}

	function setVolume(which: 'A' | 'B', value: number) {
		const el = which === 'A' ? audioA : audioB;
		const deck = which === 'A' ? deckA : deckB;
		deck.volume = value;
		if (el) el.volume = value;
		saveDeckState();
	}

	function playBoth() {
		// Claim audio exclusivity so the main player (music/podcast/radio) pauses and
		// cannot overlap the mixer decks. This also lets other sources stop the decks
		// via claimAudio() when they start.
		claimAudio('mixer');
		if (deckA.hasTrack) audioA?.play().catch(() => {});
		if (deckB.hasTrack) audioB?.play().catch(() => {});
	}
	function pauseBoth() {
		audioA?.pause();
		audioB?.pause();
		syncMixerPlayingFlag();
	}

	/** Release the global playing flag when the mixer decks stop on user action.
	 *  With per-source playing flags, setting mixerPlaying=false is always safe —
	 *  it never touches another source's flag, so no cross-source guard is needed. */
	function syncMixerPlayingFlag() {
		if (!(deckA.playing || deckB.playing)) mediaEngine.mixerPlaying = false;
	}

	/** True when no main-media source (music/podcast/radio) is playing — i.e. the
	 *  mixer owns the MiniPlayer's progression slider. Deck A's time/duration is
	 *  mirrored into mediaEngine only while this holds, so loading/seeking deck A
	 *  never clobbers another source's progression during its playback. */
	function mixerOwnsProgression(): boolean {
		return !mediaEngine.musicPlaying && !mediaEngine.podcastPlaying && !mediaEngine.radioPlaying;
	}

	/** Mirror deck A's playback position + duration into mediaEngine so the
	 *  MiniPlayer's progression slider reflects deck A on the mixer tab. */
	function mirrorDeckA() {
		if (!audioA || !mixerOwnsProgression()) return;
		const dur = isFinite(audioA.duration) ? audioA.duration : 0;
		mediaEngine.updateTime(audioA.currentTime, dur);
	}

	const anyPlaying = $derived(deckA.playing || deckB.playing);

	// ── Register mixer decks in the audio-exclusivity system ─────────────────
	// When another source (music/podcast/radio) calls claimAudio(), the decks pause
	// so mixer and main media never overlap. We also persist the active session's
	// live state here — the decks are about to be paused/stopped, so capture the
	// latest position/volume/loop before that happens.
	$effect(() => {
		// Read audioA/audioB so the registered callback always closes over the
		// current elements (bind:this assigns them after mount).
		const a = audioA;
		const b = audioB;
		registerAudioSource('mixer', () => {
			a?.pause();
			b?.pause();
		});
	});

	// ── Sync mixer hooks to MiniPlayer via mixerShared ──────────
	// The mixer mirrors deck playback into mediaEngine.isPlaying so the Android
	// foreground media service stays alive while decks are playing. Because the
	// decks are now part of the exclusivity system, main media is always paused
	// while decks play, so releasing the flag on the play→stop transition is safe
	// and never clobbers an independently playing source.
	$effect(() => {
		mixerShared.anyDeckLoaded = deckA.hasTrack || deckB.hasTrack;
		mixerShared.anyPlaying = deckA.playing || deckB.playing;
		mixerShared.deckALabel = deckA.name;
		mixerShared.playBoth = () => {
			if (deckA.playing || deckB.playing) pauseBoth();
			else playBoth();
		};
	});

	// ── WakeLock: keep CPU / audio alive when screen is locked ────
	let _mixerWakeLock: WakeLockSentinel | null = null;

	async function acquireMixerWakeLock() {
		if (!('wakeLock' in navigator)) return;
		try {
			_mixerWakeLock = await navigator.wakeLock.request('screen');
			_mixerWakeLock.addEventListener('release', () => {
				// Re-acquire if we're still playing (OS may release it on visibility loss)
				if (anyPlaying && document.visibilityState === 'visible') {
					void acquireMixerWakeLock();
				}
			});
		} catch { /* denied by browser policy */ }
	}

	async function releaseMixerWakeLock() {
		if (_mixerWakeLock) {
			try { await _mixerWakeLock.release(); } catch { /* already released */ }
			_mixerWakeLock = null;
		}
	}

	$effect(() => {
		if (anyPlaying) {
			void acquireMixerWakeLock();
		} else {
			void releaseMixerWakeLock();
		}
	});

	// Re-acquire wake lock when the page becomes visible again while mixer is playing
	$effect(() => {
		if (typeof document !== 'undefined') {
			const onVisible = () => {
				if (anyPlaying && !_mixerWakeLock) void acquireMixerWakeLock();
			};
			document.addEventListener('visibilitychange', onVisible);
			return () => document.removeEventListener('visibilitychange', onVisible);
		}
	});

	onMount(() => {
		loadSessions();
		restoreDeckState();
		return () => {
			audioA?.pause();
			audioB?.pause();
			revokeA?.();
			revokeB?.();
		};
	});
</script>

<div class="flex flex-col h-full w-full min-w-0 overflow-hidden">
	<!-- Decks -->
	<div class="grid grid-cols-2 gap-2 px-3 py-3 shrink-0">
		{#each [{ id: 'A' as const, deck: deckA }, { id: 'B' as const, deck: deckB }] as { id, deck }}
			<div class="rounded-2xl border bg-card p-3 space-y-3 min-w-0">
				<div class="flex items-center justify-between gap-2">
					<span class="text-xs font-bold uppercase tracking-wider text-primary">Deck {id}</span>
					{#if deck.loading}
						<div class="w-3.5 h-3.5 border-2 border-primary border-t-transparent rounded-full animate-spin"></div>
					{/if}
				</div>
				<p class="text-sm font-medium truncate min-h-[1.25rem]" title={deck.name}>
					{deck.hasTrack ? deck.name : 'No track loaded'}
				</p>
				<div class="flex items-center gap-2">
					<button
						class="w-11 h-11 flex items-center justify-center rounded-full bg-primary/10 text-primary disabled:opacity-40 transition-colors hover:bg-primary/20"
						onclick={() => toggleDeck(id)}
						disabled={!deck.hasTrack}
						aria-label={deck.playing ? `Pause deck ${id}` : `Play deck ${id}`}
					>
						{#if deck.playing}<Pause class="w-5 h-5" />{:else}<Play class="w-5 h-5 ml-0.5" />{/if}
					</button>
					<button
						class="w-11 h-11 flex items-center justify-center rounded-full transition-colors disabled:opacity-40 {deck.loop ? 'bg-primary/15 text-primary' : 'text-muted-foreground hover:text-foreground hover:bg-accent'}"
						onclick={() => toggleLoop(id)}
						disabled={!deck.hasTrack}
						aria-label={`Loop deck ${id}`}
						aria-pressed={deck.loop}
						title={deck.loop ? 'Loop on' : 'Loop off'}
					>
						<Repeat class="w-4.5 h-4.5" />
					</button>
					<button
						class="w-11 h-11 flex items-center justify-center rounded-full text-muted-foreground hover:text-foreground hover:bg-accent disabled:opacity-40 transition-colors"
						onclick={() => stopDeck(id)}
						disabled={!deck.hasTrack}
						aria-label={`Stop deck ${id}`}
					>
						<Square class="w-4 h-4" />
					</button>
				</div>
				<div class="flex items-center gap-2">
					<Volume2 class="w-4 h-4 text-muted-foreground shrink-0" />
					<input
						type="range" min="0" max="1" step="0.01"
						value={deck.volume}
						oninput={(e) => setVolume(id, Number((e.currentTarget as HTMLInputElement).value))}
						class="flex-1 min-w-0 accent-primary"
						aria-label={`Deck ${id} volume`}
					/>
					<span class="text-xs tabular-nums text-muted-foreground w-8 text-right">{Math.round(deck.volume * 100)}</span>
				</div>
			</div>
		{/each}
	</div>

	<!-- Picker toggle -->
	<div class="flex gap-2 px-3 pb-2 shrink-0">
		<button
			class="flex-1 py-2 rounded-lg text-sm border transition-colors inline-flex items-center justify-center gap-1.5 {mode === 'library' ? 'border-primary bg-primary/10 text-primary font-medium' : 'border-border hover:bg-accent'}"
			onclick={() => (mode = 'library')}
		>
			<ListMusic class="w-4 h-4" /> Library
		</button>
		<button
			class="flex-1 py-2 rounded-lg text-sm border transition-colors inline-flex items-center justify-center gap-1.5 {mode === 'favorites' ? 'border-primary bg-primary/10 text-primary font-medium' : 'border-border hover:bg-accent'}"
			onclick={() => (mode = 'favorites')}
		>
			<Star class="w-4 h-4" /> Favorites
		</button>
		<button
			class="flex-1 py-2 rounded-lg text-sm border transition-colors inline-flex items-center justify-center gap-1.5 {mode === 'sessions' ? 'border-primary bg-primary/10 text-primary font-medium' : 'border-border hover:bg-accent'}"
			onclick={() => (mode = 'sessions')}
		>
			<Save class="w-4 h-4" /> Sessions
		</button>
	</div>

	<!-- Picker list -->
	<div class="flex-1 overflow-y-auto min-h-0 px-3 pb-4">
		{#if mode === 'library'}
			<!-- Breadcrumb -->
			<div class="flex items-center gap-1 flex-wrap text-xs text-muted-foreground py-2">
				<button class="hover:text-foreground" onclick={() => goToCrumb(0)}>Music</button>
				{#each browsePath as crumb, i}
					<ChevronRight class="w-3 h-3" />
					<button class="hover:text-foreground truncate max-w-[40vw]" onclick={() => goToCrumb(i + 1)}>{crumb}</button>
				{/each}
			</div>

			{#if browseLoading}
				<div class="flex items-center gap-2 text-sm text-muted-foreground py-6 justify-center">
					<div class="w-4 h-4 border-2 border-primary border-t-transparent rounded-full animate-spin"></div>
					Loading…
				</div>
			{:else}
				{#if browsePath.length > 0}
					<button class="w-full flex items-center gap-3 py-2.5 px-2 rounded-lg hover:bg-accent text-left" onclick={goUp}>
						<ArrowLeft class="w-4 h-4 text-muted-foreground" /> <span class="text-sm">Up one level</span>
					</button>
				{/if}
				{#each folders as folder}
					<button class="w-full flex items-center gap-3 py-2.5 px-2 rounded-lg hover:bg-accent text-left" onclick={() => openFolder(folder.name)}>
						<Folder class="w-4.5 h-4.5 text-primary shrink-0" />
						<span class="text-sm truncate flex-1 min-w-0">{folder.name}</span>
						<span class="text-xs text-muted-foreground shrink-0">{folder.count} file{folder.count !== 1 ? 's' : ''}</span>
					</button>
				{/each}
				{#each files as entry}
					<div class="flex items-center gap-2 py-2 px-2 rounded-lg">
						<div class="flex-1 min-w-0">
							<p class="text-sm truncate">{prettyTitle(entry.name)}</p>
						</div>
						<button class="w-8 h-8 rounded-full border border-primary/40 text-primary text-xs font-bold hover:bg-primary/10 shrink-0" onclick={() => loadIntoDeck('A', entry.file, prettyTitle(entry.name))} aria-label="Load into deck A">A</button>
						<button class="w-8 h-8 rounded-full border border-primary/40 text-primary text-xs font-bold hover:bg-primary/10 shrink-0" onclick={() => loadIntoDeck('B', entry.file, prettyTitle(entry.name))} aria-label="Load into deck B">B</button>
					</div>
				{/each}

				<!-- Flat root-level file list: shown when no folders/files computed, fallback to allFiles -->
				{#if folders.length === 0 && files.length === 0}
					{#if rootFiles.length > 0}
						{#each rootFiles as file}
							<div class="flex items-center gap-2 py-2 px-2 rounded-lg">
								<div class="flex-1 min-w-0">
									<p class="text-sm truncate">{prettyTitle(file.name)}</p>
								</div>
								<button class="w-8 h-8 rounded-full border border-primary/40 text-primary text-xs font-bold hover:bg-primary/10 shrink-0" onclick={() => loadIntoDeck('A', file, prettyTitle(file.name))} aria-label="Load into deck A">A</button>
								<button class="w-8 h-8 rounded-full border border-primary/40 text-primary text-xs font-bold hover:bg-primary/10 shrink-0" onclick={() => loadIntoDeck('B', file, prettyTitle(file.name))} aria-label="Load into deck B">B</button>
							</div>
						{/each}
					{:else}
						<p class="text-sm text-muted-foreground text-center py-8">No MP3 files in library. Add files in the Music tab first.</p>
					{/if}
				{/if}
			{/if}
		{:else if mode === 'favorites'}
			{#if resolvableFavorites.length === 0}
				<p class="text-sm text-muted-foreground text-center py-8">No favorite tracks yet. Star tracks in the Music tab to mix them quickly.</p>
			{:else}
				{#each resolvableFavorites as fav (fav.key)}
					{@const stored = favoriteToStoredFile(fav)}
					<div class="flex items-center gap-2 py-2 px-2 rounded-lg">
						<Star class="w-4 h-4 text-yellow-400 shrink-0" fill="currentColor" />
						<div class="flex-1 min-w-0">
							<p class="text-sm truncate">{fav.title || prettyTitle(fav.name)}</p>
							{#if fav.artist}<p class="text-xs text-muted-foreground truncate">{fav.artist}</p>{/if}
						</div>
						<button class="w-8 h-8 rounded-full border border-primary/40 text-primary text-xs font-bold hover:bg-primary/10 shrink-0 disabled:opacity-40" disabled={!stored} onclick={() => stored && loadIntoDeck('A', stored, fav.title || prettyTitle(fav.name))} aria-label="Load into deck A">A</button>
						<button class="w-8 h-8 rounded-full border border-primary/40 text-primary text-xs font-bold hover:bg-primary/10 shrink-0 disabled:opacity-40" disabled={!stored} onclick={() => stored && loadIntoDeck('B', stored, fav.title || prettyTitle(fav.name))} aria-label="Load into deck B">B</button>
					</div>
				{/each}
			{/if}
		{:else}
			<!-- Sessions: save / load full mixer deck snapshots -->
			<div class="flex items-center gap-2 py-2">
				<input
					type="text"
					bind:value={newSessionName}
					placeholder="Session name (optional)"
					class="flex-1 min-w-0 px-3 py-2 rounded-lg border border-border bg-background text-sm focus:outline-none focus:border-primary"
					onkeydown={(e) => e.key === 'Enter' && saveCurrentSession()}
					aria-label="Session name"
				/>
				<button
					class="shrink-0 inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors"
					onclick={saveCurrentSession}
					aria-label="Save current mixer session"
				>
					<Save class="w-4 h-4" /> Save
				</button>
			</div>

			{#if sessions.length === 0}
				<p class="text-sm text-muted-foreground text-center py-8">No saved sessions yet. Load tracks into the decks above, then save them to switch between mixes.</p>
			{:else}
				{#each sessions as session (session.id)}
					<div class="rounded-lg border bg-card p-3 mb-2 space-y-2 {activeSessionId === session.id ? 'border-primary' : ''}">
						<div class="flex items-center justify-between gap-2">
							<p class="text-sm font-semibold truncate flex-1 min-w-0">
								{session.name}
								{#if activeSessionId === session.id}<span class="text-xs text-primary font-normal ml-1">· active</span>{/if}
							</p>
							<div class="flex items-center gap-1 shrink-0">
								<button
									class="w-8 h-8 inline-flex items-center justify-center rounded-full text-primary hover:bg-primary/10 transition-colors"
									onclick={() => loadSession(session)}
									aria-label={`Load session ${session.name}`}
									title="Load session"
								>
									<Download class="w-4 h-4" />
								</button>
								<button
									class="w-8 h-8 inline-flex items-center justify-center rounded-full text-muted-foreground hover:text-destructive hover:bg-accent transition-colors"
									onclick={() => deleteSession(session)}
									aria-label={`Delete session ${session.name}`}
									title="Delete session"
								>
									<Trash2 class="w-4 h-4" />
								</button>
							</div>
						</div>
						<div class="space-y-1 text-xs text-muted-foreground">
							{#if session.A}
								<div class="flex items-center gap-2">
									<span class="font-bold text-primary w-4">A</span>
									<span class="truncate flex-1 min-w-0">{session.A.displayName}</span>
									<span class="tabular-nums shrink-0">{formatTime(session.A.currentTime)}</span>
									<span class="shrink-0">vol {Math.round(session.A.volume * 100)}</span>
									{#if session.A.loop}<Repeat class="w-3 h-3 text-primary shrink-0" />{/if}
								</div>
							{:else}
								<div class="flex items-center gap-2"><span class="font-bold text-muted-foreground w-4">A</span><span>empty</span></div>
							{/if}
							{#if session.B}
								<div class="flex items-center gap-2">
									<span class="font-bold text-primary w-4">B</span>
									<span class="truncate flex-1 min-w-0">{session.B.displayName}</span>
									<span class="tabular-nums shrink-0">{formatTime(session.B.currentTime)}</span>
									<span class="shrink-0">vol {Math.round(session.B.volume * 100)}</span>
									{#if session.B.loop}<Repeat class="w-3 h-3 text-primary shrink-0" />{/if}
								</div>
							{:else}
								<div class="flex items-center gap-2"><span class="font-bold text-muted-foreground w-4">B</span><span>empty</span></div>
							{/if}
						</div>
						<div class="flex items-center gap-1 text-[11px] text-muted-foreground">
							<Clock class="w-3 h-3" />
							<span>{new Date(session.updatedAt).toLocaleString()}</span>
						</div>
					</div>
				{/each}
			{/if}
		{/if}
	</div>

	<!-- Hidden audio elements -->
	<audio bind:this={audioA} ontimeupdate={mirrorDeckA} onloadedmetadata={mirrorDeckA} onplay={() => { deckA.playing = true; mediaEngine.mixerPlaying = true; }} onpause={() => { deckA.playing = false; syncMixerPlayingFlag(); }} onended={() => { deckA.playing = false; syncMixerPlayingFlag(); }} preload="none"></audio>
	<audio bind:this={audioB} onplay={() => { deckB.playing = true; mediaEngine.mixerPlaying = true; }} onpause={() => { deckB.playing = false; syncMixerPlayingFlag(); }} onended={() => { deckB.playing = false; syncMixerPlayingFlag(); }} preload="none"></audio>
</div>
