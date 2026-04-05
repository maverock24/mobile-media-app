
<script lang="ts">
	import Button from '$lib/components/ui/Button.svelte';
	import Card from '$lib/components/ui/Card.svelte';
	import Badge from '$lib/components/ui/Badge.svelte';
	import PlayerControls from '$lib/components/PlayerControls.svelte';
	import { podcastSettings, podcastData } from '$lib/stores/settings.svelte';
	import { claimAudio, registerAudioSource } from '$lib/stores/activeAudio.svelte';
	import { mediaEngine } from '$lib/stores/mediaEngine.svelte';
	import { driveConfigSync } from '$lib/stores/driveConfigSync.svelte';
	import {
		Plus, Trash2, Play, Pause,
		Rss, Clock, CheckCircle2, ChevronLeft, Search,
		RefreshCw, Mic2, X
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
	interface ItunesResult {
		trackId:          number;
		trackName:        string;
		artistName:       string;
		artworkUrl600:    string;
		feedUrl:          string;
		primaryGenreName: string;
		trackCount:       number;
	}

	// ── Podcast list — backed by persisted store ──
	// podcastData.podcasts / podcastData.nextId survive refreshes via localStorage

	// ── UI state ─────────────────────────────────────────────────
	let selectedPodcast    = $state<Podcast | null>(null);
	let searchQuery        = $state('');
	let searchResults      = $state<ItunesResult[]>([]);
	let searchLoading      = $state(false);
	let episodesLoading    = $state(false);
	let episodesRefreshing = $state(false); // background refresh while episodes already shown
	let episodesError      = $state<string | null>(null);

	// ── Playback state ───────────────────────────────────────────
	let currentEpisode = $state<{ podcast: Podcast; episode: Episode } | null>(null);
	let isPlaying      = $state(false);
	let isBuffering    = $state(false);
	let currentTime    = $state(0);
	let duration       = $state(0);
	let audioEl: HTMLAudioElement;

	// ── Register stop-callback ───────────────────────────────────
	$effect(() => {
		registerAudioSource('podcast', () => {
			if (audioEl && isPlaying) audioEl.pause();
		});
	});

	// ── Register MediaSession play/pause/seek handlers for lock-screen ──
	$effect(() => {
		// Guard: methods may not be accessible if the $state proxy wraps them
		if (typeof mediaEngine.setPlaybackHandlers !== 'function') return;
		mediaEngine.setPlaybackHandlers(
			() => togglePlay(),
			() => togglePlay(),
			(pos) => { if (audioEl) { audioEl.currentTime = pos; currentTime = pos; } }
		);
		return () => {
			if (typeof mediaEngine.setPlaybackHandlers === 'function')
				mediaEngine.setPlaybackHandlers(null, null, null);
		};
	});

	// ── Audio element event wiring ───────────────────────────────
	$effect(() => {
		if (!audioEl) return;
		// Throttle timeupdate to ~4Hz — smooth for seek bar, 15× less CPU than 60fps
		let _lastTimeUpdate = 0;
		const onTimeUpdate = () => {
			const now = Date.now();
			if (now - _lastTimeUpdate < 250) return;
			_lastTimeUpdate = now;
			currentTime = audioEl.currentTime;
			mediaEngine.updateTime(audioEl.currentTime, audioEl.duration);
			if (currentEpisode && duration > 0) {
				currentEpisode.episode.progress = Math.min(100, Math.round((audioEl.currentTime / duration) * 100));
				currentEpisode.episode.positionSec = audioEl.currentTime;
			}
		};
		const onLoadedMetadata = () => {
			duration = isFinite(audioEl.duration) ? audioEl.duration : 0;
			mediaEngine.updateTime(audioEl.currentTime, audioEl.duration);
		};
		const onPlay  = () => { isPlaying = true;  isBuffering = false; mediaEngine.setPlaying(true);  };
		const onPause = () => { isPlaying = false; mediaEngine.setPlaying(false); };
		const onWaiting  = () => { isBuffering = true; };
		const onPlaying  = () => { isBuffering = false; };
		const onEnded = () => {
			isPlaying = false;
			isBuffering = false;
			mediaEngine.setPlaying(false);
			if (currentEpisode) {
				currentEpisode.episode.played = true;
				currentEpisode.episode.progress = 100;
				currentEpisode.episode.positionSec = 0;
			}
		};
		const onError = () => {
			const err = audioEl.error;
			console.error('[Podcast] audio error:', err?.code, err?.message, 'url:', audioEl.src);
			isBuffering = false;
		};
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

	// ── Sync playback speed ──────────────────────────────────────
	$effect(() => { if (audioEl) audioEl.playbackRate = podcastSettings.playbackSpeed; });

	// ── Auto-save podcast data to Drive when subscriptions/progress change ──
	$effect(() => {
		void podcastData.podcasts;
		void podcastData.lastEpisodeId;
		void podcastData.lastPositionSec;
		driveConfigSync.scheduleSave();
	});

	// ── Derived ─────────────────────────────────────────────────
	const subscribedPodcasts = $derived(podcastData.podcasts.filter(p => p.subscribed));

	// ── RSS feed cache (in-memory, 30-min TTL) ───────────────────
	const RSS_CACHE_TTL = 30 * 60 * 1000;
	const rssCache = new Map<string, { data: unknown; ts: number }>();
	async function fetchRss(feedUrl: string): Promise<unknown> {
		// Validate that the feed URL is a legitimate HTTP(S) address
		try {
			const parsed = new URL(feedUrl);
			if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
				throw new Error('Feed URL must use HTTP or HTTPS.');
			}
		} catch (e) {
			throw new Error('Invalid feed URL.');
		}
		const cached = rssCache.get(feedUrl);
		if (cached && Date.now() - cached.ts < RSS_CACHE_TTL) return cached.data;
		const res = await fetch(`https://api.rss2json.com/v1/api.json?rss_url=${encodeURIComponent(feedUrl)}`);
		const data = await res.json();
		if (data.status === 'ok') rssCache.set(feedUrl, { data, ts: Date.now() });
		return data;
	}

	// ── Helpers ─────────────────────────────────────────────────
	function formatTime(seconds: number): string {
		if (!seconds || seconds < 0) return '–';
		const h = Math.floor(seconds / 3600);
		const m = Math.floor((seconds % 3600) / 60);
		const s = Math.floor(seconds % 60);
		if (h > 0) return `${h}h ${m}m`;
		return `${m}:${s.toString().padStart(2, '0')}`;
	}
	function formatDate(dateStr: string): string {
		if (!dateStr) return '';
		const d = new Date(dateStr);
		if (isNaN(d.getTime())) return '';
		return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
	}
	function parseDuration(dur: string | number): number {
		if (typeof dur === 'number') return dur;
		if (!dur) return 0;
		const parts = String(dur).split(':').map(Number);
		if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
		if (parts.length === 2) return parts[0] * 60 + parts[1];
		return parts[0] || 0;
	}
	function artworkFallback(podcast: Podcast): string {
		// Use a nice gradient placeholder if no artwork
		const colors = [
			'from-indigo-500 to-purple-600',
			'from-cyan-500 to-blue-600',
			'from-emerald-500 to-teal-600',
			'from-orange-500 to-pink-600',
		];
		return colors[podcast.id % colors.length];
	}

	// ── iTunes Search ────────────────────────────────────────────
	async function searchITunes(q: string) {
		if (q.length < 2) { searchResults = []; return; }
		searchLoading = true;
		try {
			const res = await fetch(
				`https://itunes.apple.com/search?term=${encodeURIComponent(q)}&media=podcast&entity=podcast&limit=20`
			);
			const data = await res.json();
			searchResults = (data.results ?? []) as ItunesResult[];
		} catch { searchResults = []; }
		searchLoading = false;
	}

	// Debounce on subscribed tab / search query
	$effect(() => {
		const q = searchQuery;
		if (!q || q.length < 2) { searchResults = []; return; }
		const t = setTimeout(() => searchITunes(q), 400);
		return () => clearTimeout(t);
	});

	// Preload discover tab popular podcasts
	$effect(() => {
		if (podcastSettings.defaultTab === 'discover' && searchResults.length === 0 && !searchQuery) {
			searchITunes('technology science');
		}
	});

	// ── Subscribe/unsubscribe ────────────────────────────────────
	function subscribeFromItunes(item: ItunesResult) {
		let pod: Podcast;
		if (podcastData.podcasts.some(p => p.itunesId === item.trackId)) {
			// Already in list — just make sure it's subscribed
			podcastData.podcasts = podcastData.podcasts.map(p =>
				p.itunesId === item.trackId ? { ...p, subscribed: true } : p
			);
			pod = podcastData.podcasts.find(p => p.itunesId === item.trackId)!;
		} else {
			pod = {
				id:         ++podcastData.nextId,
				itunesId:   item.trackId,
				title:      item.trackName,
				author:     item.artistName,
				category:   item.primaryGenreName ?? 'Podcast',
				artworkUrl: item.artworkUrl600 ?? '',
				feedUrl:    item.feedUrl ?? '',
				subscribed: true,
				episodes:   [],
				episodesLoaded: false,
			};
			podcastData.podcasts = [...podcastData.podcasts, pod];
		}
		// Auto-open the episode view after subscribing
		openPodcast(pod);
	}

	function unsubscribe(podcast: Podcast) {
		podcastData.podcasts = podcastData.podcasts.map(p => p.id === podcast.id ? { ...p, subscribed: false } : p);
	}

	function deletePodcast(id: number) {
		podcastData.podcasts = podcastData.podcasts.filter(p => p.id !== id);
		if (selectedPodcast?.id === id) selectedPodcast = null;
	}

	// ── Load episodes from RSS2JSON ──────────────────────────────
	async function loadEpisodes(podcast: Podcast, force = false) {
		if (!force && podcast.episodesLoaded) return;
		// Bust the RSS cache on manual force-refresh so we always get fresh data
		if (force && podcast.feedUrl) rssCache.delete(podcast.feedUrl);
		// Background refresh: show subtle spinner without blocking the episode list
		if (force && podcast.episodesLoaded) {
			episodesRefreshing = true;
		} else {
			episodesLoading = true;
		}
		episodesError = null;
		try {
			if (!podcast.feedUrl) {
				// Resolve feedUrl via iTunes lookup (no &entity param — gets the podcast object)
				const lu = await fetch(
					`https://itunes.apple.com/lookup?id=${podcast.itunesId}`
				);
				const luData = await lu.json();
				const r = luData.results?.[0];
				if (!r?.feedUrl) {
					episodesError = 'No RSS feed available for this podcast.';
					return;
				}
				podcast = { ...podcast, feedUrl: r.feedUrl, artworkUrl: podcast.artworkUrl || r.artworkUrl600 || '' };
				podcastData.podcasts = podcastData.podcasts.map(p => p.id === podcast.id ? podcast : p);
				if (selectedPodcast?.id === podcast.id) {
					selectedPodcast = podcastData.podcasts.find(p => p.id === podcast.id) ?? selectedPodcast;
				}
			}
			const data = await fetchRss(podcast.feedUrl) as Record<string, unknown>;
			if (data.status !== 'ok') throw new Error(data.message as string ?? 'RSS error');
			const eps: Episode[] = ((data.items as Record<string, unknown>[]) ?? []).map((item: Record<string, unknown>, i: number) => {
				const enc = item.enclosure as { link?: string; length?: number } | null;
				// itunes_duration is a string like "1:23:45" or seconds as number
				const rawDur = item.itunes_duration ?? item.duration ?? 0;
				return {
			// prefix with itunesId so IDs are unique across podcasts
				id:          `${podcast.itunesId}-${i}`,
				title:       String(item.title ?? 'Untitled'),
				description: String(item.description ?? item.content ?? '').replace(/<[^>]+>/g, '').trim().slice(0, 200),
				duration:    parseDuration(rawDur as string | number),
				positionSec: 0,
					publishedAt: String(item.pubDate ?? ''),
					played:      false,
					progress:    0,
					audioUrl:    enc?.link ?? (String(item.link ?? '').match(/\.(mp3|m4a|ogg|aac|wav|flac)(\?|$)/i) ? String(item.link) : ''),
				};
			});
			const feedImage = typeof (data.feed as Record<string, unknown> | undefined)?.image === 'string'
				? (data.feed as Record<string, unknown>).image as string
				: '';
			// Merge: preserve played/progress/positionSec from already-known episodes
			const existingMap = new Map(
				(podcastData.podcasts.find(p => p.id === podcast.id)?.episodes ?? []).map(e => [e.id, e])
			);
			const mergedEps = eps.map(ep => {
				const existing = existingMap.get(ep.id);
				return existing
					? { ...ep, played: existing.played, progress: existing.progress, positionSec: existing.positionSec }
					: ep;
			});
			podcastData.podcasts = podcastData.podcasts.map(p =>
				p.id === podcast.id
					? { ...p, episodes: mergedEps, episodesLoaded: true, artworkUrl: p.artworkUrl || feedImage }
					: p
			);
			if (selectedPodcast?.id === podcast.id) {
				selectedPodcast = podcastData.podcasts.find(p => p.id === podcast.id) ?? selectedPodcast;
			}
		} catch (e: unknown) {
			// Suppress errors on background refresh — episodes already shown
			if (!force || !podcast.episodesLoaded) {
				episodesError = e instanceof Error ? e.message : 'Failed to load episodes.';
			}
		} finally {
			episodesLoading = false;
			episodesRefreshing = false;
		}
	}

	function openPodcast(podcast: Podcast) {
		selectedPodcast = podcast;
		episodesError = null;
		if (!podcast.episodesLoaded) {
			loadEpisodes(podcast);
		} else {
			// Episodes cached — check for newer ones in the background
			loadEpisodes(podcast, true);
		}
	}

	// ── Playback ─────────────────────────────────────────────────
	function playEpisode(podcast: Podcast, episode: Episode) {
		if (!episode.audioUrl) return;
		claimAudio('podcast');
		currentEpisode = { podcast, episode };
		duration = episode.duration;
		currentTime = 0;
		audioEl.src = episode.audioUrl;
		audioEl.playbackRate = podcastSettings.playbackSpeed;
		// Do NOT call audioEl.load() — calling load() then play() immediately causes
		// an AbortError ("play() request was interrupted by a new load request") in
		// Chromium/Android WebView when the src is a remote URL.  Setting src and
		// calling play() directly is sufficient; the browser handles loading internally.
		const resumeAt = (episode.positionSec ?? 0) > 10
			? episode.positionSec
			: Math.round((episode.progress / 100) * (episode.duration || 0));
		if (resumeAt > 10) {
			audioEl.addEventListener('loadedmetadata', () => { audioEl.currentTime = resumeAt; }, { once: true });
		}
		isBuffering = true;
		audioEl.play().catch((err) => {
			isBuffering = false;
			console.error('[Podcast] play() failed:', err, 'url:', episode.audioUrl);
		});
		mediaEngine.setNowPlaying({
			id:         episode.id,
			source:     'podcast',
			title:      episode.title,
			subtitle:   podcast.title,
			audioUrl:   episode.audioUrl,
			artworkUrl: podcast.artworkUrl,
			duration:   episode.duration
		}, 'podcast');
	}

	function togglePlay() {
		if (!audioEl || !currentEpisode) return;
		if (isPlaying) {
			audioEl.pause();
		} else {
			claimAudio('podcast');
			audioEl.play().catch((err) => { console.error('[Podcast] togglePlay() failed:', err); });
		}
	}

	function prevEpisode() {
		if (!currentEpisode) return;
		const podcast = podcastData.podcasts.find(p => p.id === currentEpisode!.podcast.id);
		if (!podcast) return;
		const eps = podcast.episodes;
		const idx = eps.findIndex(e => e.id === currentEpisode!.episode.id);
		if (idx > 0) playEpisode(podcast, eps[idx - 1]);
	}

	function nextEpisode() {
		if (!currentEpisode) return;
		const podcast = podcastData.podcasts.find(p => p.id === currentEpisode!.podcast.id);
		if (!podcast) return;
		const eps = podcast.episodes;
		const idx = eps.findIndex(e => e.id === currentEpisode!.episode.id);
		if (idx >= 0 && idx < eps.length - 1) playEpisode(podcast, eps[idx + 1]);
	}

	function handleSeekSeconds(seconds: number) {
		currentTime = seconds;
		if (audioEl) audioEl.currentTime = seconds;
	}

	function handleSeek(e: Event) {
		const input = e.target as HTMLInputElement;
		const newTime = (parseFloat(input.value) / 100) * duration;
		currentTime = newTime;
		if (audioEl) audioEl.currentTime = newTime;
	}


	// ── Persist position on pause / end; sync episode progress into the store ──
	$effect(() => {
		if (!audioEl) return;
		const onPause = () => {
			if (!currentEpisode) return;
			podcastData.lastEpisodeId   = currentEpisode.episode.id;
			podcastData.lastPodcastId   = currentEpisode.podcast.id;
			podcastData.lastPositionSec = audioEl.currentTime;
			// Update only the target episode in-place to avoid cloning the whole array
			const pod = podcastData.podcasts.find(p => p.id === currentEpisode!.podcast.id);
			const ep  = pod?.episodes.find(e => e.id === currentEpisode!.episode.id);
			if (ep) {
				ep.played      = currentEpisode.episode.played;
				ep.progress    = currentEpisode.episode.progress;
				ep.positionSec = currentEpisode.episode.positionSec ?? 0;
			}
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
		if (!podcastData.lastEpisodeId || podcastData.lastPodcastId < 0) return;
		const pod = podcastData.podcasts.find(p => p.id === podcastData.lastPodcastId);
		if (!pod) return;
		const ep = pod.episodes.find(e => e.id === podcastData.lastEpisodeId);
		if (!ep) return;
		currentEpisode = { podcast: pod, episode: ep };
		duration = ep.duration;
		currentTime = podcastData.lastPositionSec;
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
		<div class="flex items-center gap-3 p-4 border-b shrink-0">
			<Button variant="ghost" size="icon" onclick={() => (selectedPodcast = null, episodesError = null)}>
				<ChevronLeft class="w-5 h-5" />
			</Button>
			<div class="flex items-center gap-3 flex-1 min-w-0">
				{#if selectedPodcast.artworkUrl}
					<img src={selectedPodcast.artworkUrl} alt={selectedPodcast.title}
						class="w-10 h-10 rounded-lg object-cover shrink-0" />
				{:else}
					<div class="w-10 h-10 rounded-lg bg-gradient-to-br {artworkFallback(selectedPodcast)} flex items-center justify-center shrink-0">
						<Mic2 class="w-5 h-5 text-white" />
					</div>
				{/if}
				<div class="min-w-0">
					<h2 class="font-semibold text-sm truncate">{selectedPodcast.title}</h2>
					<p class="text-xs text-muted-foreground">{selectedPodcast.author}</p>
				</div>
			</div>
			<Button variant="ghost" size="icon"
				title="Refresh episodes"
				disabled={episodesRefreshing || episodesLoading}
				onclick={() => selectedPodcast && loadEpisodes(selectedPodcast, true)}>
				<RefreshCw class="w-5 h-5 {episodesRefreshing ? 'animate-spin' : ''}" />
			</Button>
			<Button variant="ghost" size="icon" onclick={() => {
				if (selectedPodcast) {
					selectedPodcast.subscribed ? unsubscribe(selectedPodcast) : subscribeFromItunes({ trackId: selectedPodcast.itunesId, trackName: selectedPodcast.title, artistName: selectedPodcast.author, artworkUrl600: selectedPodcast.artworkUrl, feedUrl: selectedPodcast.feedUrl, primaryGenreName: selectedPodcast.category, trackCount: selectedPodcast.episodes.length });
				}
			}}>
				{#if selectedPodcast.subscribed}
					<CheckCircle2 class="w-5 h-5 text-primary" />
				{:else}
					<Plus class="w-5 h-5" />
				{/if}
			</Button>
		</div>

		<!-- Episode list body -->
		<div class="flex-1 overflow-y-auto">
			{#if episodesLoading}
				<div class="flex flex-col items-center justify-center h-40 gap-3">
					<div class="w-8 h-8 border-4 border-primary/30 border-t-primary rounded-full animate-spin"></div>
					<p class="text-sm text-muted-foreground">Loading episodes…</p>
				</div>
			{:else if episodesError}
				<div class="flex flex-col items-center justify-center h-40 gap-3 px-6 text-center">
					<span class="text-3xl">📡</span>
					<p class="text-sm text-muted-foreground">{episodesError}</p>
					<Button variant="outline" size="sm" onclick={() => { if (selectedPodcast) { selectedPodcast.episodesLoaded = false; loadEpisodes(selectedPodcast); } }}>
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
					<div class="p-4 border-b hover:bg-accent/40 transition-colors">
						<div class="flex items-start gap-3">
							<div class="flex-1 min-w-0">
								<div class="flex items-center gap-2 mb-1">
									{#if episode.played}
										<CheckCircle2 class="w-3.5 h-3.5 text-muted-foreground shrink-0" />
									{/if}
									<p class="font-medium text-sm truncate {episode.played ? 'text-muted-foreground' : ''}">
										{episode.title}
									</p>
								</div>
								{#if episode.description}
									<p class="text-xs text-muted-foreground line-clamp-2 mb-2">{episode.description}</p>
								{/if}
								<div class="flex items-center gap-3 text-xs text-muted-foreground">
									{#if episode.duration > 0}
										<span class="flex items-center gap-1">
											<Clock class="w-3 h-3" />{formatTime(episode.duration)}
										</span>
									{/if}
									{#if episode.publishedAt}
										<span>{formatDate(episode.publishedAt)}</span>
									{/if}
								</div>
								{#if episode.progress > 0 && episode.progress < 100}
									<div class="mt-2 h-1 rounded-full bg-secondary overflow-hidden">
										<div class="h-full bg-primary rounded-full" style="width: {episode.progress}%"></div>
									</div>
								{/if}
							</div>
							<Button
								size="icon" variant={currentEpisode?.episode.id === episode.id && (isPlaying || isBuffering) ? 'default' : 'outline'}
								class="shrink-0 w-9 h-9 rounded-full"
								onclick={() => {
									if (currentEpisode?.episode.id === episode.id) {
										togglePlay();
									} else if (selectedPodcast) {
										playEpisode(selectedPodcast, episode);
									}
								}}
							>
								{#if currentEpisode?.episode.id === episode.id && isBuffering}
									<div class="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin"></div>
								{:else if currentEpisode?.episode.id === episode.id && isPlaying}
									<Pause class="w-4 h-4" />
								{:else}
									<Play class="w-4 h-4 ml-0.5" />
								{/if}
							</Button>
						</div>
					</div>
				{/each}
			{/if}
		</div>
	</div>

{:else}
	<!-- ════════════════════════════════ PODCAST LIST ══════════════════════════════ -->
	<div class="flex flex-col flex-1 min-h-0">
		<!-- Search & Tabs header -->
		<div class="p-4 border-b space-y-3 shrink-0">
			<h1 class="text-xl font-bold flex items-center gap-2">
				<Mic2 class="w-6 h-6" /> Podcasts
			</h1>
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

		<div class="flex-1 overflow-y-auto">
			{#if podcastSettings.defaultTab === 'subscribed' && !searchQuery}
				<!-- ── Subscribed List ── -->
				{#each subscribedPodcasts as podcast}
					{@const artGradient = artworkFallback(podcast)}
					<div class="flex items-center gap-3 p-4 border-b hover:bg-accent/40 transition-colors cursor-pointer"
						role="button" tabindex="0"
						onclick={() => openPodcast(podcast)}
						onkeydown={(e) => e.key === 'Enter' && openPodcast(podcast)}
					>
						{#if podcast.artworkUrl}
							<img src={podcast.artworkUrl} alt={podcast.title}
								class="w-13 h-13 rounded-xl object-cover shrink-0 w-[52px] h-[52px]" />
						{:else}
							<div class="w-[52px] h-[52px] rounded-xl bg-gradient-to-br {artGradient} flex items-center justify-center text-2xl shrink-0">
								🎙
							</div>
						{/if}
						<div class="flex-1 min-w-0">
							<p class="font-semibold text-sm truncate">{podcast.title}</p>
							<p class="text-xs text-muted-foreground">{podcast.author}</p>
							<Badge variant="secondary" class="mt-1 text-xs">{podcast.category}</Badge>
						</div>
						<div class="flex flex-col items-end gap-2 shrink-0">
							{#if podcast.episodesLoaded}
								<span class="text-xs text-muted-foreground">{podcast.episodes.length} eps</span>
							{/if}
							<Button variant="ghost" size="icon" class="w-7 h-7 text-destructive hover:text-destructive"
								onclick={(e) => { e.stopPropagation(); deletePodcast(podcast.id); }}>
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
						<div class="flex items-center gap-3 p-4 border-b hover:bg-accent/40 transition-colors cursor-pointer"
							role="button" tabindex="0"
							onclick={() => localPodcast && openPodcast(localPodcast)}
							onkeydown={(e) => e.key === 'Enter' && localPodcast && openPodcast(localPodcast)}
						>
							{#if item.artworkUrl600}
								<img src={item.artworkUrl600} alt={item.trackName}
									class="w-[52px] h-[52px] rounded-xl object-cover shrink-0" />
							{:else}
								<div class="w-[52px] h-[52px] rounded-xl bg-gradient-to-br from-cyan-500 to-blue-600 flex items-center justify-center text-2xl shrink-0">
									🎙
								</div>
							{/if}
							<div class="flex-1 min-w-0">
								<p class="font-semibold text-sm truncate">{item.trackName}</p>
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
										if (lp) openPodcast(lp);
									} else {
										subscribeFromItunes(item);
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

	<!-- ── Now Playing Bar ── -->
	{#if currentEpisode}
		<div class="border-t bg-background shrink-0 pb-safe">
			<!-- Track info row -->
			<div class="flex items-center gap-3 px-4 pt-3 pb-1">
				<div class="shrink-0">
					{#if currentEpisode.podcast.artworkUrl}
						<img src={currentEpisode.podcast.artworkUrl} alt="" class="w-10 h-10 rounded-xl object-cover" />
					{:else}
						<div class="w-10 h-10 rounded-xl bg-gradient-to-br from-cyan-500 to-blue-700 flex items-center justify-center">
							<Mic2 class="w-5 h-5 text-white" />
						</div>
					{/if}
				</div>
				<div class="flex-1 min-w-0">
					<p class="text-sm font-semibold truncate">{currentEpisode.episode.title}</p>
					<p class="text-xs text-muted-foreground truncate">{currentEpisode.podcast.title}</p>
				</div>
			</div>
			<div class="px-4 pb-3">
				<PlayerControls
					isPlaying={isPlaying}
					isBuffering={isBuffering}
					currentTime={currentTime}
					duration={duration}
					showTrackNav={true}
					onPlayToggle={togglePlay}
					onSeek={handleSeekSeconds}
					onPrev={prevEpisode}
					onNext={nextEpisode}
				/>
			</div>
		</div>
	{/if}
</div>
