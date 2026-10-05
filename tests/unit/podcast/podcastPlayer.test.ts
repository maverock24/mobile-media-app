import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The transport reaches the engine, the toast store, the haptics wrapper and
// Capacitor. All are replaced with stand-ins so no native bridge, toast or
// device is needed and `isNativePlatform` can be flipped per test. The stores
// (`podcastData`, `podcastSettings`) and the progress module are real, exactly
// as they are when the component builds the factory.
const mocks = vi.hoisted(() => ({
	native: { value: false },
	setPlaybackHandlers: vi.fn(),
	setSkipHandlers: vi.fn(),
	setNowPlaying: vi.fn(),
	updateTime: vi.fn(),
	claimAudio: vi.fn(),
	markUserPaused: vi.fn(),
	addToast: vi.fn(),
	triggerPlaybackHaptic: vi.fn(),
}));

vi.mock('@capacitor/core', () => ({
	Capacitor: {
		isNativePlatform: () => mocks.native.value,
		getPlatform: () => (mocks.native.value ? 'android' : 'web'),
	},
}));

vi.mock('$lib/stores/mediaEngine.svelte', () => ({
	mediaEngine: {
		item: null,
		source: null,
		podcastPlaying: false,
		setNowPlaying: mocks.setNowPlaying,
		updateTime: mocks.updateTime,
		setPlaybackHandlers: mocks.setPlaybackHandlers,
		setSkipHandlers: mocks.setSkipHandlers,
	},
	claimAudio: mocks.claimAudio,
	markUserPaused: mocks.markUserPaused,
}));

vi.mock('$lib/stores/toastStore.svelte', () => ({
	addToast: mocks.addToast,
}));

vi.mock('$lib/native/haptics', () => ({
	triggerPlaybackHaptic: mocks.triggerPlaybackHaptic,
	triggerSwipeBackHaptic: vi.fn(),
}));

import {
	createPodcastPlayer,
	type PodcastPlayer,
	type PodcastPlayerView,
} from '$lib/podcast/podcastPlayer';
import { mediaEngine } from '$lib/stores/mediaEngine.svelte';
import {
	podcastData, podcastSettings,
	type PersistedEpisode, type PersistedPodcast,
} from '$lib/stores/settings.svelte';

// ── helpers ──────────────────────────────────────────────────

function makeEpisode(over: Partial<PersistedEpisode> = {}): PersistedEpisode {
	return {
		id: 'ep-1',
		title: 'Episode 1',
		description: '',
		duration: 1800,
		publishedAt: '2026-01-01T00:00:00Z',
		played: false,
		progress: 0,
		positionSec: 0,
		audioUrl: 'https://example.com/audio-1.mp3',
		...over,
	};
}

function makePodcast(over: Partial<PersistedPodcast> = {}): PersistedPodcast {
	return {
		id: 1,
		itunesId: 1,
		title: 'Cast',
		author: 'A',
		category: 'News',
		artworkUrl: 'https://example.com/art.jpg',
		feedUrl: 'https://example.com/feed.xml',
		subscribed: true,
		episodes: [],
		episodesLoaded: true,
		...over,
	};
}

/**
 * A minimal stand-in for the `bind:this` `<audio>` element. It records the
 * listeners it is given (honouring `{ once }`) so a test can dispatch events by
 * name, and `play` is a spy the test can reject with an `AbortError`.
 */
class FakeAudio {
	src = '';
	currentTime = 0;
	duration = 0;
	playbackRate = 1;
	ended = false;
	error: { code: number } | null = null;
	play = vi.fn<() => Promise<void>>(() => Promise.resolve());
	pause = vi.fn();
	load = vi.fn();
	removeAttribute = vi.fn();
	private listeners = new Map<string, Set<(ev?: unknown) => void>>();

	addEventListener = vi.fn((type: string, cb: (ev?: unknown) => void, opts?: { once?: boolean }) => {
		const wrapped = opts?.once
			? (ev?: unknown) => { this.removeEventListener(type, wrapped); cb(ev); }
			: cb;
		if (!this.listeners.has(type)) this.listeners.set(type, new Set());
		this.listeners.get(type)!.add(wrapped);
	});

	removeEventListener = vi.fn((type: string, cb: (ev?: unknown) => void) => {
		this.listeners.get(type)?.delete(cb);
	});

