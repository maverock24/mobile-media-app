<script lang="ts">
	import { onMount } from 'svelte';
	import { ArrowLeft, Folder, Play, Pause, Square, Volume2, ListMusic, Star, ChevronRight, Repeat } from 'lucide-svelte';
	import { type BrowseEntry, type StoredAudioFile } from '$lib/stores/library.svelte';
	import { mixerShared } from '$lib/stores/mixerShared.svelte';
	import { musicSettings } from '$lib/stores/settings.svelte';
	import { resolveStoredFileToUrl } from '$lib/audio/fileResolver';
	import { mediaEngine } from '$lib/stores/mediaEngine.svelte';
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

	function getRelativePath(file: StoredAudioFile): string {
		return file.relativePath && file.relativePath.length > 0 ? file.relativePath : file.name;
	}

	function buildBrowseEntries(files: StoredAudioFile[], path: string[]): BrowseEntry[] {
		const prefix = path.length > 0 ? path.join('/') + '/' : '';
		const folderCounts = new Map<string, number>();
		const directFiles: BrowseEntry[] = [];
		for (const file of files) {
			const normalized = getRelativePath(file);
			if (!normalized.startsWith(prefix)) continue;
			const remaining = normalized.slice(prefix.length);
			if (!remaining) continue;
			const slash = remaining.indexOf('/');
			if (slash === -1) {
				directFiles.push({ kind: 'file', name: remaining, file });
				continue;
			}
			const folderName = remaining.slice(0, slash);
			folderCounts.set(folderName, (folderCounts.get(folderName) ?? 0) + 1);
		}
		const folders: BrowseEntry[] = Array.from(folderCounts.entries(), ([name, count]) => ({
			kind: 'folder', name, count,
		}));
		folders.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
		directFiles.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
		return [...folders, ...directFiles];
	}

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
		if (typeof localStorage === 'undefined') return;
		const state: { A: SavedDeck | null; B: SavedDeck | null } = { A: null, B: null };
		if (deckA.hasTrack && deckA._savedFile) {
			state.A = { file: deckA._savedFile, displayName: deckA.name, currentTime: audioA?.currentTime ?? 0, volume: deckA.volume, loop: deckA.loop };
		}
		if (deckB.hasTrack && deckB._savedFile) {
			state.B = { file: deckB._savedFile, displayName: deckB.name, currentTime: audioB?.currentTime ?? 0, volume: deckB.volume, loop: deckB.loop };
		}
		try { localStorage.setItem(DECK_STATE_KEY, JSON.stringify(state)); } catch { /* quota */ }
	}

	async function restoreDeckState() {
		if (typeof localStorage === 'undefined') return;
		const raw = localStorage.getItem(DECK_STATE_KEY);
		if (!raw) return;
		let parsed: { A: SavedDeck | null; B: SavedDeck | null };
		try { parsed = JSON.parse(raw); } catch { return; }
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
		// Stop the main player so mixer and main media don't overlap.
		mediaEngine.pause();
		if (deckA.hasTrack) audioA?.play().catch(() => {});
		if (deckB.hasTrack) audioB?.play().catch(() => {});
	}
	function pauseBoth() {
		audioA?.pause();
		audioB?.pause();
	}

	// ── Pause mixer decks when the main player (music/podcast/radio) starts ──
	let _mediaWasPlaying = false;
	$effect(() => {
		if (mediaEngine.isPlaying && !_mediaWasPlaying && (deckA.playing || deckB.playing)) {
			audioA?.pause();
			audioB?.pause();
		}
		_mediaWasPlaying = mediaEngine.isPlaying;
	});

	const anyPlaying = $derived(deckA.playing || deckB.playing);

	// ── Sync mixer hooks to MiniPlayer via mixerShared ──────────
	$effect(() => {
		mixerShared.anyDeckLoaded = deckA.hasTrack || deckB.hasTrack;
		mixerShared.anyPlaying = deckA.playing || deckB.playing;
		mixerShared.playBoth = () => {
			if (deckA.playing || deckB.playing) pauseBoth();
			else playBoth();
		};

		// Keep Android foreground service alive while mixer is playing.
		// Without it the OS will kill the WebView, losing loaded tracks.
		if (deckA.playing || deckB.playing) {
			mediaEngine.setPlaying(true);
		}
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
