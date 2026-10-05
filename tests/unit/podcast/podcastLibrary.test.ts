import { describe, it, expect, vi, beforeEach } from 'vitest';

// The module under test reaches the network only through `$lib/podcast/rss`, so
// that module is replaced with stand-ins and no request leaves the process.
// `$lib/stores/toastStore.svelte` is mocked so the error toast can be asserted.
// Everything else is real: `podcastData` (the shared store), `mergeEpisodeHistory`
// and `runConcurrently`. The storage shape/quota/trim side of `podcastData` is
// already covered by tests/unit/models/podcast-persist.test.ts, and the
// bounded-concurrency behaviour of `runConcurrently` by
// tests/unit/models/podcast-refresh.test.ts; this file deliberately does not
// re-test either, it only checks that the factory drives them the way the view
// used to.
const mocks = vi.hoisted(() => ({
	fetchRss: vi.fn(),
	readPodcastJson: vi.fn(),
	clearRssCache: vi.fn(),
	addToast: vi.fn(),
}));

vi.mock('$lib/podcast/rss', () => ({
	fetchRss: mocks.fetchRss,
	readPodcastJson: mocks.readPodcastJson,
	clearRssCache: mocks.clearRssCache,
	buildEpisodeId: (podcast: { itunesId: number }, item: Record<string, unknown>, index: number) =>
		`${podcast.itunesId}:${(item.guid as string | undefined) ?? index}`,
	parseDuration: (dur: unknown) => (typeof dur === 'number' ? dur : Number(dur) || 0),
	describePodcastRequestError: (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback),
}));

vi.mock('$lib/stores/toastStore.svelte', () => ({
	addToast: mocks.addToast,
}));

import {
	createPodcastLibrary,
	type PodcastLibraryView,
} from '$lib/podcast/podcastLibrary';
import type { ItunesResult } from '$lib/podcast/itunes';
import {
	podcastData,
	type PersistedEpisode,
	type PersistedPodcast,
} from '$lib/stores/settings.svelte';

// ── helpers ──────────────────────────────────────────────────

function deferred<T>() {
	let resolve!: (v: T) => void;
	let reject!: (e: unknown) => void;
	const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
	return { promise, resolve, reject };
}

/** Let the microtask queue drain (the module awaits `fetchRss`/`readPodcastJson`). */
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

const feedOk = (items: Array<Record<string, unknown>> = [], hasMore = false) => ({ status: 'ok', items, hasMore });

const makeEpisode = (over: Partial<PersistedEpisode> = {}): PersistedEpisode => ({
	id: '1:ep-1',
	title: 'Episode 1',
	description: '',
	duration: 1800,
	publishedAt: '2026-01-01T00:00:00Z',
	played: false,
	progress: 0,
	positionSec: 0,
	audioUrl: 'https://example.com/audio-1.mp3',
	...over,
});

const makePodcast = (over: Partial<PersistedPodcast> = {}): PersistedPodcast => ({
	id: 1,
	itunesId: 1,
	title: 'Cast',
	author: 'A',
	category: 'News',
	artworkUrl: '',
	feedUrl: 'https://example.com/feed.xml',
	subscribed: true,
	episodes: [],
	episodesLoaded: false,
	...over,
});

const makeItem = (over: Partial<ItunesResult> = {}): ItunesResult => ({
	trackId: 42,
	trackName: 'Cast',
	artistName: 'A',
	artworkUrl600: '',
	feedUrl: 'https://example.com/feed.xml',
	primaryGenreName: 'News',
	trackCount: 1,
	...over,
});

/** A plain mutable accessor, the same shape the view injects. */
function makeView(over: Partial<PodcastLibraryView> = {}): PodcastLibraryView {
	return {
		selectedPodcast: null,
		episodesLoading: false,
		episodesLoadingMore: false,
		episodesRefreshing: false,
		episodesPage: 1,
		hasMoreEpisodes: false,
		episodesError: null,
		isRefreshingAll: false,
		subscribedPodcasts: [],
		...over,
	};
}

