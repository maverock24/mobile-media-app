<script lang="ts">
	import { onMount } from 'svelte';
	import { ArrowLeft, Folder, Play, Pause, Square, Volume2, ListMusic, Star, ChevronRight } from 'lucide-svelte';
	import { type BrowseEntry, type StoredAudioFile } from '$lib/stores/library.svelte';
	import { mixerShared } from '$lib/stores/mixerShared.svelte';
	import { musicSettings } from '$lib/stores/settings.svelte';
	import { resolveStoredFileToUrl } from '$lib/audio/fileResolver';
	import { mediaEngine } from '$lib/stores/mediaEngine.svelte';
	import { addToast } from '$lib/stores/toastStore.svelte';

	interface Props {
		onBack: () => void;
	}
	let { onBack }: Props = $props();

	// ── Audio elements (one per deck) ────────────────────────────
	let audioA: HTMLAudioElement | null = $state(null);
	let audioB: HTMLAudioElement | null = $state(null);

	interface DeckState {
		name: string;
		hasTrack: boolean;
		loading: boolean;
		playing: boolean;
		volume: number; // 0..1
	}
	let deckA = $state<DeckState>({ name: '', hasTrack: false, loading: false, playing: false, volume: 0.85 });
	let deckB = $state<DeckState>({ name: '', hasTrack: false, loading: false, playing: false, volume: 0.85 });
	let revokeA: (() => void) | null = null;
	let revokeB: (() => void) | null = null;

	// ── Library browser (synced from Music tab via mixerShared) ──
	type PickerMode = 'library' | 'favorites';
	let mode = $state<PickerMode>('library');

	const path = $derived(mixerShared.browsePath);
	const browseLoading = $derived(mixerShared.browseLoading);
	const entries = $derived(mixerShared.browseEntries);
	// Also surface ALL files at the root level (even before the user navigates into a subfolder).
	const allFiles = $derived(mixerShared.allFiles);

	const folders = $derived(entries.filter((e): e is Extract<BrowseEntry, { kind: 'folder' }> => e.kind === 'folder'));
	const files = $derived(entries.filter((e): e is Extract<BrowseEntry, { kind: 'file' }> => e.kind === 'file'));
	/** Flat list of MP3 files — same as the Music tab's file list, for the root-level picker. */
	const rootFiles = $derived(allFiles);

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

	// ── Deck loading / playback ──────────────────────────────────
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
	}

	function playBoth() {
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
		return () => {
			audioA?.pause();
			audioB?.pause();
			revokeA?.();
			revokeB?.();
		};
	});
</script>

<div class="flex flex-col h-full w-full min-w-0 overflow-hidden">
	<!-- Header -->
	<div class="flex items-center gap-2 px-3 py-3 border-b shrink-0">
		<button
			class="w-10 h-10 flex items-center justify-center rounded-full hover:bg-accent transition-colors shrink-0"
			onclick={onBack}
			aria-label="Back to music"
		>
			<ArrowLeft class="w-5 h-5" />
		</button>
		<div class="min-w-0 flex-1">
			<h1 class="text-base font-semibold leading-tight">Mixer</h1>
			<p class="text-xs text-muted-foreground leading-tight">Play two tracks at once with independent volume</p>
		</div>
		<button
			class="px-3 h-10 inline-flex items-center gap-1.5 rounded-full text-sm font-medium border transition-colors {anyPlaying ? 'border-primary bg-primary/10 text-primary' : 'border-border hover:bg-accent'}"
			onclick={() => (anyPlaying ? pauseBoth() : playBoth())}
			disabled={!deckA.hasTrack && !deckB.hasTrack}
		>
			{#if anyPlaying}
				<Pause class="w-4 h-4" /> Pause both
			{:else}
				<Play class="w-4 h-4" /> Play both
			{/if}
		</button>
	</div>

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
			<!-- Breadcrumb (read-only — navigation happens in the Music tab) -->
			<div class="flex items-center gap-1 flex-wrap text-xs text-muted-foreground py-2">
				<span>Music</span>
				{#each path as crumb, i}
					<ChevronRight class="w-3 h-3" />
					<span class="truncate max-w-[40vw]">{crumb}</span>
				{/each}
			</div>

			{#if browseLoading}
				<div class="flex items-center gap-2 text-sm text-muted-foreground py-6 justify-center">
					<div class="w-4 h-4 border-2 border-primary border-t-transparent rounded-full animate-spin"></div>
					Loading…
				</div>
			{:else}

				{#each folders as folder}
					<div class="flex items-center gap-3 py-2.5 px-2 rounded-lg text-muted-foreground text-left">
						<Folder class="w-4.5 h-4.5 text-primary shrink-0" />
						<span class="text-sm truncate flex-1 min-w-0">{folder.name}</span>
						<span class="text-xs text-muted-foreground shrink-0">folder</span>
					</div>
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
				{#if folders.length === 0 && files.length === 0}
					<p class="text-sm text-muted-foreground text-center py-8">Navigate into a folder in the Music tab to browse files here.</p>
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
