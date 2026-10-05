/**
 * Podcast library — subscribe / unsubscribe / delete, the two background
 * refreshes, and the paginated episode loader. Lifted out of
 * `src/lib/components/views/PodcastView.svelte` (PR 6 group 4).
 *
 * Seam: `createPodcastLibrary` is a factory, not a module singleton — it is one
 * per `PodcastView` instance, the same shape `createFileOps` and the progress
 * module use. It is a plain `.ts` and holds no runes. `podcastData` is the
 * shared persisted store and is imported directly, exactly as `progress.ts`
 * imports it. The state these functions read and write that is *not* shared
 * (`selectedPodcast`, the episode-list flags, the pagination counters and the
 * pull-to-refresh flag) stays in the view and arrives through the injected
 * accessor, so the component remains its sole owner and the markup stays
 * reactive. The one piece of bookkeeping the view never reads reactively — the
 * in-flight load's `AbortController` and its podcast id — is private to the
 * factory.
 *
 * Behaviour preserved from the view:
 *  - the episode-loading discipline: `loadEpisodes` aborts the previous
 *    controller and records the new one/id before fetching; a superseded load
 *    that rejects because its signal was aborted returns without touching
 *    `episodesError`, and only the load whose controller is still current
 *    clears `episodesLoading` / `episodesRefreshing`;
 *  - pagination: a first load (or a forced refresh of an already-loaded feed)
 *    resets `episodesPage` to 1, an append keeps the current page, advances
 *    `episodesPage` and concatenates onto the existing episodes, and
 *    `hasMoreEpisodes` always comes from the response's `hasMore`;
 *  - the loading flags: a silent refresh of an already-loaded feed sets
 *    `episodesRefreshing` and deliberately leaves `episodesLoading`,
 *    `episodesLoadingMore` and `episodesPage` alone; a first load sets
 *    `episodesLoading`;
 *  - the error path: `episodesError` is set only for a first load or a forced
 *    refresh of a not-yet-loaded feed, and the toast still carries the Retry
 *    action bound to a forced reload;
 *  - subscribe adds the feed (or flips an existing one to subscribed) and then
 *    opens it; unsubscribe flips `subscribed` and re-syncs `selectedPodcast`;
 *    delete removes the feed and clears `selectedPodcast` when it pointed there.
 */
import {
	podcastData,
	type PersistedEpisode,
	type PersistedPodcast,
} from '$lib/stores/settings.svelte';
import { addToast } from '$lib/stores/toastStore.svelte';
import {
	fetchRss, buildEpisodeId, describePodcastRequestError,
	parseDuration, readPodcastJson, clearRssCache,
} from '$lib/podcast/rss';
import { runConcurrently } from '$lib/podcast/refresh';
import { resolvePodcastApiUrl, type ItunesResult } from '$lib/podcast/itunes';
import { mergeEpisodeHistory } from '$lib/podcast/progress';

/**
 * The view-owned state these functions read and write. Every field is the
 * view's reactive state, exposed as a getter/setter pair so this rune-free
 * module can read and replace it without owning it. `subscribedPodcasts` is a
 * derived in the view, so it is exposed as a read-only getter and the factory
 * snapshots it before any async work.
 */
export interface PodcastLibraryView {
	selectedPodcast: PersistedPodcast | null;
	episodesLoading: boolean;
	episodesLoadingMore: boolean;
	episodesRefreshing: boolean;
	episodesPage: number;
	hasMoreEpisodes: boolean;
	episodesError: string | null;
	isRefreshingAll: boolean;
	readonly subscribedPodcasts: PersistedPodcast[];
}

export interface PodcastLibraryOptions {
	/** The view-owned state the module reads and writes. */
	view: PodcastLibraryView;
	/** Release/proxy resolution settings, constant for the life of the view. */
	config: { baseUrl: string; useHostedProxy: boolean };
}

/** Per-view podcast subscriptions, refreshes and the paginated episode loader. */
export interface PodcastLibrary {
	subscribeFromItunes(item: ItunesResult): void;
	unsubscribe(podcast: PersistedPodcast): void;
	deletePodcast(id: number): void;
	refreshPodcastSilent(podcast: PersistedPodcast): Promise<void>;
	refreshAllSubscribed(): Promise<void>;
	loadEpisodes(podcast: PersistedPodcast, force?: boolean): Promise<void>;
	loadMoreEpisodes(podcast: PersistedPodcast): Promise<void>;
	openPodcast(podcast: PersistedPodcast): void;
}