function makeLibrary(view: PodcastLibraryView) {
	return createPodcastLibrary({ view, config: { baseUrl: '', useHostedProxy: false } });
}

beforeEach(() => {
	vi.clearAllMocks();
	podcastData.podcasts = [];
	podcastData.nextId = 0;
	podcastData.lastEpisodeId = '';
	podcastData.lastPodcastId = -1;
	podcastData.lastPositionSec = 0;
	mocks.addToast.mockReturnValue('toast');
	mocks.fetchRss.mockResolvedValue(feedOk());
});

// ─────────────────────────────────────────────────────────────
// loadEpisodes — first page, flags, pagination
// ─────────────────────────────────────────────────────────────

describe('loadEpisodes', () => {
	it('loads page 1, marks the feed loaded and takes hasMore from the response', async () => {
		const pod = makePodcast();
		podcastData.podcasts = [pod];
		const view = makeView();
		const lib = makeLibrary(view);
		mocks.fetchRss.mockResolvedValue(feedOk([{ title: 'Ep 1', guid: 'g1' }], true));

		await lib.loadEpisodes(pod);

		expect(mocks.fetchRss).toHaveBeenCalledTimes(1);
		// (feedUrl, rssConfig, signal, page) — a first load asks for page 1.
		expect(mocks.fetchRss.mock.calls[0][0]).toBe(pod.feedUrl);
		expect(mocks.fetchRss.mock.calls[0][3]).toBe(1);

		const stored = podcastData.podcasts[0];
		expect(stored.episodesLoaded).toBe(true);
		expect(stored.episodes).toHaveLength(1);
		expect(stored.episodes[0].title).toBe('Ep 1');

		expect(view.hasMoreEpisodes).toBe(true);
		expect(view.episodesPage).toBe(1);
		expect(view.episodesError).toBeNull();
		expect(view.episodesLoading).toBe(false);
		expect(view.episodesRefreshing).toBe(false);
	});

	it('sets episodesLoading while the first page is in flight and clears it after', async () => {
		const pod = makePodcast();
		podcastData.podcasts = [pod];
		const view = makeView();
		const lib = makeLibrary(view);
		const d = deferred<Record<string, unknown>>();
		mocks.fetchRss.mockReturnValue(d.promise);

		const p = lib.loadEpisodes(pod);
		// Synchronously after the call, before the fetch resolves.
		expect(view.episodesLoading).toBe(true);
		expect(view.episodesRefreshing).toBe(false);
		expect(view.episodesError).toBeNull();

		d.resolve(feedOk([{ title: 'Ep 1' }]));
		await p;
		expect(view.episodesLoading).toBe(false);
	});

	it('skips a non-forced load when the feed is already loaded', async () => {
		const pod = makePodcast({ episodesLoaded: true });
		podcastData.podcasts = [pod];
		const lib = makeLibrary(makeView());

		await lib.loadEpisodes(pod);

		expect(mocks.fetchRss).not.toHaveBeenCalled();
	});

	it('resolves a missing feedUrl through the iTunes lookup and stores feed and artwork', async () => {
		const pod = makePodcast({ feedUrl: '', artworkUrl: '' });
		podcastData.podcasts = [pod];
		const lib = makeLibrary(makeView());
		mocks.readPodcastJson.mockResolvedValue({
			results: [{ feedUrl: 'https://example.com/resolved.xml', artworkUrl600: 'https://example.com/art.jpg' }],
		});

		await lib.loadEpisodes(pod);

		const stored = podcastData.podcasts[0];
		expect(stored.feedUrl).toBe('https://example.com/resolved.xml');
		expect(stored.artworkUrl).toBe('https://example.com/art.jpg');
		expect(mocks.fetchRss.mock.calls[0][0]).toBe('https://example.com/resolved.xml');
	});

	it('sets episodesError when the lookup has no feed and never fetches RSS', async () => {
		const pod = makePodcast({ feedUrl: '', episodesLoaded: false });
		podcastData.podcasts = [pod];
		const view = makeView();
		const lib = makeLibrary(view);
		mocks.readPodcastJson.mockResolvedValue({ results: [{}] });

		await lib.loadEpisodes(pod);

		expect(view.episodesError).toBe('No RSS feed available for this podcast.');
		expect(mocks.fetchRss).not.toHaveBeenCalled();
		expect(view.episodesLoading).toBe(false);
	});
});

