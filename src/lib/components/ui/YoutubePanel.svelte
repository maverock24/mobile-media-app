<script lang="ts">
	/**
	 * YouTube audio search, favorites and playback.
	 *
	 * Self-contained like PodcastView: this component owns its `<audio>` element
	 * and reports state to the media engine rather than borrowing a music deck.
	 * It is rendered once, from `+page.svelte`, so a single audio element serves
	 * the whole app and playback survives closing the panel or switching tabs.
	 *
	 * The `<audio>` element is deliberately OUTSIDE the `{#if youtubePanel.open}`
	 * block — unmounting it would stop playback when the panel is closed.
	 *
	 * Loop behaviour reuses the music player's toggles:
	 *  - shuffle  -> musicSettings.isShuffle
	 *  - repeat-one -> musicSettings.isRepeat (handled in onEnded, as in Mp3PlayerView)
	 *  - queue wrap -> musicSettings.youtubeQueueLoop
	 *
	 * EQ is not applied, and cannot be: Web Audio refuses to process cross-origin
	 * media without CORS headers, and googlevideo sends none. Same reason radio
	 * bypasses the EQ.
	 */
	import { onDestroy, untrack } from 'svelte';
	import { Capacitor } from '@capacitor/core';
	import Button from '$lib/components/ui/Button.svelte';
	import Input from '$lib/components/ui/Input.svelte';
	import { formatClock, getYoutubeFavoriteKey, isYoutubeFavorite } from '$lib/models/music';
	import { claimAudio, mediaEngine, registerAudioSource } from '$lib/stores/mediaEngine.svelte';
	import { musicSettings } from '$lib/stores/settings.svelte';
	import { addToast } from '$lib/stores/toastStore.svelte';
	import { closeYoutubePanel, youtubePanel } from '$lib/stores/youtubePanel.svelte';
	import {
		describeYoutubeError,
		resolveYoutubeAudio,
		searchYoutube,
		toMediaItem,
		youtubeVideoIdFromInput,
		type YoutubeAudioSource,
	} from '$lib/youtube/client';
	import {
		favoriteFromQueueItem,
		indexOfVideo,
		nextQueueIndex,
		previousQueueIndex,
		queueItemFromFavorite,
		queueItemFromSearchResult,
		type YoutubeQueueItem,
	} from '$lib/youtube/queue';
	import { ChevronLeft, Loader2, Pause, Play, Repeat, Search, Shuffle, Star, Youtube } from 'lucide-svelte';

	const isNativeApp = Capacitor.isNativePlatform();

	// ── Browser / list state ─────────────────────────────────────
	let mode        = $state<'search' | 'favorites'>('search');
	let query       = $state('');
	let searchResults = $state<YoutubeQueueItem[]>([]);
	let isSearching = $state(false);
	let error       = $state('');

	// ── Queue ────────────────────────────────────────────────────
	/** Items next/prev step through. Set when playback starts from a list. */
	let queue      = $state<YoutubeQueueItem[]>([]);
	let queueIndex = $state(-1);

	// ── Playback state ───────────────────────────────────────────
	let audioEl: HTMLAudioElement | undefined = $state();
	let current: YoutubeAudioSource | null = $state(null);
	let currentItem: YoutubeQueueItem | null = $state(null);
	let isPlaying   = $state(false);
	let isBuffering = $state(false);
	let currentTime = $state(0);
	let duration    = $state(0);
	let resolvingId: string | null = $state(null);

	// ── Derived ──────────────────────────────────────────────────
	const youtubeFavorites = $derived(
		(Array.isArray(musicSettings.favoriteTracks) ? musicSettings.favoriteTracks : [])
			.filter(isYoutubeFavorite)
			.map(queueItemFromFavorite)
	);

	const isCurrentFavorite = $derived.by(() => {
		const videoId = currentItem?.videoId;
		if (!videoId) return false;
		return youtubeFavorites.some((item) => item.videoId === videoId);
	});

	const visibleList = $derived(mode === 'search' ? searchResults : youtubeFavorites);
	const progressPercent = $derived(duration > 0 ? (currentTime / duration) * 100 : 0);

	// ── Engine wiring ────────────────────────────────────────────
	function stopYoutubePlayback() {
		isPlaying = false;
		isBuffering = false;
		mediaEngine.youtubePlaying = false;
		if (!audioEl) return;
		audioEl.pause();
		// Release the audio channel — pause() alone can leave decoder state that
		// overlaps the incoming source (same reason PodcastView does this).
		audioEl.removeAttribute('src');
		audioEl.load();
	}

	$effect(() => {
		registerAudioSource('youtube', stopYoutubePlayback);
	});

	onDestroy(() => {
		stopYoutubePlayback();
	});

	/** Retry play() on AbortError — the Android WebView aborts when a remote src
	 *  is set and played too quickly. Mirrors PodcastView's safePlay. */
	function safePlay(onFailure?: () => void) {
		const maxRetries = isNativeApp ? 6 : 3;
		const retryDelayMs = isNativeApp ? 250 : 150;
		const tryPlay = (attempt: number) => {
			audioEl!.play().catch((err: Error) => {
				if (err?.name === 'AbortError' && attempt < maxRetries) {
					setTimeout(() => tryPlay(attempt + 1), retryDelayMs);
				} else {
					isPlaying = false;
					mediaEngine.youtubePlaying = false;
					onFailure?.();
				}
			});
		};
		tryPlay(0);
	}

	function claimEngineControls() {
		mediaEngine.setPlaybackHandlers(
			() => { startOrResumePlayback(); },
			() => { isPlaying = false; mediaEngine.youtubePlaying = false; audioEl?.pause(); },
			(time) => { if (audioEl) audioEl.currentTime = time; }
		);
		// Next/prev drive the queue, so the MiniPlayer, MediaSession and the
		// Android notification controls all work while YouTube owns audio.
		mediaEngine.setSkipHandlers(goNext, goPrev);
	}

	// ── Playback ─────────────────────────────────────────────────
	/** Start audio for an already-resolved source and make it the queue position. */
	function startPlayback(source: YoutubeAudioSource, item: YoutubeQueueItem, index: number) {
		current = source;
		currentItem = item;
		queueIndex = index;
		duration = source.durationSeconds || item.durationSeconds;
		currentTime = 0;

		// Set the flag before claimAudio so isPlaying never transiently drops
		// (the Android focus abandon/request race).
		mediaEngine.youtubePlaying = true;
		isPlaying = true;
		claimAudio('youtube');
		mediaEngine.setNowPlaying(toMediaItem(source), 'youtube');
		claimEngineControls();

		if (audioEl) {
			audioEl.src = source.audioUrl;
			audioEl.load();
			safePlay(() => addToast({ message: 'Could not start playback.', type: 'error' }));
		}
	}

	async function playQueueItem(item: YoutubeQueueItem, index: number): Promise<boolean> {
		error = '';
		resolvingId = item.videoId;
		try {
			startPlayback(await resolveYoutubeAudio(item.videoId), item, index);
			return true;
		} catch (err) {
			error = describeYoutubeError(err);
			// Deliberately leave the engine flags alone: a failed resolve changes
			// nothing, so whatever was playing is still playing. advanceQueue()
			// clears them if the queue cannot continue.
			return false;
		} finally {
			resolvingId = null;
		}
	}

	/** Play a list starting at `index`, making that list the active queue. */
	function playFromList(items: YoutubeQueueItem[], index: number) {
		queue = items;
		void playQueueItem(items[index], index);
	}

	/** Play a video id that may or may not be in a list we already hold. */
	async function playRequestedVideo(videoId: string) {
		const favoriteIndex = indexOfVideo(youtubeFavorites, videoId);
		if (favoriteIndex >= 0) {
			mode = 'favorites';
			playFromList(youtubeFavorites, favoriteIndex);
			return;
		}

		const searchIndex = indexOfVideo(searchResults, videoId);
		if (searchIndex >= 0) {
			mode = 'search';
			playFromList(searchResults, searchIndex);
			return;
		}

		// Not in either list — resolve it, then play as a one-item queue.
		error = '';
		resolvingId = videoId;
		try {
			const source = await resolveYoutubeAudio(videoId);
			const item = queueItemFromSearchResult({
				videoId,
				title: source.title,
				author: source.author,
				durationSeconds: source.durationSeconds,
				thumbnailUrl: source.thumbnailUrl,
			});
			queue = [item];
			startPlayback(source, item, 0);
		} catch (err) {
			error = describeYoutubeError(err);
		} finally {
			resolvingId = null;
		}
	}

	/** Stop playback and clear the engine flags without losing the now-playing metadata. */
	function stopQueue() {
		isPlaying = false;
		isBuffering = false;
		mediaEngine.youtubePlaying = false;
		// Pause the element too, so engine state and reality agree. Auto-advance
		// reaches here with the track already ended, but a manual skip that
		// exhausts every attempt leaves the previous track still playing.
		audioEl?.pause();
	}

	/**
	 * Move through the queue, skipping entries that cannot be resolved instead of
	 * stopping on the first one. Some search results are livestreams or region
	 * blocked, and dying on those would strand the listener mid-queue.
	 *
	 * `manual` marks a skip, which always wraps.
	 */
	async function advanceQueue(manual: boolean, maxSkips = 3): Promise<void> {
		let fromIndex = queueIndex;

		for (let skipped = 0; skipped <= maxSkips; skipped++) {
			const next = nextQueueIndex({
				currentIndex: fromIndex,
				trackCount: queue.length,
				isShuffle: musicSettings.isShuffle,
				queueLoop: manual ? true : musicSettings.youtubeQueueLoop,
			});

			if (next === null) {
				// Queue finished — stop cleanly, keep the now-playing metadata.
				stopQueue();
				return;
			}

			if (await playQueueItem(queue[next], next)) return;

			// Unplayable entry: step past it and try the following one.
			fromIndex = next;
		}

		stopQueue();
	}

	function goNext() {
		if (queue.length === 0) return;
		void advanceQueue(true);
	}

	function goPrev() {
		if (!audioEl || queue.length === 0) return;
		// Match the music player: a press more than 3s in restarts the track.
		if (musicSettings.rewindOnPrev && audioEl.currentTime > 3) {
			audioEl.currentTime = 0;
			currentTime = 0;
			return;
		}
		const prev = previousQueueIndex(queueIndex, queue.length);
		if (prev === null) return;
		void playQueueItem(queue[prev], prev);
	}

	function handleEnded() {
		if (!audioEl) return;
		// Repeat-one mirrors Mp3PlayerView: restart rather than advance.
		if (musicSettings.isRepeat) {
			audioEl.currentTime = 0;
			safePlay();
			return;
		}
		void advanceQueue(false);
	}

	// ── Favorites ────────────────────────────────────────────────
	function toggleFavoriteFor(item: YoutubeQueueItem) {
		const favorites = Array.isArray(musicSettings.favoriteTracks) ? musicSettings.favoriteTracks : [];
		const key = getYoutubeFavoriteKey(item.videoId);
		const exists = favorites.some((entry) => entry.key === key);
		musicSettings.favoriteTracks = exists
			? favorites.filter((entry) => entry.key !== key)
			: [...favorites, favoriteFromQueueItem(item)];
	}

	function toggleFavorite() {
		if (currentItem) toggleFavoriteFor(currentItem);
	}

	function isFavorite(videoId: string): boolean {
		return youtubeFavorites.some((item) => item.videoId === videoId);
	}

	// ── Transport ────────────────────────────────────────────────
	/**
	 * Start or restart playback on the user's behalf.
	 *
	 * The element's src is wiped when another source claims audio
	 * (stopYoutubePlayback removes it and calls load()), and play() on a src-less
	 * element rejects with NotSupportedError — which safePlay treats as terminal
	 * and reports as "Could not start playback". Re-resolving the current item is
	 * both the working answer and the correct one, since the googlevideo URL from
	 * the original resolve is short-lived and may have expired anyway.
	 */
	function startOrResumePlayback() {
		claimAudio('youtube');
		mediaEngine.youtubePlaying = true;
		isPlaying = true;
		claimEngineControls();

		if (audioEl?.src && currentItem) {
			safePlay();
			return;
		}

		if (currentItem) {
			// startPlayback() sets the src and calls safePlay() itself.
			void playQueueItem(currentItem, queueIndex);
			return;
		}

		if (audioEl) safePlay();
	}

	function togglePlay() {
		if (!audioEl || !current) return;
		if (isPlaying) {
			audioEl.pause();
			return;
		}
		startOrResumePlayback();
	}

	function onSeekInput(event: Event) {
		if (!audioEl) return;
		const value = Number((event.target as HTMLInputElement).value);
		audioEl.currentTime = value;
		currentTime = value;
	}

	// ── Search ───────────────────────────────────────────────────
	async function runSearch() {
		const input = query.trim();
		if (!input) return;

		// A pasted link or bare ID goes straight to playback.
		const directId = youtubeVideoIdFromInput(input);
		if (directId) {
			await playRequestedVideo(directId);
			return;
		}

			error = '';
		isSearching = true;
		mode = 'search';
		try {
			// Only the search list is replaced here — the playback queue is left
			// alone so next/prev keep working on whatever is currently playing.
			searchResults = (await searchYoutube(input)).map(queueItemFromSearchResult);
			if (searchResults.length === 0) error = 'No results.';
		} catch (err) {
			error = describeYoutubeError(err);
			searchResults = [];
		} finally {
			isSearching = false;
		}
	}

	function onSearchKeydown(event: KeyboardEvent) {
		if (event.key === 'Enter') {
			event.preventDefault();
			void runSearch();
		}
	}

	function closePanel() {
		closeYoutubePanel();
	}

	// Play a video requested from outside the panel (a favorite in the browse
	// list, or the MiniPlayer). The pending id is cleared inside untrack() so
	// this effect does not depend on the write it performs.
	$effect(() => {
		if (!youtubePanel.open) return;
		const requested = youtubePanel.requestedVideoId;
		if (!requested) return;
		untrack(() => {
			youtubePanel.requestedVideoId = null;
		});
		void playRequestedVideo(requested);
	});
