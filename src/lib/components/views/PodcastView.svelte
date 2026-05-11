
<script lang="ts">
	import { env } from '$env/dynamic/public';
	import { Capacitor } from '@capacitor/core';
	import Button from '$lib/components/ui/Button.svelte';
	import Card from '$lib/components/ui/Card.svelte';
	import Badge from '$lib/components/ui/Badge.svelte';
	import { podcastSettings, podcastData } from '$lib/stores/settings.svelte';
	import { mediaEngine, claimAudio, registerAudioSource } from '$lib/stores/mediaEngine.svelte';
	import { driveConfigSync } from '$lib/stores/driveConfigSync.svelte';
	import { addToast } from '$lib/stores/toastStore.svelte';
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
	let isRefreshingAll    = $state(false); // pull-to-refresh: background refresh of all subscribed
	let pullDistance       = $state(0);     // pull-to-refresh: current drag distance (px)
	let listScrollEl       = $state<HTMLElement | null>(null);
	let episodeScrollEl    = $state<HTMLElement | null>(null);
	let episodePullDist    = $state(0);
	let episodesError      = $state<string | null>(null);
	let hasRestoredSelectedPodcast = false;
	const podcastApiBaseUrl = (() => {
		const configuredBaseUrl = env.PUBLIC_RELEASE_BASE_URL?.trim().replace(/\/$/, '');
		if (configuredBaseUrl) return configuredBaseUrl;
		if (Capacitor.isNativePlatform()) {
			return 'https://mobile-media-app-maverock24.netlify.app';
		}
		return '';
	})();
	const useHostedPodcastProxy = podcastApiBaseUrl.length > 0;

	// AbortController for in-flight loadEpisodes (TASK-2.1: prevents race conditions)
	let episodeLoadController: AbortController | null = null;
	let episodeLoadPodcastId: number | null = null;

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

	function claimPodcastControls() {
		if (typeof mediaEngine.setPlaybackHandlers === 'function') {
			mediaEngine.setPlaybackHandlers(
				() => { togglePlay(); },
				() => { togglePlay(); },
				(pos) => { handleSeekSeconds(pos); }
			);
		}

		if (typeof mediaEngine.setSkipHandlers === 'function') {
			mediaEngine.setSkipHandlers(
				() => { nextEpisode(); },
				() => { prevEpisode(); }
			);
		}
	}

	// ── Network-loss auto-resume ─────────────────────────────────
	// When a MEDIA_ERR_NETWORK error fires (or the stream stalls while offline),
	// we save the URL + position and listen for the 'online' event. Once the
	// connection returns we reload the stream and seek back to where it stopped.
	let _reconnectListener: (() => void) | null = null;

	function cancelNetworkRetry() {
		if (_reconnectListener) {
			window.removeEventListener('online', _reconnectListener);
			_reconnectListener = null;
		}
	}

	function scheduleReconnectResume(url: string, positionSec: number) {
		cancelNetworkRetry(); // replace any previous pending retry
		_reconnectListener = () => {
			cancelNetworkRetry();
			if (!currentEpisode || !audioEl) return;
			audioEl.src = url;
			if (positionSec > 1) {
				audioEl.addEventListener('loadedmetadata', () => {
					if (audioEl.currentTime < positionSec) audioEl.currentTime = positionSec;
				}, { once: true });
			}
			claimAudio('podcast');
			isBuffering = true;
			audioEl.play().catch((err) => {
				isBuffering = false;
				if (err?.name !== 'AbortError') {
					addToast({ message: 'Reconnected but failed to resume. Tap play to retry.', type: 'warning', autoDismissMs: 5000 });
				}
			});
		};
		window.addEventListener('online', _reconnectListener);
	}

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
			isBuffering = false;
			// MEDIA_ERR_NETWORK (2): stream interrupted by a connectivity drop.
			// Register an 'online' listener to automatically resume from the same position.
			if (err?.code === 2 && currentEpisode) {
				scheduleReconnectResume(audioEl.src, audioEl.currentTime);
				addToast({ message: 'Connection lost — will resume when reconnected.', type: 'warning', autoDismissMs: 6000 });
			} else {
				console.error('[Podcast] audio error:', err?.code, err?.message, 'url:', audioEl.src);
			}
		};
		// stalled = browser requested audio data but received nothing (common on network drop).
		// Only treat it as a connectivity loss when the device reports it is offline.
		const onStalled = () => {
			if (!navigator.onLine && currentEpisode && !_reconnectListener) {
				scheduleReconnectResume(audioEl.src, audioEl.currentTime);
				addToast({ message: 'Connection lost — will resume when reconnected.', type: 'warning', autoDismissMs: 6000 });
			}
		};
		audioEl.addEventListener('timeupdate',     onTimeUpdate);
		audioEl.addEventListener('loadedmetadata', onLoadedMetadata);
		audioEl.addEventListener('play',    onPlay);
		audioEl.addEventListener('pause',   onPause);
		audioEl.addEventListener('ended',   onEnded);
		audioEl.addEventListener('error',   onError);
		audioEl.addEventListener('waiting', onWaiting);
		audioEl.addEventListener('playing', onPlaying);
		audioEl.addEventListener('stalled', onStalled);
		return () => {
			audioEl?.removeEventListener('timeupdate',     onTimeUpdate);
			audioEl?.removeEventListener('loadedmetadata', onLoadedMetadata);
			audioEl?.removeEventListener('play',    onPlay);
			audioEl?.removeEventListener('pause',   onPause);
			audioEl?.removeEventListener('ended',   onEnded);
			audioEl?.removeEventListener('error',   onError);
			audioEl?.removeEventListener('waiting', onWaiting);
			audioEl?.removeEventListener('playing', onPlaying);
			audioEl?.removeEventListener('stalled', onStalled);
			cancelNetworkRetry();
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

	// ── Pull-to-refresh: non-passive touchmove so we can call preventDefault ──
	const PULL_THRESHOLD = 64;
	$effect(() => {
		const el = listScrollEl;
		if (!el) return;
		let _startY = 0;
		let _active = false;

		function onTouchStart(e: TouchEvent) {
			if ((el as HTMLElement).scrollTop === 0) {
				_active = true;
				_startY = e.touches[0].clientY;
			}
		}
		function onTouchMove(e: TouchEvent) {
			if (!_active) return;
			const dy = e.touches[0].clientY - _startY;
			if (dy > 0) {
				pullDistance = Math.min(dy * 0.45, PULL_THRESHOLD + 20);
				e.preventDefault();
			} else {
				_active = false;
				pullDistance = 0;
			}
		}
		function onTouchEnd() {
			if (!_active) return;
			const triggered = pullDistance >= PULL_THRESHOLD;
			_active = false;
			pullDistance = 0;
			if (triggered) void refreshAllSubscribed();
		}

		el.addEventListener('touchstart', onTouchStart, { passive: true });
		el.addEventListener('touchmove',  onTouchMove,  { passive: false });
		el.addEventListener('touchend',   onTouchEnd,   { passive: true });
		return () => {
			el.removeEventListener('touchstart', onTouchStart);
			el.removeEventListener('touchmove',  onTouchMove);
			el.removeEventListener('touchend',   onTouchEnd);
		};
	});

	// ── Pull-to-refresh for the episode list ────────────────────
	$effect(() => {
		const el = episodeScrollEl;
		if (!el) return;
		let _startY = 0;
		let _active = false;
		function onTouchStart(e: TouchEvent) {
			if ((el as HTMLElement).scrollTop === 0) {
				_active = true;
				_startY = e.touches[0].clientY;
			}
		}
		function onTouchMove(e: TouchEvent) {
			if (!_active) return;
			const dy = e.touches[0].clientY - _startY;
			if (dy > 0) {
				episodePullDist = Math.min(dy * 0.45, PULL_THRESHOLD + 20);
				e.preventDefault();
			} else {
				_active = false;
				episodePullDist = 0;
			}
		}
		function onTouchEnd() {
			if (!_active) return;
			const triggered = episodePullDist >= PULL_THRESHOLD;
			_active = false;
			episodePullDist = 0;
			if (triggered && selectedPodcast) void loadEpisodes(selectedPodcast, true);
		}
		el.addEventListener('touchstart', onTouchStart, { passive: true });
		el.addEventListener('touchmove',  onTouchMove,  { passive: false });
		el.addEventListener('touchend',   onTouchEnd,   { passive: true });
		return () => {
			el.removeEventListener('touchstart', onTouchStart);
			el.removeEventListener('touchmove',  onTouchMove);
			el.removeEventListener('touchend',   onTouchEnd);
		};
	});

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

	// ── RSS feed cache (in-memory, 30-min TTL) ───────────────────
	const RSS_CACHE_TTL = 30 * 60 * 1000;
	const rssCache = new Map<string, { data: Record<string, unknown>; ts: number }>();
	function resolvePodcastApiUrl(path: string): string {
		if (/^https?:\/\//i.test(path)) {
			return path;
		}

		if (!podcastApiBaseUrl) {
			return path;
		}

		return `${podcastApiBaseUrl}${path.startsWith('/') ? path : `/${path}`}`;
	}

	async function readPodcastJson<T>(requestUrl: string, signal?: AbortSignal): Promise<T> {
		const response = await fetch(requestUrl, { signal });
		if (!response.ok) {
			let message = `Podcast request failed: HTTP ${response.status}`;
			try {
				const payload = await response.json() as Record<string, unknown>;
				if (typeof payload.error === 'string') {
					message = payload.error;
				} else if (typeof payload.message === 'string') {
					message = payload.message;
				}
			} catch {
				// Fall back to the status-derived message when the response has no JSON body.
			}
			throw new Error(message);
		}

		return await response.json() as T;
	}

	function describePodcastRequestError(error: unknown, fallback: string): string {
		if (error instanceof Error) {
			if (/failed to fetch|fetch failed/i.test(error.message)) {
				return fallback;
			}
			return error.message;
		}
		return fallback;
	}

	async function fetchRss(feedUrl: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
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
		const requestUrl = useHostedPodcastProxy
			? resolvePodcastApiUrl(`/api/podcast/feed?url=${encodeURIComponent(feedUrl)}`)
			: `https://api.rss2json.com/v1/api.json?rss_url=${encodeURIComponent(feedUrl)}`;
		const data = await readPodcastJson<Record<string, unknown>>(requestUrl, signal);
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
		if (parts.some(isNaN)) return 0;
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
			const requestUrl = useHostedPodcastProxy
				? resolvePodcastApiUrl(`/api/podcast/search?q=${encodeURIComponent(q)}`)
				: `https://itunes.apple.com/search?term=${encodeURIComponent(q)}&media=podcast&entity=podcast&limit=20`;
			const data = await readPodcastJson<{ results?: ItunesResult[] }>(requestUrl);
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
		if (podcastSettings.defaultTab === 'discover' && searchResults.length === 0 && !searchQuery && !searchLoading) {
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
		// TASK-2.5: Abort any in-flight episode load for this podcast
		if (episodeLoadPodcastId === podcast.id) {
			episodeLoadController?.abort();
			episodeLoadController = null;
			episodeLoadPodcastId = null;
		}
		podcastData.podcasts = podcastData.podcasts.map(p => p.id === podcast.id ? { ...p, subscribed: false } : p);
		// Re-sync selectedPodcast so the subscribe toggle reflects the new state immediately
		if (selectedPodcast?.id === podcast.id) {
			selectedPodcast = podcastData.podcasts.find(p => p.id === podcast.id) ?? selectedPodcast;
		}
	}

	function deletePodcast(id: number) {
		podcastData.podcasts = podcastData.podcasts.filter(p => p.id !== id);
		if (selectedPodcast?.id === id) selectedPodcast = null;
	}

	// ── Background refresh for all subscribed podcasts (pull-to-refresh) ──────
	async function refreshPodcastSilent(podcast: Podcast): Promise<void> {
		const controller = new AbortController();
		const signal = controller.signal;
		try {
			let p = podcast;
			if (!p.feedUrl) {
				const lookupUrl = useHostedPodcastProxy
					? resolvePodcastApiUrl(`/api/podcast/lookup?id=${p.itunesId}`)
					: `https://itunes.apple.com/lookup?id=${p.itunesId}`;
				const luData = await readPodcastJson<{ results?: Array<Record<string, unknown>> }>(lookupUrl, signal);
				const r = luData.results?.[0];
				const resolvedFeedUrl = typeof r?.feedUrl === 'string' ? r.feedUrl : '';
				if (!resolvedFeedUrl) return;
				p = { ...p, feedUrl: resolvedFeedUrl };
				podcastData.podcasts = podcastData.podcasts.map(pd => pd.id === p.id ? p : pd);
			}
			rssCache.delete(p.feedUrl);
			const data = await fetchRss(p.feedUrl, signal);
			if (data.status !== 'ok') return;
			const eps: Episode[] = ((data.items as Record<string, unknown>[]) ?? []).map(
				(item: Record<string, unknown>, i: number) => {
					const enc = item.enclosure as { link?: string } | null;
					const rawDur = item.itunes_duration ?? item.duration ?? 0;
					return {
						id:          `${p.itunesId}-${i}`,
						title:       String(item.title ?? 'Untitled'),
						description: String(item.description ?? item.content ?? '').replace(/<[^>]+>/g, '').trim().slice(0, 200),
						duration:    parseDuration(rawDur as string | number),
						positionSec: 0,
						publishedAt: String(item.pubDate ?? ''),
						played:      false,
						progress:    0,
						audioUrl:    enc?.link ?? (String(item.link ?? '').match(/\.(mp3|m4a|ogg|aac|wav|flac)(\?|$)/i) ? String(item.link) : ''),
					};
				}
			);
			const existingMap = new Map(
				(podcastData.podcasts.find(pd => pd.id === p.id)?.episodes ?? []).map(e => [e.id, e])
			);
			const mergedEps = eps.map(ep => {
				const existing = existingMap.get(ep.id);
				return existing
					? { ...ep, played: existing.played, progress: existing.progress, positionSec: existing.positionSec }
					: ep;
			});
			podcastData.podcasts = podcastData.podcasts.map(pd =>
				pd.id === p.id ? { ...pd, episodes: mergedEps, episodesLoaded: true } : pd
			);
			if (selectedPodcast?.id === p.id) {
				selectedPodcast = podcastData.podcasts.find(pd => pd.id === p.id) ?? selectedPodcast;
			}
		} catch {
			// Silent — individual podcast failures don't block the rest
		}
	}

	async function refreshAllSubscribed(): Promise<void> {
		if (isRefreshingAll) return;
		const toRefresh = subscribedPodcasts.slice(); // snapshot before async work
		if (toRefresh.length === 0) return;
		isRefreshingAll = true;
		try {
			for (const podcast of toRefresh) {
				await refreshPodcastSilent(podcast);
			}
		} finally {
			isRefreshingAll = false;
			driveConfigSync.scheduleSave();
		}
	}

	// ── Load episodes from RSS2JSON ──────────────────────────────
	async function loadEpisodes(podcast: Podcast, force = false) {
		if (!force && podcast.episodesLoaded) return;
		// Abort any previous in-flight load (TASK-2.1: race condition fix)
		episodeLoadController?.abort();
		const controller = new AbortController();
		episodeLoadController = controller;
		episodeLoadPodcastId = podcast.id;
		const signal = controller.signal;
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
				const lookupUrl = useHostedPodcastProxy
					? resolvePodcastApiUrl(`/api/podcast/lookup?id=${podcast.itunesId}`)
					: `https://itunes.apple.com/lookup?id=${podcast.itunesId}`;
				const luData = await readPodcastJson<{ results?: Array<Record<string, unknown>> }>(lookupUrl, signal);
				const r = luData.results?.[0];
				const resolvedFeedUrl = typeof r?.feedUrl === 'string' ? r.feedUrl : '';
				const resolvedArtworkUrl = typeof r?.artworkUrl600 === 'string' ? r.artworkUrl600 : '';
				if (!resolvedFeedUrl) {
					episodesError = 'No RSS feed available for this podcast.';
					return;
				}
				podcast = { ...podcast, feedUrl: resolvedFeedUrl, artworkUrl: podcast.artworkUrl || resolvedArtworkUrl };
				podcastData.podcasts = podcastData.podcasts.map(p => p.id === podcast.id ? podcast : p);
				if (selectedPodcast?.id === podcast.id) {
					selectedPodcast = podcastData.podcasts.find(p => p.id === podcast.id) ?? selectedPodcast;
				}
			}
			const data = await fetchRss(podcast.feedUrl, signal) as Record<string, unknown>;
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
			// Ignore aborted requests (TASK-2.1: user navigated away or new load started)
			if (signal.aborted) return;
			const msg = describePodcastRequestError(e, 'Unable to load this podcast right now. Please try again.');
			// Suppress errors on background refresh — episodes already shown
			if (!force || !podcast.episodesLoaded) {
				episodesError = msg;
			}
			// TASK-2.4: Show toast with retry action
			addToast({
				message: msg,
				type: 'error',
				action: { label: 'Retry', handler: () => loadEpisodes(podcast, true) },
				autoDismissMs: 8000
			});
		} finally {
			if (!signal.aborted) {
				episodesLoading = false;
				episodesRefreshing = false;
			}
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
	function getEpisodeResumePosition(episode: Episode): number {
		const savedPosition = episode.positionSec ?? 0;
		if (episode.id !== podcastData.lastEpisodeId) {
			return savedPosition;
		}

		return Math.max(savedPosition, podcastData.lastPositionSec);
	}

	function syncEpisodeAudioSource(podcast: Podcast, episode: Episode, resumeAt: number) {
		audioEl.playbackRate = podcastSettings.playbackSpeed;
		if (audioEl.src !== episode.audioUrl) {
			audioEl.src = episode.audioUrl;
			if (resumeAt > 10) {
				audioEl.addEventListener('loadedmetadata', () => {
					if (currentEpisode?.episode.id !== episode.id) return;
					audioEl.currentTime = resumeAt;
					currentTime = resumeAt;
				}, { once: true });
			}
		}

		mediaEngine.setNowPlaying({
			id:         episode.id,
			source:     'podcast',
			title:      episode.title,
			subtitle:   podcast.title,
			audioUrl:   episode.audioUrl,
			artworkUrl: podcast.artworkUrl,
			duration:   episode.duration
		}, 'podcast');
		claimPodcastControls();
	}

	function playEpisode(podcast: Podcast, episode: Episode) {
		if (!episode.audioUrl) {
			addToast({ message: 'This episode has no playable audio URL.', type: 'error' });
			return;
		}
		cancelNetworkRetry(); // clear any pending retry for the previous episode
		podcastSettings.playbackSpeed = 1.0; // reset speed for each new episode so the 1.5x button is off by default
		claimAudio('podcast');
		currentEpisode = { podcast, episode };
		const resumeAt = getEpisodeResumePosition(episode);
		duration = episode.duration;
		currentTime = resumeAt > 10 ? resumeAt : 0;
		syncEpisodeAudioSource(podcast, episode, resumeAt);
		isBuffering = true;
		audioEl.play().catch((err) => {
			isBuffering = false;
			if (err?.name !== 'AbortError') {
				console.error('[Podcast] play() failed:', err, 'url:', episode.audioUrl);
				addToast({ message: `Playback failed: ${err?.message ?? 'Unknown error'}`, type: 'error' });
			}
		});
	}

	function activateEpisode(podcast: Podcast, episode: Episode) {
		if (currentEpisode?.episode.id === episode.id) {
			togglePlay();
			return;
		}

		playEpisode(podcast, episode);
	}

	function togglePlay() {
		if (!audioEl || !currentEpisode) return;
		if (isPlaying) {
			cancelNetworkRetry(); // user deliberately paused — no auto-resume
			audioEl.pause();
		} else {
			claimAudio('podcast');
			syncEpisodeAudioSource(
				currentEpisode.podcast,
				currentEpisode.episode,
				getEpisodeResumePosition(currentEpisode.episode)
			);
			audioEl.play().catch((err) => {
				if (err?.name !== 'AbortError') {
					console.error('[Podcast] togglePlay() failed:', err);
				}
			});
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
		openPodcast(pod);
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
		claimPodcastControls();
		mediaEngine.updateTime(resumeAt, ep.duration);
		mediaEngine.setPlaying(false);
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
		<div class="flex-1 overflow-y-auto" bind:this={episodeScrollEl}>
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
					<div
						class="tap-feedback p-4 border-b hover:bg-accent/40 active:bg-accent/60 transition-colors cursor-pointer"
						role="button"
						tabindex="0"
						onclick={() => selectedPodcast && activateEpisode(selectedPodcast, episode)}
						onkeydown={(event) => {
							if (event.key !== 'Enter' && event.key !== ' ') return;
							event.preventDefault();
							if (selectedPodcast) activateEpisode(selectedPodcast, episode);
						}}
					>
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
								class="shrink-0 w-11 h-11 rounded-full"
								onclick={(event) => {
									event.stopPropagation();
									if (selectedPodcast) {
										activateEpisode(selectedPodcast, episode);
									}
								}}
							>
								{#if currentEpisode?.episode.id === episode.id && isBuffering}
									<div class="w-5 h-5 border-2 border-current border-t-transparent rounded-full animate-spin"></div>
								{:else if currentEpisode?.episode.id === episode.id && isPlaying}
									<Pause class="w-5 h-5" />
								{:else}
									<Play class="w-5 h-5 ml-0.5" />
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

		<div class="flex-1 overflow-y-auto" bind:this={listScrollEl}>
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
					<div class="tap-feedback flex items-center gap-3 p-4 border-b hover:bg-accent/40 active:bg-accent/60 transition-colors cursor-pointer"
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
						<div class="tap-feedback flex items-center gap-3 p-4 border-b hover:bg-accent/40 active:bg-accent/60 transition-colors cursor-pointer"
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

</div>
