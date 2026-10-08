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
	 *  - shuffle     -> musicSettings.isShuffle (shared with the music player)
	 *  - repeat-one  -> musicSettings.isRepeat (handled in onEnded, as in Mp3PlayerView)
	 * Auto-advance stops at the end of the queue, mirroring the mp3 view.
	 *
	 * EQ is not applied, and cannot be: Web Audio refuses to process cross-origin
	 * media without CORS headers, and googlevideo sends none. Same reason radio
	 * bypasses the EQ.
	 */
	import { onDestroy, untrack } from 'svelte';
	import { Capacitor } from '@capacitor/core';
	import Button from '$lib/components/ui/Button.svelte';
	import { getYoutubeFavoriteKey, isYoutubeFavorite } from '$lib/models/music';
	import { claimAudio, mediaEngine, markUserPaused, registerAudioSource } from '$lib/stores/mediaEngine.svelte';
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
	import { musicFavorites } from '$lib/stores/musicView.svelte';
	import { ChevronLeft, Loader2, Play, Search, Star, X, Youtube } from 'lucide-svelte';

	const isNativeApp = Capacitor.isNativePlatform();

	// ── Browser / list state ─────────────────────────────────────
	// Favorites mode is shared with the music view's star toggle
	// (musicFavorites.shown) — the in-panel Search/Favorites tabs are gone, and
	// the browse-header star in Mp3PlayerView decides whether this panel lists
	// search results or favorites.
	const mode = $derived<'search' | 'favorites'>(musicFavorites.shown ? 'favorites' : 'search');
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

	const visibleList = $derived(mode === 'search' ? searchResults : youtubeFavorites);

	// ── Engine wiring ────────────────────────────────────────────
	function stopYoutubePlayback() {
		isPlaying = false;
		isBuffering = false;
		mediaEngine.youtubePlaying = false;
		clearLoadWatchdog();
		_watchdogStage = 'idle';
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

	// The MiniPlayer's transport follows the visible sub-tab: while the YouTube
	// panel is on screen it owns play/pause/seek/next/prev, so switching to it
	// from a playing Deck B hands the controls back to YouTube.
	$effect(() => {
		if (mediaEngine.displayedSource === 'youtube' && currentItem) {
			claimEngineControls();
		}
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
			() => {
				// Deliberate pause (MiniPlayer / lock screen / sleep timer): tell the
				// engine, so the Android background recovery does not restart playback.
				markUserPaused();
				isPlaying = false;
				mediaEngine.youtubePlaying = false;
				audioEl?.pause();
			},
			(time) => { if (audioEl) audioEl.currentTime = time; }
		);
		// Next/prev drive the queue, so the MiniPlayer, MediaSession and the
		// Android notification controls all work while YouTube owns audio.
		mediaEngine.setSkipHandlers(goNext, goPrev);
	}

	// ── Playback ─────────────────────────────────────────────────
	/**
	 * Watchdog for a source that never loads.
	 *
	 * A googlevideo URL can be perfectly valid (verified: `206 audio/mp4` for an
	 * unbounded range probe) and still fail to load in the media element — the
	 * host is unreachable, or the request is dropped. No `error` event fires, so
	 * without this the track sits at 0:00 forever with no message and no way out.
	 *
	 * One re-resolve (which usually lands on a different googlevideo host), then
	 * an actionable message. Bounded so it cannot loop.
	 */
	const LOAD_WATCHDOG_MS = 15_000;
	let _watchdogTimer: number | null = null;
	let _watchdogStage: 'idle' | 'armed' | 'retried' = 'idle';

	function clearLoadWatchdog() {
		if (_watchdogTimer !== null) {
			clearTimeout(_watchdogTimer);
			_watchdogTimer = null;
		}
	}

	async function recoverStalledLoad(videoId: string) {
		try {
			const source = await resolveYoutubeAudio(videoId);
			// The listener may have moved on while this was in flight.
			if (!audioEl || currentItem?.videoId !== videoId) return;
			current = source;
			if (source.durationSeconds > 0) duration = source.durationSeconds;
			audioEl.src = source.audioUrl;
			audioEl.load();
			safePlay();
		} catch {
			clearLoadWatchdog();
			_watchdogStage = 'idle';
			stopQueue();
			error = 'This track would not load. Tap it again to retry.';
		}
	}

	/** (Re)start the load watchdog for a freshly set source. */
	function armLoadWatchdog(videoId: string) {
		clearLoadWatchdog();
		_watchdogStage = 'armed';
		_watchdogTimer = window.setTimeout(() => {
			_watchdogTimer = null;
			// readyState >= 1 means metadata arrived; the source is loading fine,
			// even if it is still buffering.
			if (!audioEl || audioEl.readyState >= 1) {
				_watchdogStage = 'idle';
				return;
			}
			if (_watchdogStage === 'retried') {
				_watchdogStage = 'idle';
				stopQueue();
				error = 'This track would not load. Tap it again to retry.';
				return;
			}
			_watchdogStage = 'retried';
			armLoadWatchdog(videoId);
			void recoverStalledLoad(videoId);
		}, LOAD_WATCHDOG_MS);
	}

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
			armLoadWatchdog(item.videoId);
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
			musicFavorites.shown = true;
			playFromList(youtubeFavorites, favoriteIndex);
			return;
		}

		const searchIndex = indexOfVideo(searchResults, videoId);
		if (searchIndex >= 0) {
			musicFavorites.shown = false;
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
		clearLoadWatchdog();
		_watchdogStage = 'idle';
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
				// Only user-initiated skips wrap; auto-advance stops at the end
				// of the queue, mirroring the mp3 view.
				queueLoop: manual,
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
		// Searching always lands in the search-results view; if favorites were
		// showing, flip the shared star state off so results become visible.
		musicFavorites.shown = false;
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
	onloadedmetadata={() => { clearLoadWatchdog(); _watchdogStage = 'idle'; }}
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
			class="w-10 h-10 flex items-center justify-center rounded-full transition-colors {musicFavorites.shown ? 'text-yellow-400' : 'text-muted-foreground'} hover:bg-accent"
			onclick={() => (musicFavorites.shown = !musicFavorites.shown)}
			aria-label={musicFavorites.shown ? 'Show search' : 'Show YouTube favorites'}
			title={musicFavorites.shown ? 'Show search' : 'Show YouTube favorites'}
		>
			<Star class="w-5 h-5" fill={musicFavorites.shown ? 'currentColor' : 'none'} />
		</button>
	</div>

	<!-- Search / paste field — mirrors the library filter field on decks A/B
	     (same spot directly below the header row, same full-width look), so the
	     field users already know becomes the YouTube search field on this tab.
	     Enter searches; a pasted link or bare ID plays directly. -->
	<div class="px-3 py-3 border-b shrink-0">
		<div class="relative w-full">
			<Search class="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
			<input
				type="text"
				placeholder="Search, or paste a link"
				bind:value={query}
				onkeydown={onSearchKeydown}
				class="w-full h-8 pl-7 pr-7 text-xs rounded-lg border bg-background focus:outline-none focus:ring-1 focus:ring-primary/50"
			/>
			{#if isSearching}
				<div class="absolute right-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 border-2 border-primary border-t-transparent rounded-full animate-spin"></div>
			{:else if query}
				<button
					class="absolute right-1 top-1/2 -translate-y-1/2 w-5 h-5 flex items-center justify-center rounded-full text-muted-foreground hover:text-foreground"
					onclick={() => (query = '')}
					aria-label="Clear search"
				>
					<X class="w-3 h-3" />
				</button>
			{/if}
		</div>
		{#if !isNativeApp}
			<p class="text-[11px] text-muted-foreground mt-1.5">
				YouTube playback only works in the Android app build.
			</p>
		{/if}
	</div>

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

</div>
{/if}
