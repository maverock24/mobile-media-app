<script lang="ts">
	import { onMount } from 'svelte';
	import { ArrowLeft, Folder, Play, Pause, Square, Volume2, ListMusic, Star, ChevronRight, Repeat } from 'lucide-svelte';
	import { type BrowseEntry, type StoredAudioFile } from '$lib/stores/library.svelte';
	import { getRelativePath, buildBrowseEntries } from '$lib/models/browse';
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
	type PickerMode = 'library' | 'favorites';
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
		file: { source: 'native' | 'drive'; name: string; relativePath: string; path?: string; fileId?: string; mimeType?: string; modifiedAt?: number; sizeBytes?: number; webViewLink?: string };
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

	async function restoreDeckState() {
		const parsed = getJSON<{ A: SavedDeck | null; B: SavedDeck | null }>(DECK_STATE_KEY, { A: null, B: null });
		if (!parsed.A && !parsed.B) return;
		if (parsed.A) {
			const file = savedToStoredFile(parsed.A.file);
			if (file) await loadIntoDeck('A', file, parsed.A.displayName);
			deckA.volume = parsed.A.volume;
			deckA.loop = parsed.A.loop;
			if (audioA) { audioA.volume = parsed.A.volume; audioA.loop = parsed.A.loop; audioA.currentTime = parsed.A.currentTime; }
		}
		if (parsed.B) {
			const file = savedToStoredFile(parsed.B.file);
			if (file) await loadIntoDeck('B', file, parsed.B.displayName);
			deckB.volume = parsed.B.volume;
			deckB.loop = parsed.B.loop;
			if (audioB) { audioB.volume = parsed.B.volume; audioB.loop = parsed.B.loop; audioB.currentTime = parsed.B.currentTime; }
		}
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

	// ── Deck loading / playback ──────────────────────────────────
	interface TrackRef { source: 'native' | 'drive'; name: string; relativePath: string; path?: string; fileId?: string; mimeType?: string; modifiedAt?: number; sizeBytes?: number; webViewLink?: string }

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
			// Save serializable file reference for persistence.
			if (file.source !== 'web') {
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
		else el.pause();
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
	}

	const anyPlaying = $derived(deckA.playing || deckB.playing);

	// ── Register mixer decks in the audio-exclusivity system ─────────────────
	// When another source (music/podcast/radio) calls claimAudio(), the decks pause
	// so mixer and main media never overlap. This replaces the old _mediaWasPlaying
	// heuristic and makes the global playing-flag ownership unambiguous.
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
	let _decksWerePlaying = false;
	$effect(() => {
		mixerShared.anyDeckLoaded = deckA.hasTrack || deckB.hasTrack;
		mixerShared.anyPlaying = deckA.playing || deckB.playing;
		mixerShared.playBoth = () => {
			if (deckA.playing || deckB.playing) pauseBoth();
			else playBoth();
		};

		const decksPlaying = deckA.playing || deckB.playing;
		if (decksPlaying) {
			mediaEngine.setPlaying(true);
		} else if (_decksWerePlaying) {
			// Decks just stopped and main media was paused by exclusivity — release
			// the global playing flag so the UI reflects the stopped state.
			mediaEngine.setPlaying(false);
		}
		_decksWerePlaying = decksPlaying;
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
		{:else}
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
		{/if}
	</div>

	<!-- Hidden audio elements -->
	<audio bind:this={audioA} onplay={() => (deckA.playing = true)} onpause={() => (deckA.playing = false)} onended={() => (deckA.playing = false)} preload="none"></audio>
	<audio bind:this={audioB} onplay={() => (deckB.playing = true)} onpause={() => (deckB.playing = false)} onended={() => (deckB.playing = false)} preload="none"></audio>
</div>
