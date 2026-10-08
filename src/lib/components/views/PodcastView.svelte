
<script lang="ts">
	import { env } from '$env/dynamic/public';
	import { Capacitor } from '@capacitor/core';
	import { marqueeTitle } from '$lib/actions/marqueeTitle';
	import { pullToRefresh, swipeBack } from '$lib/actions/touch';
	import Button from '$lib/components/ui/Button.svelte';
	import Card from '$lib/components/ui/Card.svelte';
	import { triggerSwipeBackHaptic } from '$lib/native/haptics';
	import Badge from '$lib/components/ui/Badge.svelte';
	import { appSettings, podcastSettings, podcastData } from '$lib/stores/settings.svelte';
	import { mediaEngine, registerAudioSource } from '$lib/stores/mediaEngine.svelte';
	import { addToast } from '$lib/stores/toastStore.svelte';
	import { getListTileToneClasses } from '$lib/utils/listTileTone';
	import { formatDuration } from '$lib/models/music';
	import { formatDate } from '$lib/podcast/rss';
	import {
		isActiveEpisode, getEpisodeProgressPercent, getEpisodeProgressLabel,
		isNewEpisode, artworkFallback,
	} from '$lib/podcast/episodeDisplay';
	import {
		searchITunes, type ItunesResult,
	} from '$lib/podcast/itunes';
	import {
		syncPersistedEpisodeState,
		getEpisodeResumePosition, type PodcastProgressView,
	} from '$lib/podcast/progress';
	import {
		createPodcastLibrary, type PodcastLibrary,
	} from '$lib/podcast/podcastLibrary';
	import {
		createPodcastPlayer, type PodcastPlayer,
	} from '$lib/podcast/podcastPlayer';
	import {
		Plus, Trash2, Play, Pause,
		Rss, Clock, CheckCircle2, ChevronLeft, Search,
		RefreshCw, X
	} from 'lucide-svelte';

	// ── Types ────────────────────────────────────────────────────
	interface Episode {
		id:          string;
		title:       string;
		description: string;
		duration:    number;   // seconds
		publishedAt: string;
		played:      boolean;
		progress:    number;   // 0-100
		positionSec: number;   // exact playback position in seconds (0 = from start)
		audioUrl:    string;
	}
	interface Podcast {
		id:          number;
		itunesId:    number;
		title:       string;
		author:      string;
		category:    string;
		artworkUrl:  string;
		feedUrl:     string;
		subscribed:  boolean;
		episodes:    Episode[];
		episodesLoaded: boolean;
	}
	// ── Podcast list — backed by persisted store ──
	// podcastData.podcasts / podcastData.nextId survive refreshes via localStorage

	// ── UI state ─────────────────────────────────────────────────
	let selectedPodcast    = $state<Podcast | null>(null);
	let searchQuery        = $state('');
	let searchResults      = $state<ItunesResult[]>([]);
	let searchLoading      = $state(false);
	let episodesLoading    = $state(false);
	let episodesLoadingMore = $state(false);
	let episodesRefreshing = $state(false); // background refresh while episodes already shown
	let episodesPage      = $state(1);
	let hasMoreEpisodes   = $state(false);
	let isRefreshingAll    = $state(false); // pull-to-refresh: background refresh of all subscribed
	let pullDistance       = $state(0);     // pull-to-refresh: current drag distance (px)
	let loadMoreSentinelEl = $state<HTMLElement | null>(null);
	let episodePullDist    = $state(0);
	let episodesError      = $state<string | null>(null);
	let hasRestoredSelectedPodcast = false;
	const listTileToneClasses = $derived(getListTileToneClasses(appSettings.listTileTone));
	const podcastApiBaseUrl = (() => {
		const configuredBaseUrl = env.PUBLIC_RELEASE_BASE_URL?.trim().replace(/\/$/, '');
		if (configuredBaseUrl) return configuredBaseUrl;
		if (Capacitor.isNativePlatform()) {
			return 'https://mobile-media-app-maverock24.netlify.app';
		}
		return '';
	})();
	const useHostedPodcastProxy = podcastApiBaseUrl.length > 0;

	// ── Playback state ───────────────────────────────────────────
	let currentEpisode = $state<{ podcast: Podcast; episode: Episode } | null>(null);
	let isPlaying      = $state(false);
	let isBuffering    = $state(false);
	let currentTime    = $state(0);
	let duration       = $state(0);
	let audioEl: HTMLAudioElement;

	// The progress module is a plain `.ts`; it reads and replaces the two
	// component-owned objects through this accessor (the shape fileOps uses).
	const progressView: PodcastProgressView = {
		get selectedPodcast() { return selectedPodcast; },
		set selectedPodcast(v) { selectedPodcast = v; },
		get currentEpisode() { return currentEpisode; },
		set currentEpisode(v) { currentEpisode = v; },
	};

	// The subscribe/refresh/episode-load logic lives in the per-view
	// `createPodcastLibrary` factory (PR 6 group 4). It is a rune-free `.ts` that
	// imports the shared `podcastData` store directly; the component keeps
	// `selectedPodcast`, the episode-list flags/counters and `isRefreshingAll`
	// reactive and passes an accessor, plus the release/proxy config. The
	// in-flight load's controller/id are private to the factory.
	const podcastLibrary: PodcastLibrary = createPodcastLibrary({
		view: {
			get selectedPodcast() { return selectedPodcast; },
			set selectedPodcast(v) { selectedPodcast = v; },
			get episodesLoading() { return episodesLoading; },
			set episodesLoading(v) { episodesLoading = v; },
			get episodesLoadingMore() { return episodesLoadingMore; },
			set episodesLoadingMore(v) { episodesLoadingMore = v; },
			get episodesRefreshing() { return episodesRefreshing; },
			set episodesRefreshing(v) { episodesRefreshing = v; },
			get episodesPage() { return episodesPage; },
			set episodesPage(v) { episodesPage = v; },
			get hasMoreEpisodes() { return hasMoreEpisodes; },
			set hasMoreEpisodes(v) { hasMoreEpisodes = v; },
			get episodesError() { return episodesError; },
			set episodesError(v) { episodesError = v; },
			get isRefreshingAll() { return isRefreshingAll; },
			set isRefreshingAll(v) { isRefreshingAll = v; },
			get subscribedPodcasts() { return subscribedPodcasts; },
		},
		config: { baseUrl: podcastApiBaseUrl, useHostedProxy: useHostedPodcastProxy },
	});

	// The podcast transport lives in the per-view `createPodcastPlayer` factory
	// (PR 6 group 5). It is a rune-free `.ts`; the component keeps the reactive
	// playback state and hands it over through this accessor, and the
	// `bind:this`-bound `<audio>` element through `getAudioEl`. The pending
	// reconnect listener, the user-pause flag and the element throttle stamps
	// are private to the factory.
	const podcastPlayer: PodcastPlayer = createPodcastPlayer({
		view: {
			get selectedPodcast() { return selectedPodcast; },
			set selectedPodcast(v) { selectedPodcast = v; },
			get currentEpisode() { return currentEpisode; },
			set currentEpisode(v) { currentEpisode = v; },
			get isPlaying() { return isPlaying; },
			set isPlaying(v) { isPlaying = v; },
			get isBuffering() { return isBuffering; },
			set isBuffering(v) { isBuffering = v; },
			get currentTime() { return currentTime; },
			set currentTime(v) { currentTime = v; },
			get duration() { return duration; },
			set duration(v) { duration = v; },
		},
		getAudioEl: () => audioEl,
	});

	// ── Register stop-callback ───────────────────────────────────
	$effect(() => {
		registerAudioSource('podcast', () => {
			if (!audioEl) return;
			isPlaying = false;
			audioEl.pause();
			// Fully reset so the browser releases the audio channel —
			// pause() alone can leave residual decoder state that
			// causes brief overlap when a new source starts immediately.
			audioEl.removeAttribute('src');
			audioEl.load();
		});
	});

	// ── Audio element event wiring ───────────────────────────────
	// The nine element listeners — including the throttled progress persist and
	// the reconnect/auto-resume/ended handlers — now live in the transport
	// module. This effect still owns their lifecycle: it attaches them when the
	// `bind:this` element is available and tears them down (and cancels any
	// pending reconnect) on cleanup, at exactly the same moments as before.
	$effect(() => {
		if (!audioEl) return;
		return podcastPlayer.attachElementListeners(audioEl);
	});

	// ── Sync playback speed ──────────────────────────────────────
	$effect(() => { if (audioEl) audioEl.playbackRate = podcastSettings.playbackSpeed; });

	// Pull-to-refresh + swipe-back are wired via use:pullToRefresh /
	// use:swipeBack actions on the scroll containers in the template below.
	const PULL_THRESHOLD = 64;

	// How often (ms) playback progress is flushed to the persisted store during
	// playback. Coarse on purpose — see the timeupdate handler. A final flush is
	// forced on pause / end / background so resume position is still exact.
	//
	// Each flush persists by replacing podcastData.podcasts, which serialises the
	// ENTIRE trimmed podcast-data blob (all subscriptions' kept episodes) and
	// re-runs the subscribedPodcasts sort derived. 20s balances crash/background
	// resume granularity (~last 20s) against that full-blob main-thread cost on
	// Android. Pause/end/background still flush exactly.


	// ── Lazy loading: IntersectionObserver on sentinel element ──
	$effect(() => {
		const el = loadMoreSentinelEl;
		if (!el || !selectedPodcast) return;
		const observer = new IntersectionObserver(
			(entries) => {
				if (entries[0]?.isIntersecting && hasMoreEpisodes && !episodesLoadingMore && selectedPodcast) {
					void podcastLibrary.loadMoreEpisodes(selectedPodcast);
				}
			},
			{ rootMargin: '200px' }
		);
		observer.observe(el);
		return () => observer.disconnect();
	});

	
	// ── Marquee overflow detection ──
	// ── Derived ─────────────────────────────────────────────────
	// Sort subscribed podcasts by newest unplayed episode — podcasts with fresh
	// unheard content bubble to the top. Fully-played / unloaded podcasts sink.
	const subscribedPodcasts = $derived(
		podcastData.podcasts.filter(p => p.subscribed).sort((a, b) => {
			const latestUnplayed = (pod: Podcast): number => {
				if (!pod.episodesLoaded || pod.episodes.length === 0) return 0;
				const timestamps = pod.episodes
					.filter(e => !e.played && e.publishedAt)
					.map(e => new Date(e.publishedAt).getTime() || 0);
				return timestamps.length > 0 ? Math.max(...timestamps) : 0;
			};
			return latestUnplayed(b) - latestUnplayed(a);
		})
	);

	/** RssFetchConfig bound to this view's release/proxy resolution. */

	// ── iTunes Search ────────────────────────────────────────────
	// Wrapper keeps the view's own state updates; the search itself is pure.
	async function runITunesSearch(q: string) {
		if (q.length < 2) { searchResults = []; return; }
		searchLoading = true;
		searchResults = await searchITunes(q, { baseUrl: podcastApiBaseUrl, useHostedProxy: useHostedPodcastProxy });
		searchLoading = false;
	}

	// Debounce on subscribed tab / search query
	$effect(() => {
		const q = searchQuery;
		if (!q || q.length < 2) { searchResults = []; return; }
		const t = setTimeout(() => runITunesSearch(q), 400);
		return () => clearTimeout(t);
	});

	// Preload discover tab popular podcasts
	$effect(() => {
		if (podcastSettings.defaultTab === 'discover' && searchResults.length === 0 && !searchQuery && !searchLoading) {
			runITunesSearch('technology science');
		}
	});

	// ── Persist position on pause / end; sync episode progress into the store ──
	$effect(() => {
		if (!audioEl) return;
		const onPause = () => {
			if (!currentEpisode) return;
			podcastData.lastEpisodeId   = currentEpisode.episode.id;
			podcastData.lastPodcastId   = currentEpisode.podcast.id;
			podcastData.lastPositionSec = currentEpisode.episode.played ? 0 : audioEl.currentTime;
			syncPersistedEpisodeState(currentEpisode.podcast.id, currentEpisode.episode, progressView);
		};
		audioEl.addEventListener('pause', onPause);
		audioEl.addEventListener('ended', onPause);
		return () => {
			audioEl?.removeEventListener('pause', onPause);
			audioEl?.removeEventListener('ended', onPause);
		};
	});

	// ── Restore last-played episode on mount ──────────────────────
	$effect(() => {
		if (hasRestoredSelectedPodcast) return;
		if (selectedPodcast !== null) {
			hasRestoredSelectedPodcast = true;
			return;
		}
		if (podcastData.lastPodcastId < 0) {
			hasRestoredSelectedPodcast = true;
			return;
		}
		const pod = podcastData.podcasts.find(p => p.id === podcastData.lastPodcastId);
		if (!pod) return;
		hasRestoredSelectedPodcast = true;
		podcastLibrary.openPodcast(pod);
	});

	$effect(() => {
		if (!podcastData.lastEpisodeId || podcastData.lastPodcastId < 0) return;
		// Only restore if nothing is currently playing — avoids clobbering live playback
		// when background RSS refresh mutates podcastData.podcasts and re-triggers this effect
		if (currentEpisode !== null) return;
		const pod = podcastData.podcasts.find(p => p.id === podcastData.lastPodcastId);
		if (!pod) return;
		const ep = pod.episodes.find(e => e.id === podcastData.lastEpisodeId);
		if (!ep) return;
		const resumeAt = getEpisodeResumePosition(ep);
		currentEpisode = { podcast: pod, episode: ep };
		duration = ep.duration;
		currentTime = resumeAt;
		mediaEngine.setNowPlaying({
			id:         ep.id,
			source:     'podcast',
			title:      ep.title,
			subtitle:   pod.title,
			audioUrl:   ep.audioUrl,
			artworkUrl: pod.artworkUrl,
			duration:   ep.duration,
		}, 'podcast');
		podcastPlayer.claimPodcastControls();
		mediaEngine.updateTime(resumeAt, ep.duration);
		mediaEngine.podcastPlaying = false;
	});

	$effect(() => {
		// Transport follows the visible tab: while the podcast view is on screen it
		// owns the MiniPlayer controls even if Deck B is also playing in the
		// background.
		if (mediaEngine.displayedSource === 'podcast' && currentEpisode) {
			podcastPlayer.claimPodcastControls();
		}
	});

	$effect(() => { return () => { audioEl?.pause(); }; });

	// iTunes result already-subscribed check
	function isSubscribed(itunesId: number) {
		return podcastData.podcasts.some(p => p.itunesId === itunesId && p.subscribed);
	}