export function createPodcastLibrary(opts: PodcastLibraryOptions): PodcastLibrary {
	const { view } = opts;

	/** RSS fetch config for this view's release/proxy resolution. */
	const rssConfig = {
		resolveUrl: (path: string) => resolvePodcastApiUrl(path, opts.config.baseUrl),
		useHostedProxy: opts.config.useHostedProxy,
	};

	// AbortController for the in-flight loadEpisodes (TASK-2.1: prevents race
	// conditions). Private to the factory: the view never reads either value.
	let episodeLoadController: AbortController | null = null;
	let episodeLoadPodcastId: number | null = null;

	function subscribeFromItunes(item: ItunesResult): void {
		let pod: PersistedPodcast;
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

	function unsubscribe(podcast: PersistedPodcast): void {
		// TASK-2.5: Abort any in-flight episode load for this podcast
		if (episodeLoadPodcastId === podcast.id) {
			episodeLoadController?.abort();
			episodeLoadController = null;
			episodeLoadPodcastId = null;
			view.episodesLoading = false;
			view.episodesRefreshing = false;
		}
		podcastData.podcasts = podcastData.podcasts.map(p => p.id === podcast.id ? { ...p, subscribed: false } : p);
		// Re-sync selectedPodcast so the subscribe toggle reflects the new state immediately
		if (view.selectedPodcast?.id === podcast.id) {
			view.selectedPodcast = podcastData.podcasts.find(p => p.id === podcast.id) ?? view.selectedPodcast;
		}
	}

	function deletePodcast(id: number): void {
		podcastData.podcasts = podcastData.podcasts.filter(p => p.id !== id);
		if (view.selectedPodcast?.id === id) view.selectedPodcast = null;
	}

	// ── Background refresh for all subscribed podcasts (pull-to-refresh) ──────
	async function refreshPodcastSilent(podcast: PersistedPodcast): Promise<void> {
		const controller = new AbortController();
		const signal = controller.signal;
		try {
			let p = podcast;
			if (!p.feedUrl) {
				const lookupUrl = opts.config.useHostedProxy
					? resolvePodcastApiUrl(`/api/podcast/lookup?id=${p.itunesId}`, opts.config.baseUrl)
					: `https://itunes.apple.com/lookup?id=${p.itunesId}`;
				const luData = await readPodcastJson<{ results?: Array<Record<string, unknown>> }>(lookupUrl, signal);
				const r = luData.results?.[0];
				const resolvedFeedUrl = typeof r?.feedUrl === 'string' ? r.feedUrl : '';
				if (!resolvedFeedUrl) return;
				p = { ...p, feedUrl: resolvedFeedUrl };
				podcastData.podcasts = podcastData.podcasts.map(pd => pd.id === p.id ? p : pd);
			}
			clearRssCache(p.feedUrl);
			const data = await fetchRss(p.feedUrl, rssConfig, signal);
			if (data.status !== 'ok') return;
			const eps: PersistedEpisode[] = ((data.items as Record<string, unknown>[]) ?? []).map(
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
			if (view.selectedPodcast?.id === p.id) {
				view.selectedPodcast = podcastData.podcasts.find(pd => pd.id === p.id) ?? view.selectedPodcast;
			}
		} catch {
			// Silent — individual podcast failures don't block the rest
		}
	}

	async function refreshAllSubscribed(): Promise<void> {
		if (view.isRefreshingAll) return;
		const toRefresh = view.subscribedPodcasts.slice(); // snapshot before async work
		if (toRefresh.length === 0) return;
		view.isRefreshingAll = true;
		try {
			// Fetch feeds in parallel (bounded concurrency) — the sequential
			// per-feed loop made refreshing N subscriptions take N× network latency.
			await runConcurrently(toRefresh, (p) => refreshPodcastSilent(p));
		} finally {
			view.isRefreshingAll = false;
		}
	}

	// ── Load episodes (lazy loading with pagination) ──────────────
	async function loadEpisodes(podcast: PersistedPodcast, force = false): Promise<void> {
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
			view.episodesRefreshing = true;
		} else {
			view.episodesLoading = true;
			view.episodesPage = 1;
		}
		view.episodesError = null;
		try {
			if (!podcast.feedUrl) {
				// Resolve feedUrl via iTunes lookup
				const lookupUrl = opts.config.useHostedProxy
					? resolvePodcastApiUrl(`/api/podcast/lookup?id=${podcast.itunesId}`, opts.config.baseUrl)
					: `https://itunes.apple.com/lookup?id=${podcast.itunesId}`;
				const luData = await readPodcastJson<{ results?: Array<Record<string, unknown>> }>(lookupUrl, signal);
				const r = luData.results?.[0];
				const resolvedFeedUrl = typeof r?.feedUrl === 'string' ? r.feedUrl : '';
				const resolvedArtworkUrl = typeof r?.artworkUrl600 === 'string' ? r.artworkUrl600 : '';
				if (!resolvedFeedUrl) {
					view.episodesError = 'No RSS feed available for this podcast.';
					return;
				}
				podcast = { ...podcast, feedUrl: resolvedFeedUrl, artworkUrl: podcast.artworkUrl || resolvedArtworkUrl };
				podcastData.podcasts = podcastData.podcasts.map(p => p.id === podcast.id ? podcast : p);
				if (view.selectedPodcast?.id === podcast.id) {
					view.selectedPodcast = podcastData.podcasts.find(p => p.id === podcast.id) ?? view.selectedPodcast;
				}
			}
			const data = await fetchRss(podcast.feedUrl, rssConfig, signal, force ? undefined : 1) as Record<string, unknown>;
			if (data.status !== 'ok') throw new Error(data.message as string ?? 'RSS error');
			const eps: PersistedEpisode[] = ((data.items as Record<string, unknown>[]) ?? []).map((item: Record<string, unknown>, i: number) => {
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
			if (view.selectedPodcast?.id === podcast.id) {
				view.selectedPodcast = podcastData.podcasts.find(p => p.id === podcast.id) ?? view.selectedPodcast;
			}
			view.hasMoreEpisodes = (data.hasMore as boolean) ?? false;
		} catch (e: unknown) {
			if (signal.aborted) return;
			const msg = describePodcastRequestError(e, 'Unable to load this podcast right now. Please try again.');
			if (!force || !podcast.episodesLoaded) {
				view.episodesError = msg;
			}
			addToast({
				message: msg,
				type: 'error',
				action: { label: 'Retry', handler: () => void loadEpisodes(podcast, true) },
				autoDismissMs: 8000
			});
		} finally {
			if (episodeLoadController === controller) {
				episodeLoadController = null;
				episodeLoadPodcastId = null;
				view.episodesLoading = false;
				view.episodesRefreshing = false;
			}
		}
	}

	async function loadMoreEpisodes(podcast: PersistedPodcast): Promise<void> {
		if (view.episodesLoadingMore || !view.hasMoreEpisodes) return;
		view.episodesLoadingMore = true;
		const nextPage = view.episodesPage + 1;
		try {
			const data = await fetchRss(podcast.feedUrl, rssConfig, undefined, nextPage) as Record<string, unknown>;
			if (data.status !== 'ok') throw new Error(data.message as string ?? 'RSS error');
			const eps: PersistedEpisode[] = ((data.items as Record<string, unknown>[]) ?? []).map((item: Record<string, unknown>, i: number) => {
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
			if (view.selectedPodcast?.id === podcast.id) {
				view.selectedPodcast = podcastData.podcasts.find(p => p.id === podcast.id) ?? view.selectedPodcast;
			}
			view.episodesPage = nextPage;
			view.hasMoreEpisodes = (data.hasMore as boolean) ?? false;
		} catch (e: unknown) {
			console.error('Failed to load more episodes:', e);
		} finally {
			view.episodesLoadingMore = false;
		}
	}

	function openPodcast(podcast: PersistedPodcast): void {
		view.selectedPodcast = podcast;
		view.episodesError = null;
		if (!podcast.episodesLoaded) {
			void loadEpisodes(podcast);
		} else {
			// Episodes cached — check for newer ones in the background
			void loadEpisodes(podcast, true);
		}
	}

	return {
		subscribeFromItunes,
		unsubscribe,
		deletePodcast,
		refreshPodcastSilent,
		refreshAllSubscribed,
		loadEpisodes,
		loadMoreEpisodes,
		openPodcast,
	};
}