</script>

<!-- Always mounted: unmounting the audio element would stop playback when the
     panel is closed. -->
<audio
	bind:this={audioEl}
	preload="none"
	onplay={() => { isPlaying = true; isBuffering = false; mediaEngine.youtubePlaying = true; }}
	onpause={() => { isPlaying = false; mediaEngine.youtubePlaying = false; }}
	onwaiting={() => { isBuffering = true; }}
	onplaying={() => { isBuffering = false; isPlaying = true; mediaEngine.youtubePlaying = true; }}
	ontimeupdate={() => {
		if (!audioEl) return;
		currentTime = audioEl.currentTime;
		if (isFinite(audioEl.duration) && audioEl.duration > 0) duration = audioEl.duration;
		mediaEngine.updateTime(audioEl.currentTime, audioEl.duration || duration);
	}}
	onended={handleEnded}
	onerror={() => {
		isPlaying = false;
		isBuffering = false;
		mediaEngine.youtubePlaying = false;
		error = 'Playback failed. The audio link may have expired — tap the track again.';
	}}
></audio>

{#if youtubePanel.open}
<div class="absolute inset-0 z-50 bg-background flex flex-col">
	<!-- Header -->
	<div class="flex items-center gap-2 px-3 py-3 border-b shrink-0">
		<Button variant="ghost" size="icon" class="w-11 h-11 shrink-0" onclick={closePanel} aria-label="Close YouTube">
			<ChevronLeft class="w-6 h-6" />
		</Button>
		<div class="flex-1 min-w-0">
			<p class="text-sm font-semibold flex items-center gap-1.5">
				<Youtube class="w-4 h-4 text-red-500" /> YouTube
			</p>
			<p class="text-xs text-muted-foreground">Audio only</p>
		</div>
		<button
			class="w-10 h-10 flex items-center justify-center rounded-full transition-colors {musicSettings.isShuffle ? 'text-primary' : 'text-muted-foreground'} hover:bg-accent"
			onclick={() => (musicSettings.isShuffle = !musicSettings.isShuffle)}
			aria-label={musicSettings.isShuffle ? 'Disable shuffle' : 'Enable shuffle'}
			title="Shuffle (shared with the music player)"
		>
			<Shuffle class="w-5 h-5" />
		</button>
		<button
			class="w-10 h-10 flex items-center justify-center rounded-full transition-colors {musicSettings.youtubeQueueLoop ? 'text-primary' : 'text-muted-foreground'} hover:bg-accent"
			onclick={() => (musicSettings.youtubeQueueLoop = !musicSettings.youtubeQueueLoop)}
			aria-label={musicSettings.youtubeQueueLoop ? 'Disable loop' : 'Enable loop'}
			title="Loop the queue"
		>
			<Repeat class="w-5 h-5" />
		</button>
	</div>

	<!-- Tabs -->
	<div class="flex border-b shrink-0">
		<button
			class="flex-1 py-2.5 text-xs font-semibold transition-colors {mode === 'search' ? 'text-primary border-b-2 border-primary' : 'text-muted-foreground'}"
			onclick={() => (mode = 'search')}
		>Search</button>
		<button
			class="flex-1 py-2.5 text-xs font-semibold transition-colors {mode === 'favorites' ? 'text-primary border-b-2 border-primary' : 'text-muted-foreground'}"
			onclick={() => (mode = 'favorites')}
		>Favorites{youtubeFavorites.length > 0 ? ` (${youtubeFavorites.length})` : ''}</button>
	</div>

	<!-- Search input (search mode only) -->
	{#if mode === 'search'}
	<div class="px-3 py-3 border-b shrink-0 space-y-2">
		<div class="flex gap-2">
			<Input
				bind:value={query}
				placeholder="Search, or paste a link"
				class="h-9 flex-1"
				onkeydown={onSearchKeydown}
			/>
			<Button size="icon" class="h-9 w-9 shrink-0" onclick={runSearch} disabled={isSearching} aria-label="Search YouTube">
				{#if isSearching}
					<Loader2 class="w-4 h-4 animate-spin" />
				{:else}
					<Search class="w-4 h-4" />
				{/if}
			</Button>
		</div>
		{#if !isNativeApp}
			<p class="text-[11px] text-muted-foreground">
				YouTube playback only works in the Android app build.
			</p>
		{/if}
	</div>
	{/if}

	{#if error}
		<p class="text-xs text-destructive px-3 py-2 shrink-0">{error}</p>
	{/if}

	<!-- List -->
	<div class="flex-1 min-h-0 overflow-y-auto">
		{#if visibleList.length === 0}
			<div class="flex flex-col items-center justify-center h-full gap-3 p-8 text-center">
				<div class="w-20 h-20 rounded-3xl bg-gradient-to-br from-red-500 via-red-700 to-red-950 flex items-center justify-center shadow-2xl ring-1 ring-red-400/30">
					{#if mode === 'favorites'}
						<Star class="w-10 h-10 text-white" />
					{:else}
						<Youtube class="w-10 h-10 text-white" />
					{/if}
				</div>
				<p class="text-sm text-muted-foreground max-w-xs">
					{#if mode === 'favorites'}
						No favorite YouTube tracks yet. Tap the star on a track to save it.
					{:else}
						Search YouTube and play the audio track through your player.
					{/if}
				</p>
			</div>
		{:else}
			{#each visibleList as item, index (item.videoId)}
				{@const isActive = currentItem?.videoId === item.videoId}
				{@const favourited = isFavorite(item.videoId)}
				<div class="flex items-center gap-1 px-1 border-b {isActive ? 'bg-accent/40' : ''}">
					<button
						class="flex-1 min-w-0 flex items-center gap-3 px-2 py-2 text-left transition-colors hover:bg-accent/60"
						onclick={() => playFromList(mode === 'search' ? searchResults : youtubeFavorites, index)}
						disabled={resolvingId !== null}
						aria-label={`Play ${item.title}`}
						aria-current={isActive ? 'true' : undefined}
					>
						<div class="relative w-16 h-9 shrink-0 rounded overflow-hidden bg-secondary">
							{#if item.thumbnailUrl}
								<img src={item.thumbnailUrl} alt="" class="w-full h-full object-cover" loading="lazy" />
							{/if}
							{#if resolvingId === item.videoId}
								<div class="absolute inset-0 flex items-center justify-center bg-black/50">
									<Loader2 class="w-4 h-4 animate-spin text-white" />
								</div>
							{:else if isActive && isPlaying}
								<div class="absolute inset-0 flex items-center justify-center bg-black/40">
									<Play class="w-4 h-4 text-white" fill="currentColor" />
								</div>
							{/if}
						</div>
						<div class="flex-1 min-w-0">
							<p class="text-xs font-medium truncate {isActive ? 'text-primary' : ''}">{item.title}</p>
							<p class="text-[11px] text-muted-foreground truncate">
								{item.subtitle}{#if item.durationLabel} · {item.durationLabel}{/if}
							</p>
						</div>
					</button>
					<Button
						variant="ghost"
						size="icon"
						class="h-9 w-9 shrink-0 {favourited ? 'text-yellow-400' : 'text-muted-foreground'}"
						onclick={() => toggleFavoriteFor(item)}
						aria-label={favourited ? `Remove ${item.title} from favorites` : `Add ${item.title} to favorites`}
						title={favourited ? 'Remove from favorites' : 'Add to favorites'}
					>
						<Star class="w-4 h-4" fill={favourited ? 'currentColor' : 'none'} />
					</Button>
				</div>
			{/each}
		{/if}
	</div>

	<!-- Now playing -->
	{#if current && currentItem}
		<div class="border-t bg-card/95 px-3 py-3 shrink-0 space-y-2">
			<div class="flex items-center gap-3">
				{#if current.thumbnailUrl}
					<img src={current.thumbnailUrl} alt="" class="w-11 h-11 rounded object-cover shrink-0" />
				{/if}
				<div class="flex-1 min-w-0">
					<p class="text-xs font-medium truncate">{current.title || currentItem.title}</p>
					<p class="text-[11px] text-muted-foreground truncate">{current.author || currentItem.subtitle}</p>
				</div>
				<button
					class="w-9 h-9 flex items-center justify-center rounded-full transition-colors shrink-0 {isCurrentFavorite ? 'text-yellow-400' : 'text-muted-foreground'} hover:bg-accent"
					onclick={toggleFavorite}
					aria-label={isCurrentFavorite ? 'Remove from favorites' : 'Add to favorites'}
					title={isCurrentFavorite ? 'Remove from favorites' : 'Add to favorites'}
				>
					<Star class="w-5 h-5" fill={isCurrentFavorite ? 'currentColor' : 'none'} />
				</button>
				<Button variant="ghost" size="icon" class="w-10 h-10 shrink-0" onclick={togglePlay} aria-label={isPlaying ? 'Pause' : 'Play'}>
					{#if isBuffering}
						<Loader2 class="w-5 h-5 animate-spin" />
					{:else if isPlaying}
						<Pause class="w-5 h-5" />
					{:else}
						<Play class="w-5 h-5" />
					{/if}
				</Button>
			</div>

			<!-- Prev / seek / next -->
			<div class="flex items-center gap-2">
				<span class="text-[10px] text-muted-foreground tabular-nums w-9 text-right shrink-0">
					{formatClock(currentTime)}
				</span>
				<div class="relative flex-1 min-w-0 flex items-center">
					<div class="absolute inset-x-0 h-1 rounded-full bg-secondary pointer-events-none">
						<div class="h-full rounded-full bg-primary" style="width: {progressPercent}%"></div>
					</div>
					<input
						type="range"
						min="0"
						max={duration || 0}
						step="1"
						value={currentTime}
						oninput={onSeekInput}
						class="relative w-full h-1 appearance-none bg-transparent cursor-pointer"
						aria-label="Seek"
					/>
				</div>
				<span class="text-[10px] text-muted-foreground tabular-nums w-9 shrink-0">
					{formatClock(duration)}
				</span>
			</div>

			{#if queue.length > 1}
				<div class="flex items-center justify-center gap-6 pt-0.5">
					<button
						class="w-10 h-10 flex items-center justify-center rounded-full text-muted-foreground hover:bg-accent transition-colors"
						onclick={goPrev}
						aria-label="Previous track"
					>
						<ChevronLeft class="w-5 h-5" />
					</button>
					<span class="text-[11px] text-muted-foreground tabular-nums">
						{queueIndex + 1} / {queue.length}
					</span>
					<button
						class="w-10 h-10 flex items-center justify-center rounded-full text-muted-foreground hover:bg-accent transition-colors"
						onclick={goNext}
						aria-label="Next track"
					>
						<ChevronLeft class="w-5 h-5 rotate-180" />
					</button>
				</div>
			{/if}
		</div>
	{/if}
</div>
{/if}