// ─────────────────────────────────────────────────────────────
// loadEpisodes — silent refresh
// ─────────────────────────────────────────────────────────────

describe('loadEpisodes — forced/silent refresh', () => {
	it('sets only episodesRefreshing and leaves the spinners and page alone', async () => {
		const pod = makePodcast({ episodesLoaded: true, episodes: [makeEpisode()] });
		podcastData.podcasts = [pod];
		const view = makeView({ selectedPodcast: pod, episodesPage: 3, hasMoreEpisodes: true });
		const lib = makeLibrary(view);
		const d = deferred<Record<string, unknown>>();
		mocks.fetchRss.mockReturnValue(d.promise);

		const p = lib.loadEpisodes(pod, true);
		expect(view.episodesRefreshing).toBe(true);
		expect(view.episodesLoading).toBe(false);
		expect(view.episodesLoadingMore).toBe(false);
		expect(view.episodesPage).toBe(3);
		expect(view.episodesError).toBeNull();
		// A forced refresh drops the feed's cached pages.
		expect(mocks.clearRssCache).toHaveBeenCalledWith(pod.feedUrl);

		d.resolve(feedOk([{ title: 'Refreshed', guid: 'r' }], false));
		await p;
		expect(view.episodesRefreshing).toBe(false);
		expect(view.episodesPage).toBe(3);
		expect(podcastData.podcasts[0].episodes[0].title).toBe('Refreshed');
		// A forced refresh asks the fetch for the un-paged ("all") response.
		expect(mocks.fetchRss.mock.calls[0][3]).toBeUndefined();
	});
});

// ─────────────────────────────────────────────────────────────
// loadMoreEpisodes — append and guards
// ─────────────────────────────────────────────────────────────

describe('loadMoreEpisodes', () => {
	it('appends the next page and advances the page counter', async () => {
		const pod = makePodcast({ episodesLoaded: true, episodes: [makeEpisode({ id: '1:a' })] });
		podcastData.podcasts = [pod];
		const view = makeView({ selectedPodcast: pod, episodesPage: 1, hasMoreEpisodes: true });
		const lib = makeLibrary(view);
		mocks.fetchRss.mockResolvedValue(feedOk([{ title: 'Ep 51', guid: 'new' }], false));

		await lib.loadMoreEpisodes(pod);

		expect(mocks.fetchRss.mock.calls[0][3]).toBe(2);
		// Appended, not replaced.
		expect(podcastData.podcasts[0].episodes).toHaveLength(2);
		expect(podcastData.podcasts[0].episodes[0].id).toBe('1:a');
		expect(podcastData.podcasts[0].episodes[1].title).toBe('Ep 51');
		expect(view.episodesPage).toBe(2);
		expect(view.hasMoreEpisodes).toBe(false);
		expect(view.episodesLoadingMore).toBe(false);
	});

	it('does nothing when there is no more, or a page load is already running', async () => {
		const pod = makePodcast({ episodesLoaded: true, episodes: [makeEpisode()] });
		podcastData.podcasts = [pod];
		const lib = makeLibrary(makeView());

		const noMore = makeView({ hasMoreEpisodes: false });
		await makeLibrary(noMore).loadMoreEpisodes(pod);
		expect(mocks.fetchRss).not.toHaveBeenCalled();

		const alreadyLoading = makeView({ hasMoreEpisodes: true, episodesLoadingMore: true });
		await makeLibrary(alreadyLoading).loadMoreEpisodes(pod);
		expect(mocks.fetchRss).not.toHaveBeenCalled();

		expect(lib).toBeDefined();
	});
});