	/** Fire every listener registered for `type`. */
	dispatch(type: string): void {
		for (const cb of [...(this.listeners.get(type) ?? [])]) cb();
	}

	has(type: string): boolean {
		return (this.listeners.get(type)?.size ?? 0) > 0;
	}
}

/** A plain mutable accessor, the same shape the component injects. */
function makeView(over: Partial<PodcastPlayerView> = {}): PodcastPlayerView {
	return {
		selectedPodcast: null,
		currentEpisode: null,
		isPlaying: false,
		isBuffering: false,
		currentTime: 0,
		duration: 0,
		...over,
	};
}

function makePlayer(view: PodcastPlayerView = makeView(), el: FakeAudio = new FakeAudio()) {
	const player: PodcastPlayer = createPodcastPlayer({
		view,
		getAudioEl: () => el as unknown as HTMLAudioElement,
	});
	return { player, view, el };
}

/** A window listener spy that does not actually register (so nothing leaks
 *  between tests); the captured listener is invoked by hand. */
function spyWindowListeners() {
	return {
		add: vi.spyOn(window, 'addEventListener').mockImplementation(() => {}),
		remove: vi.spyOn(window, 'removeEventListener').mockImplementation(() => {}),
	};
}

const listenerFor = (spy: ReturnType<typeof spyWindowListeners>['add'], type = 'online') =>
	spy.mock.calls.find(c => c[0] === type)![1] as () => void;

const errorNamed = (name: string): Promise<never> =>
	Promise.reject(Object.assign(new Error(name), { name }));