</script>

<!-- Hidden audio element -->
<audio bind:this={audioEl} preload="none"></audio>

<div class="flex flex-col h-full bg-background/85">

{#if selectedPodcast}
	<!-- ════════════════════════════════ EPISODE LIST ═══════════════════════════════ -->
	<div class="flex flex-col flex-1 min-h-0">
		<!-- Header -->
		<div class="flex items-center gap-2 px-3 py-2 border-b shrink-0">
			<Button
				variant="ghost"
				size="icon"
				class="w-11 h-11"
				onclick={() => (selectedPodcast = null, episodesError = null)}
			>
				<ChevronLeft class="w-6 h-6" />
			</Button>
			<div class="flex-1 min-w-0 pr-2">
				<h2 class="font-semibold text-base leading-tight truncate">{selectedPodcast.title}</h2>
			</div>
		</div>

		<!-- Episode list body -->
		<div
			class="flex-1 overflow-y-auto"
			use:pullToRefresh={{
				onRefresh: () => { if (selectedPodcast) void podcastLibrary.loadEpisodes(selectedPodcast, true); },
				onUpdate: (d) => episodePullDist = d,
				threshold: PULL_THRESHOLD,
			}}
			use:swipeBack={{
				onBack: () => {
					void triggerSwipeBackHaptic();
					selectedPodcast = null;
					episodesError = null;
					episodePullDist = 0;
				},
			}}
		>
			<!-- Pull-to-refresh indicator -->
			{#if episodesRefreshing || episodePullDist > 0}
				<div
					class="flex items-center justify-center gap-2 overflow-hidden"
					style:height="{episodesRefreshing ? 44 : Math.round((episodePullDist / PULL_THRESHOLD) * 44)}px"
					style:opacity="{episodesRefreshing ? 1 : Math.min(episodePullDist / PULL_THRESHOLD, 1)}"
				>
					<span
						class="inline-flex {episodesRefreshing ? 'animate-spin text-primary' : 'text-muted-foreground'}"
						style:transform={episodesRefreshing ? '' : `rotate(${Math.round((episodePullDist / PULL_THRESHOLD) * 180)}deg)`}
					>
						<RefreshCw class="w-4 h-4" />
					</span>
					{#if episodesRefreshing}
						<span class="text-xs text-muted-foreground">Refreshing episodes…</span>
					{/if}
				</div>
			{/if}
			{#if episodesLoading}
				<div class="flex flex-col items-center justify-center h-40 gap-3">
					<div class="w-8 h-8 border-4 border-primary/30 border-t-primary rounded-full animate-spin"></div>
					<p class="text-sm text-muted-foreground">Loading episodes…</p>
				</div>
			{:else if episodesError}
				<div class="flex flex-col items-center justify-center h-40 gap-3 px-6 text-center">
					<span class="text-3xl">📡</span>
					<p class="text-sm text-muted-foreground">{episodesError}</p>
					<Button variant="outline" size="sm" onclick={() => { if (selectedPodcast) { selectedPodcast.episodesLoaded = false; podcastLibrary.loadEpisodes(selectedPodcast); } }}>
						<RefreshCw class="w-3.5 h-3.5 mr-1.5" /> Retry
					</Button>
				</div>
			{:else if selectedPodcast.episodes.length === 0}
				<div class="flex flex-col items-center justify-center h-40 gap-2 text-muted-foreground">
					<Rss class="w-10 h-10 opacity-30" />
					<p class="text-sm">No episodes found</p>
				</div>
			{:else}
				{#each selectedPodcast.episodes as episode}
					{@const activeEpisode = isActiveEpisode(episode, currentEpisode)}
					{@const episodeProgress = getEpisodeProgressPercent(episode, currentEpisode, currentTime, duration)}
					{@const episodeProgressLabel = getEpisodeProgressLabel(episode, currentEpisode, currentTime, duration)}
					{@const newEpisode = isNewEpisode(episode)}
					<div
						class="tap-feedback list-row-surface relative overflow-hidden border-l-[6px] p-4 border-b transition-colors cursor-pointer {newEpisode ? 'border-l-primary bg-gradient-to-r from-primary/20 via-primary/10 to-background shadow-[inset_0_1px_0_rgba(255,255,255,0.08)] hover:from-primary/25 hover:via-primary/15 active:from-primary/30' : `border-l-transparent ${listTileToneClasses.usesTint ? listTileToneClasses.rowClass : 'hover:bg-accent/40 active:bg-accent/60'}`}"
						role="button"
						tabindex="0"
						onclick={() => selectedPodcast && podcastPlayer.activateEpisode(selectedPodcast, episode)}
						onkeydown={(event) => {
							if (event.key !== 'Enter' && event.key !== ' ') return;
							event.preventDefault();
							if (selectedPodcast) podcastPlayer.activateEpisode(selectedPodcast, episode);
						}}
					>
						{#if newEpisode}
							<div class="pointer-events-none absolute inset-y-0 left-0 w-24 bg-primary/10 blur-2xl"></div>
						{/if}
						<div class="flex items-start gap-3">
							<div class="flex-1 min-w-0">
								<div class="flex items-center gap-2 mb-1">
									{#if newEpisode}
										<Badge variant="default" class="shrink-0 gap-1.5 px-2.5 py-0.5 text-[11px] uppercase tracking-wide shadow-sm">
											<span class="h-1.5 w-1.5 rounded-full bg-primary-foreground"></span>
											New
										</Badge>
									{/if}
									{#if episode.played}
										<span class="inline-flex items-center gap-1 rounded-full bg-secondary/80 px-2 py-0.5 text-[11px] font-medium text-muted-foreground shrink-0">
											<CheckCircle2 class="w-3.5 h-3.5" />
											Played
										</span>
									{/if}
									<p use:marqueeTitle={{ active: activeEpisode }} class="font-semibold text-[0.95rem] leading-tight title-marquee {episode.played ? 'text-muted-foreground' : newEpisode ? 'text-primary text-base' : ''}">
										<span class="title-marquee-inner" data-text={episode.title}>{episode.title}</span>
									</p>
								</div>
								{#if episode.description}
									<p class="text-xs text-muted-foreground line-clamp-2 mb-2">{episode.description}</p>
								{/if}
								<div class="flex items-center gap-3 text-xs text-muted-foreground">
									{#if episode.duration > 0}
										<span class="flex items-center gap-1">
											<Clock class="w-3 h-3" />{formatDuration(episode.duration)}
										</span>
									{/if}
									{#if episode.publishedAt}
										<span>{formatDate(episode.publishedAt)}</span>
									{/if}
								</div>
								{#if episodeProgress > 0 && episodeProgress < 100}
									<div class="mt-2 space-y-1">
										<div class="h-1 rounded-full bg-secondary overflow-hidden">
											<div class="h-full bg-primary rounded-full" style="width: {episodeProgress}%"></div>
										</div>
										{#if activeEpisode && episodeProgressLabel}
											<div class="flex items-center gap-1 text-[11px] font-medium text-primary">
												<span class={`h-1.5 w-1.5 rounded-full ${isPlaying ? 'bg-primary animate-pulse' : 'bg-primary/70'}`}></span>
												<span>{episodeProgressLabel}</span>
											</div>
										{/if}
									</div>
								{/if}
							</div>
							<Button
								size="icon" variant={activeEpisode && (isPlaying || isBuffering) ? 'default' : 'outline'}
								class="shrink-0 w-11 h-11 rounded-full"
								onclick={(event) => {
									event.stopPropagation();
									if (selectedPodcast) {
										podcastPlayer.activateEpisode(selectedPodcast, episode);
									}
								}}
							>
								{#if activeEpisode && isBuffering}
									<div class="w-5 h-5 border-2 border-current border-t-transparent rounded-full animate-spin"></div>
								{:else if activeEpisode && isPlaying}
									<Pause class="w-5 h-5" />
								{:else}
									<Play class="w-5 h-5 ml-0.5" />
								{/if}
							</Button>
						</div>
					</div>
				{/each}
			<!-- Lazy loading sentinel: triggers loadMoreEpisodes when scrolled into view -->
			{#if hasMoreEpisodes && selectedPodcast}
				<div
					bind:this={loadMoreSentinelEl}
					class="flex items-center justify-center py-6"
				>
					{#if episodesLoadingMore}
						<div class="flex items-center gap-2 text-sm text-muted-foreground">
							<div class="w-4 h-4 border-2 border-primary/30 border-t-primary rounded-full animate-spin"></div>
							Loading more episodes…
						</div>
					{:else}
						<span class="text-xs text-muted-foreground">Scroll for more</span>
					{/if}
				</div>
			{/if}
			{/if}
		</div>
	</div>

{:else}
	<!-- ════════════════════════════════ PODCAST LIST ══════════════════════════════ -->
	<div class="flex flex-col flex-1 min-h-0">
		<!-- Search & Tabs header -->
		<div class="p-4 border-b space-y-3 shrink-0">
			<div class="relative">
				<Search class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
				<input
					type="text"
					placeholder="Search podcasts…"
					bind:value={searchQuery}
					class="w-full pl-9 pr-4 py-2 bg-secondary border border-border rounded-lg text-sm outline-none focus:ring-1 focus:ring-ring"
				/>
				{#if searchQuery}
					<button class="absolute right-3 top-1/2 -translate-y-1/2"
						onclick={() => (searchQuery = '', searchResults = [])}>
						<X class="w-4 h-4 text-muted-foreground" />
					</button>
				{/if}
			</div>
			<div class="flex rounded-lg bg-muted p-1 gap-1">
				<button
					class="flex-1 py-1.5 rounded-md text-sm font-medium transition-colors {podcastSettings.defaultTab === 'subscribed' ? 'bg-background shadow text-foreground' : 'text-muted-foreground'}"
					onclick={() => (podcastSettings.defaultTab = 'subscribed', searchQuery = '', searchResults = [])}
				>
					Subscribed ({subscribedPodcasts.length})
				</button>
				<button
					class="flex-1 py-1.5 rounded-md text-sm font-medium transition-colors {podcastSettings.defaultTab === 'discover' ? 'bg-background shadow text-foreground' : 'text-muted-foreground'}"
					onclick={() => (podcastSettings.defaultTab = 'discover')}
				>
					Discover
				</button>
			</div>
		</div>

		<div
			class="flex-1 overflow-y-auto"
			use:pullToRefresh={{
				onRefresh: () => { void podcastLibrary.refreshAllSubscribed(); },
				onUpdate: (d) => pullDistance = d,
				threshold: PULL_THRESHOLD,
			}}
		>
			{#if podcastSettings.defaultTab === 'subscribed' && !searchQuery}
				<!-- Pull-to-refresh indicator -->
				{#if isRefreshingAll || pullDistance > 0}
					<div
						class="flex items-center justify-center gap-2 overflow-hidden"
						style:height="{isRefreshingAll ? 44 : Math.round((pullDistance / PULL_THRESHOLD) * 44)}px"
						style:opacity="{isRefreshingAll ? 1 : Math.min(pullDistance / PULL_THRESHOLD, 1)}"
					>
						<span
							class="inline-flex {isRefreshingAll ? 'animate-spin text-primary' : 'text-muted-foreground'}"
							style:transform={isRefreshingAll ? '' : `rotate(${Math.round((pullDistance / PULL_THRESHOLD) * 180)}deg)`}
						>
							<RefreshCw class="w-4 h-4" />
						</span>
						{#if isRefreshingAll}
							<span class="text-xs text-muted-foreground">Updating podcasts…</span>
						{/if}
					</div>
				{/if}
				<!-- ── Subscribed List ── -->
				{#each subscribedPodcasts as podcast}
					{@const artGradient = artworkFallback(podcast)}
					<div class="tap-feedback list-row-surface flex items-center gap-3 p-4 border-b transition-colors cursor-pointer {listTileToneClasses.usesTint ? listTileToneClasses.rowClass : 'hover:bg-accent/40 active:bg-accent/60'}"
						role="button" tabindex="0"
						onclick={() => podcastLibrary.openPodcast(podcast)}
						onkeydown={(e) => e.key === 'Enter' && podcastLibrary.openPodcast(podcast)}
					>
						{#if podcast.artworkUrl}
							<img src={podcast.artworkUrl} alt={podcast.title} loading="lazy" decoding="async" width="52" height="52"
								class="rounded-xl object-cover shrink-0 w-[52px] h-[52px]" />
						{:else}
							<div class="w-[52px] h-[52px] rounded-xl bg-gradient-to-br {artGradient} flex items-center justify-center text-2xl shrink-0">
								🎙
							</div>
						{/if}
						<div class="flex-1 min-w-0">
							<p class="font-semibold text-[0.95rem] leading-tight truncate">{podcast.title}</p>
							<p class="text-xs text-muted-foreground">{podcast.author}</p>
							<Badge variant="secondary" class="mt-1 text-xs">{podcast.category}</Badge>
						</div>
						<div class="flex flex-col items-end gap-2 shrink-0">
							{#if podcast.episodesLoaded}
								<span class="text-xs text-muted-foreground">{podcast.episodes.length} eps</span>
							{/if}
							<Button variant="ghost" size="icon" class="w-7 h-7 text-destructive hover:text-destructive"
								onclick={(e) => { e.stopPropagation(); podcastLibrary.deletePodcast(podcast.id); }}>
								<Trash2 class="w-3.5 h-3.5" />
							</Button>
						</div>
					</div>
				{/each}
				{#if subscribedPodcasts.length === 0}
					<div class="flex flex-col items-center justify-center py-16 gap-3 text-muted-foreground">
						<Rss class="w-12 h-12 opacity-30" />
						<p class="text-sm">No subscriptions yet</p>
						<Button variant="outline" size="sm" onclick={() => (podcastSettings.defaultTab = 'discover')}>
							Discover Podcasts
						</Button>
					</div>
				{/if}

			{:else}
				<!-- ── Discover / Search Results ── -->
				{#if searchLoading}
					<div class="flex items-center justify-center h-32 gap-3">
						<div class="w-6 h-6 border-4 border-primary/30 border-t-primary rounded-full animate-spin"></div>
						<p class="text-sm text-muted-foreground">Searching…</p>
					</div>
				{:else if searchResults.length === 0 && searchQuery.length > 1}
					<div class="flex flex-col items-center justify-center py-16 gap-3 text-muted-foreground">
						<Search class="w-10 h-10 opacity-30" />
						<p class="text-sm">No results for "{searchQuery}"</p>
					</div>
				{:else}
					{#each searchResults as item}
						{@const subscribed = isSubscribed(item.trackId)}
						{@const localPodcast = podcastData.podcasts.find(p => p.itunesId === item.trackId)}
						<div class="tap-feedback list-row-surface flex items-center gap-3 p-4 border-b transition-colors cursor-pointer {listTileToneClasses.usesTint ? listTileToneClasses.rowClass : 'hover:bg-accent/40 active:bg-accent/60'}"
							role="button" tabindex="0"
							onclick={() => localPodcast && podcastLibrary.openPodcast(localPodcast)}
							onkeydown={(e) => e.key === 'Enter' && localPodcast && podcastLibrary.openPodcast(localPodcast)}
						>
							{#if item.artworkUrl600}
								<img src={item.artworkUrl600} alt={item.trackName} loading="lazy" decoding="async" width="52" height="52"
									class="w-[52px] h-[52px] rounded-xl object-cover shrink-0" />
							{:else}
								<div class="w-[52px] h-[52px] rounded-xl bg-gradient-to-br from-cyan-500 to-blue-600 flex items-center justify-center text-2xl shrink-0">
									🎙
								</div>
							{/if}
							<div class="flex-1 min-w-0">
								<p class="font-semibold text-[0.95rem] leading-tight truncate">{item.trackName}</p>
								<p class="text-xs text-muted-foreground">{item.artistName}</p>
								<Badge variant="outline" class="mt-1 text-xs">{item.primaryGenreName}</Badge>
							</div>
							<Button
								variant={subscribed ? 'default' : 'outline'}
								size="sm" class="shrink-0"
								onclick={(e) => {
									e.stopPropagation();
									if (subscribed) {
										const lp = podcastData.podcasts.find(p => p.itunesId === item.trackId);
										if (lp) podcastLibrary.openPodcast(lp);
									} else {
										podcastLibrary.subscribeFromItunes(item);
									}
								}}
							>
								{#if subscribed}
									<CheckCircle2 class="w-3.5 h-3.5 mr-1" /> Subscribed
								{:else}
									<Plus class="w-3.5 h-3.5 mr-1" /> Subscribe
								{/if}
							</Button>
						</div>
					{/each}
					{#if searchResults.length === 0 && !searchLoading && podcastSettings.defaultTab === 'discover'}
						<div class="flex flex-col items-center justify-center py-16 gap-3 text-muted-foreground">
							<Search class="w-10 h-10 opacity-30" />
							<p class="text-sm">Search for podcasts above</p>
						</div>
					{/if}
				{/if}
			{/if}
		</div>
	</div>
{/if}

</div>