// ─────────────────────────────────────────────────────────────
// loadEpisodes — supersession
// ─────────────────────────────────────────────────────────────

describe('loadEpisodes — a load superseded by a newer one', () => {
	it('aborts the older load, whose rejection is swallowed and cannot write', async () => {
		const podA = makePodcast({ id: 1, feedUrl: 'https://example.com/a.xml' });
		const podB = makePodcast({ id: 2, feedUrl: 'https://example.com/b.xml' });
		podcastData.podcasts = [podA, podB];
		const view = makeView({ selectedPodcast: podA });
		const lib = makeLibrary(view);

		const dA = deferred<Record<string, unknown>>();
		const dB = deferred<Record<string, unknown>>();
		mocks.fetchRss.mockImplementation((feedUrl: string, _config: unknown, signal?: AbortSignal) => {
			const d = feedUrl === podA.feedUrl ? dA : dB;
			signal?.addEventListener('abort', () => d.reject(new DOMException('aborted', 'AbortError')));
			return d.promise;
		});

		const pendingA = lib.loadEpisodes(podA);
		const pendingB = lib.loadEpisodes(podB); // aborts A
		// A's signal is already aborted; resolving it is a no-op.
		dA.resolve(feedOk([{ title: 'stale A' }], true));
		dB.resolve(feedOk([{ title: 'B ep', guid: 'b' }], true));
		await Promise.all([pendingA, pendingB]);

		// The superseded load never wrote to A.
		expect(podcastData.podcasts.find(p => p.id === 1)?.episodes).toHaveLength(0);
		expect(podcastData.podcasts.find(p => p.id === 1)?.episodesLoaded).toBe(false);
		// The newer load won.
		const storedB = podcastData.podcasts.find(p => p.id === 2);
		expect(storedB?.episodes).toHaveLength(1);
		expect(storedB?.episodes[0].title).toBe('B ep');
		expect(storedB?.episodesLoaded).toBe(true);

		// The aborted load raised no toast and left no error.
		expect(mocks.addToast).not.toHaveBeenCalled();
		expect(view.episodesError).toBeNull();
		expect(view.episodesLoading).toBe(false);
		expect(view.episodesRefreshing).toBe(false);
		expect(view.hasMoreEpisodes).toBe(true);
	});
});

// ─────────────────────────────────────────────────────────────
// errors
// ─────────────────────────────────────────────────────────────

describe('loadEpisodes — error path', () => {
	it('sets episodesError and toasts with a Retry action on a failed first load', async () => {
		const pod = makePodcast();
		podcastData.podcasts = [pod];
		const view = makeView();
		const lib = makeLibrary(view);
		mocks.fetchRss.mockRejectedValue(new Error('HTTP 500'));

		await lib.loadEpisodes(pod);

		expect(view.episodesError).toBe('HTTP 500');
		expect(mocks.addToast).toHaveBeenCalledTimes(1);
		expect(mocks.addToast.mock.calls[0][0]).toMatchObject({ type: 'error', autoDismissMs: 8000 });
		expect(mocks.addToast.mock.calls[0][0].action.label).toBe('Retry');
		expect(view.episodesLoading).toBe(false);
	});

	it('does not set episodesError on a forced refresh of an already-loaded feed, but still toasts', async () => {
		const pod = makePodcast({ episodesLoaded: true, episodes: [makeEpisode()] });
		podcastData.podcasts = [pod];
		const view = makeView({ selectedPodcast: pod });
		const lib = makeLibrary(view);
		mocks.fetchRss.mockRejectedValue(new Error('boom'));

		await lib.loadEpisodes(pod, true);

		expect(view.episodesError).toBeNull();
		expect(mocks.addToast).toHaveBeenCalledTimes(1);
		expect(view.episodesRefreshing).toBe(false);
	});
});