beforeEach(() => {
	vi.clearAllMocks();
	vi.useRealTimers();
	mocks.native.value = false;
	mocks.addToast.mockReturnValue('toast');
	(mediaEngine as unknown as { item: unknown; source: string | null; podcastPlaying: boolean }).item = null;
	(mediaEngine as unknown as { source: string | null }).source = null;
	(mediaEngine as unknown as { podcastPlaying: boolean }).podcastPlaying = false;
	podcastData.podcasts = [];
	podcastData.lastEpisodeId = '';
	podcastData.lastPodcastId = -1;
	podcastData.lastPositionSec = 0;
	podcastSettings.playbackSpeed = 1.0;
	// jsdom has no MediaError; the unsupported-source branch reads its constant.
	vi.stubGlobal('MediaError', { MEDIA_ERR_SRC_NOT_SUPPORTED: 4 });
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

// ─────────────────────────────────────────────────────────────
// safePlay
// ─────────────────────────────────────────────────────────────

describe('safePlay', () => {
	it('retries an AbortError 3 times at 150 ms on web, then calls onFailure', async () => {
		vi.useFakeTimers();
		const { player, el } = makePlayer();
		el.play.mockImplementation(() => errorNamed('AbortError'));
		const onFailure = vi.fn();

		player.safePlay(onFailure);
		await vi.advanceTimersByTimeAsync(0);
		expect(el.play).toHaveBeenCalledTimes(1); // initial attempt

		// The web backoff is 150 ms per retry.
		await vi.advanceTimersByTimeAsync(149);
		expect(el.play).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(el.play).toHaveBeenCalledTimes(2);

		await vi.advanceTimersByTimeAsync(1500);
		// 3 retries after the initial attempt: attempts 0..3.
		expect(el.play).toHaveBeenCalledTimes(4);
		expect(onFailure).toHaveBeenCalledTimes(1);
	});

	it('retries an AbortError 6 times at 250 ms on native', async () => {
		vi.useFakeTimers();
		mocks.native.value = true;
		const { player, el } = makePlayer();
		el.play.mockImplementation(() => errorNamed('AbortError'));
		const onFailure = vi.fn();

		player.safePlay(onFailure);
		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(249);
		expect(el.play).toHaveBeenCalledTimes(1); // still waiting for the 250 ms backoff
		await vi.advanceTimersByTimeAsync(3000);
		// 6 retries after the initial attempt: attempts 0..6.
		expect(el.play).toHaveBeenCalledTimes(7);
		expect(onFailure).toHaveBeenCalledTimes(1);
	});

	it('does not retry a non-AbortError and calls onFailure at once', async () => {
		vi.useFakeTimers();
		const { player, el } = makePlayer();
		el.play.mockImplementation(() => errorNamed('NotAllowedError'));
		const onFailure = vi.fn();

		player.safePlay(onFailure);
		await vi.advanceTimersByTimeAsync(5000);

		expect(el.play).toHaveBeenCalledTimes(1);
		expect(onFailure).toHaveBeenCalledTimes(1);
	});
});

// ─────────────────────────────────────────────────────────────
// network reconnect
// ─────────────────────────────────────────────────────────────

describe('cancelNetworkRetry / scheduleReconnectResume', () => {
	it('registers one online listener, replacing any pending one', () => {
		const { add, remove } = spyWindowListeners();
		const { player } = makePlayer();

		player.scheduleReconnectResume('https://x/a.mp3', 5);
		const first = listenerFor(add);
		expect(first).toBeTypeOf('function');
		expect(add).toHaveBeenCalledTimes(1);

		// A second schedule replaces the first listener.
		player.scheduleReconnectResume('https://x/b.mp3', 6);
		expect(remove).toHaveBeenCalledWith('online', first);
		expect(add).toHaveBeenCalledTimes(2);
	});

	it('cancelNetworkRetry removes the pending listener and clears it', () => {
		const { add, remove } = spyWindowListeners();
		const { player } = makePlayer();

		player.scheduleReconnectResume('https://x/a.mp3', 5);
		const listener = listenerFor(add);
		remove.mockClear();

		player.cancelNetworkRetry();
		expect(remove).toHaveBeenCalledWith('online', listener);
	});

	it('re-arms the stream on online: src, position, buffering, claim and play', async () => {
		const { add, remove } = spyWindowListeners();
		const episode = makeEpisode({ positionSec: 30 });
		const view = makeView({ currentEpisode: { podcast: makePodcast(), episode } });
		const { player, el } = makePlayer(view);
		player.scheduleReconnectResume('https://x/a.mp3', 30);
		const listener = listenerFor(add);
		remove.mockClear();

		listener();

		expect(remove).toHaveBeenCalledWith('online', listener); // cancelNetworkRetry first
		expect(el.src).toBe('https://x/a.mp3');
		expect(el.has('loadedmetadata')).toBe(true);
		el.currentTime = 0;
		el.dispatch('loadedmetadata');
		expect(el.currentTime).toBe(30);
		expect(mediaEngine.podcastPlaying).toBe(true);
		expect(mocks.claimAudio).toHaveBeenCalledWith('podcast');
		expect(view.isBuffering).toBe(true);
		await Promise.resolve();
		expect(el.play).toHaveBeenCalled();
	});

	it('does not re-arm when nothing is loaded', () => {
		const { add } = spyWindowListeners();
		const { player, el } = makePlayer(makeView({ currentEpisode: null }));
		player.scheduleReconnectResume('https://x/a.mp3', 5);
		const listener = listenerFor(add);

		listener();

		expect(el.play).not.toHaveBeenCalled();
		expect(mocks.claimAudio).not.toHaveBeenCalled();
	});
});

// ─────────────────────────────────────────────────────────────
// syncEpisodeAudioSource
// ─────────────────────────────────────────────────────────────

describe('syncEpisodeAudioSource', () => {
	it('loads the source, applies the resume position on loadedmetadata and sets now-playing', () => {
		const podcast = makePodcast();
		const episode = makeEpisode({ id: 'ep-1', audioUrl: 'https://x/ep1.mp3' });
		const view = makeView({ currentEpisode: { podcast, episode } });
		const { player, el } = makePlayer(view);

		player.syncEpisodeAudioSource(podcast, episode, 42);

		expect(el.src).toBe('https://x/ep1.mp3');
		expect(el.has('loadedmetadata')).toBe(true);
		el.currentTime = 0;
		el.dispatch('loadedmetadata');
		expect(el.currentTime).toBe(42);
		expect(view.currentTime).toBe(42);

		expect(mocks.setNowPlaying).toHaveBeenCalledWith({
			id: 'ep-1',
			source: 'podcast',
			title: 'Episode 1',
			subtitle: 'Cast',
			audioUrl: 'https://x/ep1.mp3',
			artworkUrl: 'https://example.com/art.jpg',
			duration: 1800,
		}, 'podcast');
		// claimPodcastControls ran as part of the sync.
		expect(mocks.setPlaybackHandlers).toHaveBeenCalledTimes(1);
	});

	it('does not add a position listener for a resume point at or below 10 s', () => {
		const { player, el } = makePlayer();
		player.syncEpisodeAudioSource(makePodcast(), makeEpisode({ audioUrl: 'https://x/ep.mp3' }), 10);
		expect(el.has('loadedmetadata')).toBe(false);
	});

	it('skips the source reload when the element already holds the url', () => {
		const { player, el } = makePlayer();
		el.src = 'https://x/ep.mp3';
		player.syncEpisodeAudioSource(makePodcast(), makeEpisode({ audioUrl: 'https://x/ep.mp3' }), 42);
		expect(el.playbackRate).toBe(1.0);
		expect(el.has('loadedmetadata')).toBe(false);
		expect(mocks.setNowPlaying).toHaveBeenCalledTimes(1);
	});
});

// ─────────────────────────────────────────────────────────────
// playEpisode
// ─────────────────────────────────────────────────────────────

describe('playEpisode', () => {
	it('claims the channel, resets speed, sets state and plays', () => {
		podcastSettings.playbackSpeed = 1.5;
		const podcast = makePodcast();
		const episode = makeEpisode({ id: 'ep-1', duration: 600, positionSec: 40 });
		podcastData.podcasts = [makePodcast({ episodes: [episode] })];
		const view = makeView();
		const { player, el } = makePlayer(view);

		player.playEpisode(podcast, episode);

		expect(podcastSettings.playbackSpeed).toBe(1.0);
		expect(view.currentEpisode).toEqual({ podcast, episode });
		expect(mediaEngine.podcastPlaying).toBe(true);
		expect(mocks.claimAudio).toHaveBeenCalledWith('podcast');
		expect(view.duration).toBe(600);
		expect(view.currentTime).toBe(40);
		expect(view.isBuffering).toBe(true);
		expect(mocks.setNowPlaying).toHaveBeenCalledTimes(1);
		expect(mocks.triggerPlaybackHaptic).toHaveBeenCalledWith(true);
		expect(el.play).toHaveBeenCalledTimes(1);
		// Recorded as the last-played episode with the resume point seeded.
		expect(podcastData.lastEpisodeId).toBe('ep-1');
		expect(podcastData.lastPodcastId).toBe(1);
		expect(podcastData.lastPositionSec).toBe(40);
	});

	it('rejects an episode with no audio URL without claiming or playing', () => {
		const { player, el } = makePlayer();
		player.playEpisode(makePodcast(), makeEpisode({ audioUrl: '' }));
		expect(mocks.addToast).toHaveBeenCalledWith({ message: 'This episode has no playable audio URL.', type: 'error' });
		expect(mocks.claimAudio).not.toHaveBeenCalled();
		expect(el.play).not.toHaveBeenCalled();
	});

	it('pauses the previous episode as a user pause when switching while playing', async () => {
		vi.useFakeTimers();
		const podcast = makePodcast();
		const playing = makeEpisode({ id: 'ep-old' });
		const next = makeEpisode({ id: 'ep-new', audioUrl: 'https://x/new.mp3' });
		const view = makeView({ isPlaying: true, currentEpisode: { podcast, episode: playing } });
		const { player, el } = makePlayer(view);
		player.attachElementListeners(el as unknown as HTMLAudioElement);

		player.playEpisode(podcast, next);
		expect(el.pause).toHaveBeenCalledTimes(1);
		expect(el.play).toHaveBeenCalledTimes(1);

		// The pause we triggered was flagged as user-initiated, so the element's
		// pause event that follows must not schedule a system-pause auto-resume.
		el.ended = false;
		el.dispatch('pause');
		await vi.advanceTimersByTimeAsync(500);
		expect(el.play).toHaveBeenCalledTimes(1);
	});
});

// ─────────────────────────────────────────────────────────────
// activateEpisode / togglePlay
// ─────────────────────────────────────────────────────────────

describe('activateEpisode / togglePlay', () => {
	it('toggles playback when the tapped episode is already current', () => {
		const podcast = makePodcast();
		const episode = makeEpisode({ id: 'ep-1' });
		const view = makeView({ isPlaying: true, currentEpisode: { podcast, episode } });
		const { player, el } = makePlayer(view);

		player.activateEpisode(podcast, episode);

		expect(mocks.markUserPaused).toHaveBeenCalledTimes(1);
		expect(el.pause).toHaveBeenCalledTimes(1);
	});

	it('plays a different episode', () => {
		const podcast = makePodcast();
		const current = makeEpisode({ id: 'ep-1' });
		const other = makeEpisode({ id: 'ep-2', audioUrl: 'https://x/2.mp3' });
		const view = makeView({ currentEpisode: { podcast, episode: current } });
		const { player, el } = makePlayer(view);

		player.activateEpisode(podcast, other);

		expect(view.currentEpisode?.episode.id).toBe('ep-2');
		expect(el.play).toHaveBeenCalledTimes(1);
	});
});

// ─────────────────────────────────────────────────────────────
// pausePlayback / resumePlayback
// ─────────────────────────────────────────────────────────────

describe('pausePlayback', () => {
	it('marks the deliberate pause, cancels the retry and pauses the element', () => {
		const { add, remove } = spyWindowListeners();
		const episode = makeEpisode({ id: 'ep-1' });
		const view = makeView({ isPlaying: true, currentEpisode: { podcast: makePodcast(), episode } });
		const { player, el } = makePlayer(view);
		player.scheduleReconnectResume('https://x/a.mp3', 5); // a pending retry
		const listener = listenerFor(add);
		remove.mockClear();

		player.pausePlayback();

		expect(mocks.markUserPaused).toHaveBeenCalledTimes(1);
		expect(remove).toHaveBeenCalledWith('online', listener); // cancelNetworkRetry
		expect(mocks.triggerPlaybackHaptic).toHaveBeenCalledWith(false);
		expect(el.pause).toHaveBeenCalledTimes(1);
		expect(mediaEngine.podcastPlaying).toBe(false);
	});

	it('no-ops when nothing is playing, has no episode, or has no element', () => {
		const { player, el } = makePlayer(makeView({ isPlaying: false }));
		player.pausePlayback();
		expect(el.pause).not.toHaveBeenCalled();
		expect(mocks.markUserPaused).not.toHaveBeenCalled();
	});
});

describe('resumePlayback', () => {
	it('claims the channel, then syncs, then plays — in that order', async () => {
		const order: string[] = [];
		mocks.claimAudio.mockImplementation(() => { order.push('claim'); });
		mocks.setNowPlaying.mockImplementation(() => { order.push('sync'); });
		const episode = makeEpisode({ id: 'ep-1' });
		const view = makeView({ isPlaying: false, currentEpisode: { podcast: makePodcast(), episode } });
		const { player, el } = makePlayer(view);
		el.play.mockImplementation(() => { order.push('play'); return Promise.resolve(); });

		player.resumePlayback();
		await Promise.resolve();

		expect(order).toEqual(['claim', 'sync', 'play']);
		expect(mediaEngine.podcastPlaying).toBe(true);
	});

	it('no-ops while already playing', () => {
		const view = makeView({ isPlaying: true, currentEpisode: { podcast: makePodcast(), episode: makeEpisode() } });
		const { player, el } = makePlayer(view);
		player.resumePlayback();
		expect(el.play).not.toHaveBeenCalled();
		expect(mocks.claimAudio).not.toHaveBeenCalled();
	});
});

// ─────────────────────────────────────────────────────────────
// prevEpisode / nextEpisode
// ─────────────────────────────────────────────────────────────

describe('prevEpisode / nextEpisode', () => {
	function threeEpisodes() {
		const podcast = makePodcast({ id: 1, episodes: [
			makeEpisode({ id: 'e1', audioUrl: 'https://x/1.mp3' }),
			makeEpisode({ id: 'e2', audioUrl: 'https://x/2.mp3' }),
			makeEpisode({ id: 'e3', audioUrl: 'https://x/3.mp3' }),
		] });
		podcastData.podcasts = [podcast];
		return podcast;
	}

	it('walks forward and backward through the list', () => {
		const podcast = threeEpisodes();
		const view = makeView({ currentEpisode: { podcast, episode: podcast.episodes[1] } });
		const { player } = makePlayer(view);

		player.nextEpisode();
		expect(view.currentEpisode?.episode.id).toBe('e3');

		player.prevEpisode();
		expect(view.currentEpisode?.episode.id).toBe('e2');
	});

	it('stops at the ends instead of wrapping', () => {
		const podcast = threeEpisodes();
		const view = makeView({ currentEpisode: { podcast, episode: podcast.episodes[0] } });
		const { player, el } = makePlayer(view);

		player.prevEpisode(); // already first
		expect(view.currentEpisode?.episode.id).toBe('e1');
		expect(el.play).not.toHaveBeenCalled();

		view.currentEpisode = { podcast, episode: podcast.episodes[2] };
		player.nextEpisode(); // already last
		expect(view.currentEpisode?.episode.id).toBe('e3');
		expect(el.play).not.toHaveBeenCalled();
	});

	it('no-ops when no episode is loaded or the podcast left the store', () => {
		const { player: p1, el: el1 } = makePlayer(makeView({ currentEpisode: null }));
		p1.nextEpisode();
		p1.prevEpisode();
		expect(el1.play).not.toHaveBeenCalled();

		const gone = makeView({ currentEpisode: { podcast: makePodcast({ id: 99 }), episode: makeEpisode() } });
		const { player: p2, el: el2 } = makePlayer(gone);
		p2.nextEpisode();
		p2.prevEpisode();
		expect(el2.play).not.toHaveBeenCalled();
	});
});

// ─────────────────────────────────────────────────────────────
// handleSeekSeconds
// ─────────────────────────────────────────────────────────────

describe('handleSeekSeconds', () => {
	it('sets the element time directly and mirrors it into currentTime', () => {
		const { player, view, el } = makePlayer();
		el.currentTime = 5;
		player.handleSeekSeconds(42);
		expect(el.currentTime).toBe(42);
		expect(view.currentTime).toBe(42);
	});
});

// ─────────────────────────────────────────────────────────────
// claimPodcastControls
// ─────────────────────────────────────────────────────────────

describe('claimPodcastControls', () => {
	it('registers play/pause/seek and next/prev handlers on the engine', () => {
		const { player } = makePlayer();
		player.claimPodcastControls();

		expect(mocks.setPlaybackHandlers).toHaveBeenCalledTimes(1);
		const [play, pause, seek] = mocks.setPlaybackHandlers.mock.calls[0];
		expect(play).toBeTypeOf('function');
		expect(pause).toBeTypeOf('function');
		expect(seek).toBeTypeOf('function');

		expect(mocks.setSkipHandlers).toHaveBeenCalledTimes(1);
		expect(mocks.setSkipHandlers.mock.calls[0][0]).toBeTypeOf('function');
		expect(mocks.setSkipHandlers.mock.calls[0][1]).toBeTypeOf('function');
	});

	it('routes the registered seek handler back into the transport', () => {
		const episode = makeEpisode({ id: 'ep-1' });
		const view = makeView({ currentEpisode: { podcast: makePodcast(), episode } });
		const { player, el } = makePlayer(view);
		player.claimPodcastControls();
		const seek = mocks.setPlaybackHandlers.mock.calls[0][2];

		seek(77);
		expect(el.currentTime).toBe(77);
		expect(view.currentTime).toBe(77);
	});
});

// ─────────────────────────────────────────────────────────────
// attachElementListeners — the moved element handlers
// ─────────────────────────────────────────────────────────────

describe('attachElementListeners', () => {
	const EVENTS = ['timeupdate', 'loadedmetadata', 'play', 'pause', 'ended', 'error', 'waiting', 'playing', 'stalled'];

	it('wires the nine events and removes them (and cancels the retry) on cleanup', () => {
		const { add, remove } = spyWindowListeners();
		const { player, el } = makePlayer();
		player.scheduleReconnectResume('https://x/a.mp3', 5);
		const listener = listenerFor(add);
		remove.mockClear();

		const cleanup = player.attachElementListeners(el as unknown as HTMLAudioElement);
		for (const type of EVENTS) expect(el.has(type)).toBe(true);

		cleanup();
		for (const type of EVENTS) expect(el.has(type)).toBe(false);
		expect(remove).toHaveBeenCalledWith('online', listener);
	});

	it('on ended marks the episode fully played and clears the engine item, without advancing', () => {
		const podcast = makePodcast({ id: 1, episodes: [
			makeEpisode({ id: 'e1', audioUrl: 'https://x/1.mp3' }),
			makeEpisode({ id: 'e2', audioUrl: 'https://x/2.mp3' }),
		] });
		podcastData.podcasts = [podcast];
		const view = makeView({ isPlaying: true, currentEpisode: { podcast, episode: podcast.episodes[0] } });
		const { player, el } = makePlayer(view);
		player.attachElementListeners(el as unknown as HTMLAudioElement);
		(mediaEngine as unknown as { item: unknown }).item = { id: 'e1', source: 'podcast', title: 'Episode 1', subtitle: 'Cast', audioUrl: 'https://x/1.mp3' };

		el.dispatch('ended');

		expect(view.isPlaying).toBe(false);
		expect(mediaEngine.podcastPlaying).toBe(false);
		expect(mediaEngine.item).toBeNull();
		// Marked fully played (progress 100, position 0) — and playback did not move.
		const stored = podcastData.podcasts[0].episodes[0];
		expect(stored.played).toBe(true);
		expect(stored.progress).toBe(100);
		expect(stored.positionSec).toBe(0);
		expect(view.currentEpisode?.episode.id).toBe('e1');
		expect(el.play).not.toHaveBeenCalled();
	});

	it('a system pause auto-resumes, but a user pause does not', async () => {
		vi.useFakeTimers();
		const view = makeView({ isPlaying: true, currentEpisode: { podcast: makePodcast(), episode: makeEpisode() } });
		const { player, el } = makePlayer(view);
		player.attachElementListeners(el as unknown as HTMLAudioElement);
		el.ended = false;

		// System pause (nothing flagged the pause as user-initiated).
		el.dispatch('pause');
		await vi.advanceTimersByTimeAsync(200);
		expect(el.play).toHaveBeenCalledTimes(1);
		el.play.mockClear();
		view.isPlaying = true;

		// A deliberate pause sets the user-pause flag via pausePlayback, so the
		// element 'pause' event that follows must not auto-resume.
		player.pausePlayback();
		el.dispatch('pause');
		await vi.advanceTimersByTimeAsync(200);
		expect(el.play).not.toHaveBeenCalled();
	});

	it('MEDIA_ERR_NETWORK (code 2) schedules a reconnect and toasts', () => {
		const { add } = spyWindowListeners();
		const view = makeView({ currentEpisode: { podcast: makePodcast(), episode: makeEpisode() } });
		const { player, el } = makePlayer(view);
		player.attachElementListeners(el as unknown as HTMLAudioElement);

		el.error = { code: 2 };
		el.dispatch('error');

		expect(mocks.addToast).toHaveBeenCalledWith({
			message: 'Connection lost — will resume when reconnected.', type: 'warning', autoDismissMs: 6000,
		});
		expect(add.mock.calls.some(c => c[0] === 'online')).toBe(true);
	});

	it('stalled reconnects only while the device reports it offline', () => {
		const { add } = spyWindowListeners();
		const view = makeView({ currentEpisode: { podcast: makePodcast(), episode: makeEpisode() } });
		const { player, el } = makePlayer(view);
		player.attachElementListeners(el as unknown as HTMLAudioElement);

		vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
		el.dispatch('stalled');
		expect(add.mock.calls.some(c => c[0] === 'online')).toBe(false);

		vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
		el.dispatch('stalled');
		expect(add.mock.calls.some(c => c[0] === 'online')).toBe(true);
	});

	it('an unsupported source stops playback without scheduling a reconnect', () => {
		const { add } = spyWindowListeners();
		const view = makeView({ isPlaying: true, currentEpisode: { podcast: makePodcast(), episode: makeEpisode() } });
		const { player, el } = makePlayer(view);
		player.attachElementListeners(el as unknown as HTMLAudioElement);

		el.error = { code: 4 }; // MEDIA_ERR_SRC_NOT_SUPPORTED
		el.dispatch('error');

		expect(view.isPlaying).toBe(false);
		expect(mediaEngine.podcastPlaying).toBe(false);
		expect(add.mock.calls.some(c => c[0] === 'online')).toBe(false);
	});
});
