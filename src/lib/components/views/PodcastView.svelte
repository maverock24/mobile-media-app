
<script lang="ts">
	import { env } from '$env/dynamic/public';
	import { Capacitor } from '@capacitor/core';
	import { marqueeTitle } from '$lib/actions/marqueeTitle';
	import { pullToRefresh, swipeBack } from '$lib/actions/touch';
	import Button from '$lib/components/ui/Button.svelte';
	import Card from '$lib/components/ui/Card.svelte';
	import { triggerPlaybackHaptic, triggerSwipeBackHaptic } from '$lib/native/haptics';
	import Badge from '$lib/components/ui/Badge.svelte';
	import { appSettings, podcastSettings, podcastData } from '$lib/stores/settings.svelte';
	import { mediaEngine, claimAudio, registerAudioSource } from '$lib/stores/mediaEngine.svelte';
	import { driveConfigSync } from '$lib/stores/driveConfigSync.svelte';
	import { addToast } from '$lib/stores/toastStore.svelte';
	import { getListTileToneClasses } from '$lib/utils/listTileTone';
	import { formatDuration } from '$lib/models/music';
	import {
		fetchRss, buildEpisodeId, describePodcastRequestError,
		parseDuration, formatDate, readPodcastJson, clearRssCache,
	} from '$lib/podcast/rss';
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
	let _userPaused = false;

	// ── Register stop-callback ───────────────────────────────────
	$effect(() => {
		registerAudioSource('podcast', () => {
			if (!audioEl) return;
			audioEl.pause();
			// Fully reset so the browser releases the audio channel —
			// pause() alone can leave residual decoder state that
			// causes brief overlap when a new source starts immediately.
			audioEl.removeAttribute('src');
			audioEl.load();
		});
	});

	function claimPodcastControls() {
		if (typeof mediaEngine.setPlaybackHandlers === 'function') {
			mediaEngine.setPlaybackHandlers(
				() => { resumePlayback(); },
				() => { pausePlayback(); },
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

	/** Retry audioEl.play() on AbortError — remote URLs can abort on Android
	 *  WebView when the source isn't ready yet after setting src. */
	function safePlay(onFailure?: () => void) {
		const tryPlay = (attempt: number) => {
			audioEl!.play().catch((err: Error) => {
				if (err?.name === 'AbortError' && attempt < 3) {
					setTimeout(() => tryPlay(attempt + 1), 150);
				} else {
					onFailure?.();
				}
			});
		};
		tryPlay(0);
	}

	function cancelNetworkRetry() {
		if (_reconnectListener) {
			window.removeEventListener('online', _reconnectListener);
			_reconnectListener = null;
		}
	}

	function syncPersistedEpisodeState(podcastId: number, episode: Episode) {
		const podcastIndex = podcastData.podcasts.findIndex((entry) => entry.id === podcastId);
		if (podcastIndex < 0) return;

		const podcast = podcastData.podcasts[podcastIndex];
		const episodeIndex = podcast.episodes.findIndex((entry) => entry.id === episode.id);
		if (episodeIndex < 0) return;

		const persistedEpisode = {
			...podcast.episodes[episodeIndex],
			played: episode.played,
			progress: episode.progress,
			positionSec: episode.positionSec ?? 0,
			duration: episode.duration,
		};
		const episodes = [...podcast.episodes];
		episodes[episodeIndex] = persistedEpisode;
		const updatedPodcast = { ...podcast, episodes };

		podcastData.podcasts = podcastData.podcasts.map((entry, index) =>
			index === podcastIndex ? updatedPodcast : entry
		);

		if (selectedPodcast?.id === podcastId) {
			selectedPodcast = updatedPodcast;
		}

		if (currentEpisode?.podcast.id === podcastId && currentEpisode.episode.id === episode.id) {
			currentEpisode = {
				podcast: updatedPodcast,
				episode: persistedEpisode,
			};
		}
	}

	function markEpisodeFullyPlayed(podcastId: number, episode: Episode) {
		episode.played = true;
		episode.progress = 100;
		episode.positionSec = 0;
		syncPersistedEpisodeState(podcastId, episode);
		podcastData.lastEpisodeId = episode.id;
		podcastData.lastPodcastId = podcastId;
		podcastData.lastPositionSec = 0;
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
			safePlay(() => {
				isBuffering = false;
				addToast({ message: 'Reconnected but failed to resume. Tap play to retry.', type: 'warning', autoDismissMs: 5000 });
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
			if (mediaEngine.source === 'podcast') {
				mediaEngine.updateTime(audioEl.currentTime, audioEl.duration);
			}
			const playbackDuration =
				(isFinite(audioEl.duration) && audioEl.duration > 0)
					? audioEl.duration
					: currentEpisode?.episode.duration ?? duration;
			if (currentEpisode && playbackDuration > 0) {
				const updatedEpisode = {
					...currentEpisode.episode,
					progress: Math.min(100, Number(((audioEl.currentTime / playbackDuration) * 100).toFixed(1))),
					positionSec: audioEl.currentTime,
					duration: playbackDuration,
				};
				syncPersistedEpisodeState(currentEpisode.podcast.id, updatedEpisode);
			}
		};
		const onLoadedMetadata = () => {
			duration = isFinite(audioEl.duration) ? audioEl.duration : 0;
			if (currentEpisode && duration > 0) {
				syncPersistedEpisodeState(currentEpisode.podcast.id, {
					...currentEpisode.episode,
					duration,
				});
			}
			if (mediaEngine.source === 'podcast') {
				mediaEngine.updateTime(audioEl.currentTime, audioEl.duration);
			}
		};
		const onPlay  = () => { isPlaying = true;  isBuffering = false; mediaEngine.podcastPlaying = true;  };
		const onPause = () => {
			const wasUserPaused = _userPaused;
			_userPaused = false;
			isPlaying = false;
			mediaEngine.podcastPlaying = false;
			// System paused us (Android Doze, audio-focus churn) — try to resume.
			// Retry up to 3 times with backoff, same pattern as MP3 safePlay.
			if (!wasUserPaused && currentEpisode) {
				const tryResume = (attempt: number) => {
					audioEl?.play().catch(() => {
						if (attempt < 3) setTimeout(() => tryResume(attempt + 1), 300 * (attempt + 1));
					});
				};
				setTimeout(() => tryResume(0), 150);
			}
		};
		const onWaiting  = () => { isBuffering = true; };
		const onPlaying  = () => { isBuffering = false; };
		const onEnded = () => {
			isPlaying = false;
			isBuffering = false;
			mediaEngine.podcastPlaying = false;
			if (currentEpisode) {
				markEpisodeFullyPlayed(currentEpisode.podcast.id, currentEpisode.episode);
			}
		};
		const onError = () => {
			const err = audioEl.error;
			isBuffering = false;
			if (err?.code === 2 && currentEpisode) {
				scheduleReconnectResume(audioEl.src, audioEl.currentTime);
				addToast({ message: 'Connection lost — will resume when reconnected.', type: 'warning', autoDismissMs: 6000 });
			} else {
				isPlaying = false;
				mediaEngine.podcastPlaying = false;
				if (err?.code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED) {
					addToast({ message: 'This audio format is not supported.', type: 'error', autoDismissMs: 4000 });
				}
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

	// Pull-to-refresh + swipe-back are wired via use:pullToRefresh /
	// use:swipeBack actions on the scroll containers in the template below.
	const PULL_THRESHOLD = 64;


	// ── Lazy loading: IntersectionObserver on sentinel element ──
	$effect(() => {
		const el = loadMoreSentinelEl;
		if (!el || !selectedPodcast) return;
		const observer = new IntersectionObserver(
			(entries) => {
				if (entries[0]?.isIntersecting && hasMoreEpisodes && !episodesLoadingMore && selectedPodcast) {
					void loadMoreEpisodes(selectedPodcast);
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

	// ── Release URL resolver (hosted proxy for native / configured releases) ──
	function resolvePodcastApiUrl(path: string): string {
		if (/^https?:\/\//i.test(path)) {
			return path;
		}

		if (!podcastApiBaseUrl) {
			return path;
		}

		return `${podcastApiBaseUrl}${path.startsWith('/') ? path : `/${path}`}`;
	}

	/** RssFetchConfig bound to this view's release/proxy resolution. */
	const rssFetchConfig = $derived.by(() => ({
		resolveUrl: resolvePodcastApiUrl,
		useHostedProxy: useHostedPodcastProxy,
	}));


	function mergeEpisodeHistory(podcastId: number, episodes: Episode[]): Episode[] {
		const existingEpisodes = podcastData.podcasts.find(p => p.id === podcastId)?.episodes ?? [];
		const byId = new Map(existingEpisodes.map(episode => [episode.id, episode]));
		const byAudioUrl = new Map(existingEpisodes.filter(episode => episode.audioUrl).map(episode => [episode.audioUrl, episode]));
		const byTitleDate = new Map(existingEpisodes.map(episode => [`${episode.title}|${episode.publishedAt}`, episode]));

		return episodes.map(episode => {
			const existing = byId.get(episode.id)
				?? byAudioUrl.get(episode.audioUrl)
				?? byTitleDate.get(`${episode.title}|${episode.publishedAt}`);
			if (!existing) return episode;
			if (podcastData.lastPodcastId === podcastId && podcastData.lastEpisodeId === existing.id) {
				podcastData.lastEpisodeId = episode.id;
			}
			return {
				...episode,
				played: existing.played,
				progress: existing.progress,
				positionSec: existing.positionSec
			};
		});
	}

	// ── Helpers ─────────────────────────────────────────────────
	function isActiveEpisode(episode: Episode): boolean {
		return currentEpisode?.episode.id === episode.id;
	}
	function getEpisodeProgressPercent(episode: Episode): number {
		const savedProgress = episode.progress ?? 0;

		if (!isActiveEpisode(episode)) {
			return savedProgress;
		}

		const liveDuration = duration > 0 ? duration : episode.duration;
		if (liveDuration <= 0 || currentTime <= 0) {
			return savedProgress;
		}

		return Math.min(100, Number(((currentTime / liveDuration) * 100).toFixed(1)));
	}
	function getEpisodeProgressLabel(episode: Episode): string {
		if (!isActiveEpisode(episode)) {
			return '';
		}

		const progressPosition = currentTime > 0 ? currentTime : (episode.positionSec ?? 0);
		if (progressPosition <= 0) {
			return '';
		}

		const liveDuration = duration > 0 ? duration : episode.duration;
		if (liveDuration <= 0) {
			return `Playing ${formatDuration(progressPosition)}`;
		}

		return `${formatDuration(progressPosition)} of ${formatDuration(liveDuration)}`;
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
	const NEW_EPISODE_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
	function isNewEpisode(episode: Episode): boolean {
		if (episode.played || (episode.progress ?? 0) > 0 || (episode.positionSec ?? 0) > 0) return false;
		if (!episode.publishedAt) return true;
		const publishedTime = new Date(episode.publishedAt).getTime();
		if (!Number.isFinite(publishedTime)) return true;
		return Date.now() - publishedTime <= NEW_EPISODE_WINDOW_MS;
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
			episodesLoading = false;
			episodesRefreshing = false;
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
			clearRssCache(p.feedUrl);
			const data = await fetchRss(p.feedUrl, rssFetchConfig, signal);
			if (data.status !== 'ok') return;
			const eps: Episode[] = ((data.items as Record<string, unknown>[]) ?? []).map(
				(item: Record<string, unknown>, i: number) => {
					const enc = item.enclosure as { link?: string } | null;
					const rawDur = item.itunes_duration ?? item.duration ?? 0;
					return {
						id:          buildEpisodeId(p, item, i, enc),
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
			const mergedEps = mergeEpisodeHistory(p.id, eps);
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

	// ── Load episodes (lazy loading with pagination) ──────────────
	async function loadEpisodes(podcast: Podcast, force = false) {
		if (!force && podcast.episodesLoaded) return;
		// Abort any previous in-flight load
		episodeLoadController?.abort();
		const controller = new AbortController();
		episodeLoadController = controller;
		episodeLoadPodcastId = podcast.id;
		const signal = controller.signal;
		// Clear all cached pages for this feed
		if (force && podcast.feedUrl) clearRssCache(podcast.feedUrl);
		if (force && podcast.episodesLoaded) {
			episodesRefreshing = true;
		} else {
			episodesLoading = true;
			episodesPage = 1;
		}
		episodesError = null;
		try {
			if (!podcast.feedUrl) {
				// Resolve feedUrl via iTunes lookup
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
			const data = await fetchRss(podcast.feedUrl, rssFetchConfig, signal, force ? undefined : 1) as Record<string, unknown>;
			if (data.status !== 'ok') throw new Error(data.message as string ?? 'RSS error');
			const eps: Episode[] = ((data.items as Record<string, unknown>[]) ?? []).map((item: Record<string, unknown>, i: number) => {
				const enc = item.enclosure as { link?: string; length?: number } | null;
				const rawDur = item.itunes_duration ?? item.duration ?? 0;
				return {
					id:          buildEpisodeId(podcast, item, i, enc),
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
			const mergedEps = mergeEpisodeHistory(podcast.id, eps);
			podcastData.podcasts = podcastData.podcasts.map(p =>
				p.id === podcast.id
					? { ...p, episodes: force ? mergedEps : mergedEps, episodesLoaded: true, artworkUrl: p.artworkUrl || feedImage }
					: p
			);
			if (selectedPodcast?.id === podcast.id) {
				selectedPodcast = podcastData.podcasts.find(p => p.id === podcast.id) ?? selectedPodcast;
			}
			hasMoreEpisodes = (data.hasMore as boolean) ?? false;
		} catch (e: unknown) {
			if (signal.aborted) return;
			const msg = describePodcastRequestError(e, 'Unable to load this podcast right now. Please try again.');
			if (!force || !podcast.episodesLoaded) {
				episodesError = msg;
			}
			addToast({
				message: msg,
				type: 'error',
				action: { label: 'Retry', handler: () => loadEpisodes(podcast, true) },
				autoDismissMs: 8000
			});
		} finally {
			if (episodeLoadController === controller) {
				episodeLoadController = null;
				episodeLoadPodcastId = null;
				episodesLoading = false;
				episodesRefreshing = false;
			}
		}
	}

	async function loadMoreEpisodes(podcast: Podcast) {
		if (episodesLoadingMore || !hasMoreEpisodes) return;
		episodesLoadingMore = true;
		const nextPage = episodesPage + 1;
		try {
			const data = await fetchRss(podcast.feedUrl, rssFetchConfig, undefined, nextPage) as Record<string, unknown>;
			if (data.status !== 'ok') throw new Error(data.message as string ?? 'RSS error');
			const eps: Episode[] = ((data.items as Record<string, unknown>[]) ?? []).map((item: Record<string, unknown>, i: number) => {
				const enc = item.enclosure as { link?: string; length?: number } | null;
				const rawDur = item.itunes_duration ?? item.duration ?? 0;
				return {
					id:          buildEpisodeId(podcast, item, (nextPage - 1) * 50 + i, enc),
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
			const mergedEps = mergeEpisodeHistory(podcast.id, eps);
			podcastData.podcasts = podcastData.podcasts.map(p =>
				p.id === podcast.id
					? { ...p, episodes: [...p.episodes, ...mergedEps], episodesLoaded: true }
					: p
			);
			if (selectedPodcast?.id === podcast.id) {
				selectedPodcast = podcastData.podcasts.find(p => p.id === podcast.id) ?? selectedPodcast;
			}
			episodesPage = nextPage;
			hasMoreEpisodes = (data.hasMore as boolean) ?? false;
		} catch (e: unknown) {
			console.error('Failed to load more episodes:', e);
		} finally {
			episodesLoadingMore = false;
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
		void triggerPlaybackHaptic(true);
		claimAudio('podcast');
		currentEpisode = { podcast, episode };
		const resumeAt = getEpisodeResumePosition(episode);
		duration = episode.duration;
		currentTime = resumeAt > 10 ? resumeAt : 0;
		syncEpisodeAudioSource(podcast, episode, resumeAt);
		isBuffering = true;
		safePlay(() => {
			isBuffering = false;
			console.error('[Podcast] play() failed:', 'url:', episode.audioUrl);
			addToast({ message: `Playback failed.`, type: 'error' });
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
		if (isPlaying) {
			pausePlayback();
		} else {
			resumePlayback();
		}
	}

	function pausePlayback() {
		if (!audioEl || !currentEpisode || !isPlaying) return;
		_userPaused = true;
		void triggerPlaybackHaptic(false);
		cancelNetworkRetry();
		audioEl.pause();
	}

	function resumePlayback() {
		if (!audioEl || !currentEpisode || isPlaying) return;
		_userPaused = false;
		void triggerPlaybackHaptic(true);
		claimAudio('podcast');
		syncEpisodeAudioSource(
			currentEpisode.podcast,
			currentEpisode.episode,
			getEpisodeResumePosition(currentEpisode.episode)
		);
		safePlay(() => {
			console.error('[Podcast] resumePlayback() failed');
		});
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
			podcastData.lastPositionSec = currentEpisode.episode.played ? 0 : audioEl.currentTime;
			syncPersistedEpisodeState(currentEpisode.podcast.id, currentEpisode.episode);
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
		mediaEngine.podcastPlaying = false;
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
				onRefresh: () => { if (selectedPodcast) void loadEpisodes(selectedPodcast, true); },
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
					{@const activeEpisode = isActiveEpisode(episode)}
					{@const episodeProgress = getEpisodeProgressPercent(episode)}
					{@const episodeProgressLabel = getEpisodeProgressLabel(episode)}
					{@const newEpisode = isNewEpisode(episode)}
					<div
						class="tap-feedback list-row-surface relative overflow-hidden border-l-[6px] p-4 border-b transition-colors cursor-pointer {newEpisode ? 'border-l-primary bg-gradient-to-r from-primary/20 via-primary/10 to-background shadow-[inset_0_1px_0_rgba(255,255,255,0.08)] hover:from-primary/25 hover:via-primary/15 active:from-primary/30' : `border-l-transparent ${listTileToneClasses.usesTint ? listTileToneClasses.rowClass : 'hover:bg-accent/40 active:bg-accent/60'}`}"
						role="button"
						tabindex="0"
						onclick={() => selectedPodcast && activateEpisode(selectedPodcast, episode)}
						onkeydown={(event) => {
							if (event.key !== 'Enter' && event.key !== ' ') return;
							event.preventDefault();
							if (selectedPodcast) activateEpisode(selectedPodcast, episode);
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
										activateEpisode(selectedPodcast, episode);
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
				onRefresh: () => { void refreshAllSubscribed(); },
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
						onclick={() => openPodcast(podcast)}
						onkeydown={(e) => e.key === 'Enter' && openPodcast(podcast)}
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
						<div class="tap-feedback list-row-surface flex items-center gap-3 p-4 border-b transition-colors cursor-pointer {listTileToneClasses.usesTint ? listTileToneClasses.rowClass : 'hover:bg-accent/40 active:bg-accent/60'}"
							role="button" tabindex="0"
							onclick={() => localPodcast && openPodcast(localPodcast)}
							onkeydown={(e) => e.key === 'Enter' && localPodcast && openPodcast(localPodcast)}
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