// ─────────────────────────────────────────────────────────────
// openPodcast
// ─────────────────────────────────────────────────────────────

describe('openPodcast', () => {
	it('selects the podcast, clears the error and loads an unloaded feed', async () => {
		const pod = makePodcast();
		podcastData.podcasts = [pod];
		const view = makeView({ episodesError: 'old error' });
		const lib = makeLibrary(view);

		lib.openPodcast(pod);

		expect(view.selectedPodcast).toBe(pod);
		expect(view.episodesError).toBeNull();
		expect(mocks.fetchRss).toHaveBeenCalledTimes(1);
		expect(mocks.fetchRss.mock.calls[0][3]).toBe(1);
		await flush();
	});

	it('forces a background refresh when the feed is already loaded', async () => {
		const pod = makePodcast({ episodesLoaded: true, episodes: [makeEpisode()] });
		podcastData.podcasts = [pod];
		const view = makeView();
		const lib = makeLibrary(view);

		lib.openPodcast(pod);
		await flush();

		// Forced refresh → no page argument, and the refresh spinner is used.
		expect(mocks.fetchRss.mock.calls[0][3]).toBeUndefined();
		expect(view.episodesRefreshing).toBe(false);
	});
});

// ─────────────────────────────────────────────────────────────
// subscribe / unsubscribe / delete
// ─────────────────────────────────────────────────────────────

describe('subscribeFromItunes', () => {
	it('adds a new feed, subscribes it, assigns the next id and opens it', () => {
		const view = makeView();
		const lib = makeLibrary(view);

		lib.subscribeFromItunes(makeItem({ trackId: 42, trackName: 'Fresh Cast', feedUrl: 'https://x/f.xml' }));

		expect(podcastData.podcasts).toHaveLength(1);
		const added = podcastData.podcasts[0];
		expect(added.id).toBe(1);
		expect(added.itunesId).toBe(42);
		expect(added.title).toBe('Fresh Cast');
		expect(added.feedUrl).toBe('https://x/f.xml');
		expect(added.subscribed).toBe(true);
		// openPodcast ran: selection set and the loader kicked off (sync up to the fetch).
		expect(view.selectedPodcast?.id).toBe(1);
		expect(view.selectedPodcast?.itunesId).toBe(42);
		expect(mocks.fetchRss).toHaveBeenCalledTimes(1);
	});

	it('flips an existing feed to subscribed without adding a duplicate', () => {
		podcastData.podcasts = [makePodcast({ id: 7, itunesId: 42, subscribed: false, episodesLoaded: true })];
		podcastData.nextId = 7;
		const view = makeView();
		const lib = makeLibrary(view);

		lib.subscribeFromItunes(makeItem({ trackId: 42 }));

		expect(podcastData.podcasts).toHaveLength(1);
		expect(podcastData.podcasts[0].id).toBe(7);
		expect(podcastData.podcasts[0].subscribed).toBe(true);
		expect(podcastData.nextId).toBe(7);
		expect(view.selectedPodcast?.id).toBe(7);
	});
});

describe('unsubscribe', () => {
	it('clears the subscribed flag and re-syncs selectedPodcast', () => {
		const pod = makePodcast({ id: 1, subscribed: true });
		podcastData.podcasts = [pod];
		const view = makeView({ selectedPodcast: pod });
		const lib = makeLibrary(view);

		lib.unsubscribe(pod);

		expect(podcastData.podcasts[0].subscribed).toBe(false);
		expect(view.selectedPodcast?.id).toBe(1);
		expect(view.selectedPodcast?.subscribed).toBe(false);
	});

	it('aborts an in-flight load for the podcast and leaves the flags clear', async () => {
		const pod = makePodcast({ id: 1 });
		podcastData.podcasts = [pod];
		const view = makeView({ selectedPodcast: pod });
		const lib = makeLibrary(view);
		const d = deferred<Record<string, unknown>>();
		mocks.fetchRss.mockImplementation((_url: string, _cfg: unknown, signal?: AbortSignal) => {
			signal?.addEventListener('abort', () => d.reject(new DOMException('aborted', 'AbortError')));
			return d.promise;
		});

		const pending = lib.loadEpisodes(pod);
		expect(view.episodesLoading).toBe(true);

		lib.unsubscribe(pod);
		expect(view.episodesLoading).toBe(false);
		expect(view.episodesRefreshing).toBe(false);

		d.resolve(feedOk([{ title: 'late' }]));
		await pending;
		expect(podcastData.podcasts[0].episodes).toHaveLength(0);
	});
});

describe('deletePodcast', () => {
	it('removes the feed from the store and clears the selection when it matches', () => {
		const pod = makePodcast({ id: 1 });
		podcastData.podcasts = [pod];
		const view = makeView({ selectedPodcast: pod });
		const lib = makeLibrary(view);

		lib.deletePodcast(1);

		expect(podcastData.podcasts).toHaveLength(0);
		expect(view.selectedPodcast).toBeNull();
	});

	it('leaves the selection alone when a different feed is deleted', () => {
		const keep = makePodcast({ id: 1 });
		const drop = makePodcast({ id: 2 });
		podcastData.podcasts = [keep, drop];
		const view = makeView({ selectedPodcast: keep });
		const lib = makeLibrary(view);

		lib.deletePodcast(2);

		expect(podcastData.podcasts).toHaveLength(1);
		expect(view.selectedPodcast).toBe(keep);
	});
});

// ─────────────────────────────────────────────────────────────
// refreshPodcastSilent / refreshAllSubscribed
// ─────────────────────────────────────────────────────────────

describe('refreshAllSubscribed', () => {
	it('refreshes every subscribed feed and toggles isRefreshingAll around the run', async () => {
		const p1 = makePodcast({ id: 1, feedUrl: 'https://example.com/1.xml' });
		const p2 = makePodcast({ id: 2, feedUrl: 'https://example.com/2.xml' });
		podcastData.podcasts = [p1, p2];
		const subscribed = [p1, p2];
		const view = makeView({ subscribedPodcasts: subscribed });
		const lib = makeLibrary(view);
		mocks.fetchRss.mockResolvedValue(feedOk([{ title: 'e', guid: 'g' }], false));

		await lib.refreshAllSubscribed();

		expect(mocks.fetchRss).toHaveBeenCalledTimes(2);
		expect(view.isRefreshingAll).toBe(false);
		expect(podcastData.podcasts[0].episodes).toHaveLength(1);
		expect(podcastData.podcasts[1].episodes).toHaveLength(1);
		// The silent refresh does not touch the episode-view spinners.
		expect(view.episodesLoading).toBe(false);
		expect(view.episodesRefreshing).toBe(false);
		expect(view.episodesLoadingMore).toBe(false);
	});

	it('does nothing with no subscriptions, and re-enters nothing while already refreshing', async () => {
		const lib = makeLibrary(makeView({ subscribedPodcasts: [] }));
		await lib.refreshAllSubscribed();
		expect(mocks.fetchRss).not.toHaveBeenCalled();

		const busy = makeLibrary(makeView({ isRefreshingAll: true, subscribedPodcasts: [makePodcast()] }));
		await busy.refreshAllSubscribed();
		expect(mocks.fetchRss).not.toHaveBeenCalled();
	});

	it('swallows a per-feed failure without toasting', async () => {
		const pod = makePodcast({ episodesLoaded: false });
		podcastData.podcasts = [pod];
		const lib = makeLibrary(makeView({ subscribedPodcasts: [pod] }));
		mocks.fetchRss.mockRejectedValue(new Error('feed down'));

		await expect(lib.refreshPodcastSilent(pod)).resolves.toBeUndefined();
		expect(mocks.addToast).not.toHaveBeenCalled();
	});
});
