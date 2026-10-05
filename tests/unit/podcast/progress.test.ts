import { describe, it, expect, beforeEach } from 'vitest';
import {
	syncPersistedEpisodeState,
	markEpisodeFullyPlayed,
	mergeEpisodeHistory,
	getEpisodeResumePosition,
	shouldPersistProgress,
	PROGRESS_PERSIST_MS,
	type ActiveEpisode,
	type PodcastProgressView,
} from '$lib/podcast/progress';
import {
	podcastData,
	type PersistedEpisode,
	type PersistedPodcast,
} from '$lib/stores/settings.svelte';

// These tests assert the in-memory mutations of the four progress functions.
// The localStorage side of the store (write shape, quota survival, trim) is
// already covered by tests/unit/models/podcast-persist.test.ts; this file does
// not touch localStorage or module reloading so the two suites do not overlap.

const makeEpisode = (over: Partial<PersistedEpisode> = {}): PersistedEpisode => ({
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
	episodesLoaded: true,
	...over,
});

/** A plain mutable accessor, the same shape the view injects (plain object is
 *  structurally assignable to PodcastProgressView). */
function makeView(
	selectedPodcast: PersistedPodcast | null = null,
	currentEpisode: ActiveEpisode | null = null,
): PodcastProgressView {
	return { selectedPodcast, currentEpisode };
}

beforeEach(() => {
	podcastData.podcasts = [];
	podcastData.lastEpisodeId = '';
	podcastData.lastPodcastId = -1;
	podcastData.lastPositionSec = 0;
});

// ─────────────────────────────────────────────────────────────
// syncPersistedEpisodeState
// ─────────────────────────────────────────────────────────────

describe('syncPersistedEpisodeState', () => {
	it('writes the playback fields onto the stored episode and preserves the rest', () => {
		const stored = makeEpisode({ title: 'Stored Title', duration: 1800 });
		podcastData.podcasts = [makePodcast({ episodes: [stored] })];
		const view = makeView();

		syncPersistedEpisodeState(1, makeEpisode({
			title: 'Incoming Title',
			played: true,
			progress: 42.5,
			positionSec: 123.5,
			duration: 999,
		}), view);

		const written = podcastData.podcasts[0].episodes[0];
		expect(written.played).toBe(true);
		expect(written.progress).toBe(42.5);
		expect(written.positionSec).toBe(123.5);
		expect(written.duration).toBe(999);
		// Stored fields not carried by the four copied keys survive.
		expect(written.title).toBe('Stored Title');
		expect(written.audioUrl).toBe('https://example.com/audio-1.mp3');
		// Only the matching episode is replaced.
		expect(podcastData.podcasts[0].episodes).toHaveLength(1);
	});

	it('defaults a missing positionSec to 0', () => {
		const stored = makeEpisode({ positionSec: 77 });
		podcastData.podcasts = [makePodcast({ episodes: [stored] })];
		const incomplete = { ...makeEpisode(), positionSec: undefined } as unknown as PersistedEpisode;

		syncPersistedEpisodeState(1, incomplete, makeView());

		expect(podcastData.podcasts[0].episodes[0].positionSec).toBe(0);
	});

	it('mirrors the replacement into selectedPodcast and currentEpisode when they match', () => {
		const stored = makeEpisode();
		const podcast = makePodcast({ episodes: [stored] });
		podcastData.podcasts = [podcast];
		const view = makeView(podcast, { podcast, episode: stored });

		syncPersistedEpisodeState(1, makeEpisode({ played: true, progress: 100, positionSec: 5 }), view);

		expect(view.selectedPodcast?.episodes[0].played).toBe(true);
		expect(view.selectedPodcast?.episodes[0].progress).toBe(100);
		expect(view.currentEpisode?.episode.progress).toBe(100);
		expect(view.currentEpisode?.podcast.id).toBe(1);
	});

	it('leaves selectedPodcast and currentEpisode alone when they do not match', () => {
		const stored = makeEpisode();
		const podcast = makePodcast({ episodes: [stored] });
		podcastData.podcasts = [podcast];
		const other = makePodcast({ id: 2, episodes: [makeEpisode({ id: 'ep-2' })] });
		const view = makeView(other, { podcast: other, episode: other.episodes[0] });

		syncPersistedEpisodeState(1, makeEpisode({ progress: 10 }), view);

		expect(view.selectedPodcast).toBe(other);
		expect(view.currentEpisode?.episode.id).toBe('ep-2');
	});

	it('bails silently when the podcast or the episode is absent', () => {
		podcastData.podcasts = [makePodcast({ episodes: [makeEpisode()] })];
		const view = makeView();

		syncPersistedEpisodeState(99, makeEpisode({ progress: 50 }), view); // no such podcast
		syncPersistedEpisodeState(1, makeEpisode({ id: 'ghost', progress: 50 }), view); // no such episode

		expect(podcastData.podcasts[0].episodes[0].progress).toBe(0);
		expect(podcastData.podcasts).toHaveLength(1);
	});
});

// ─────────────────────────────────────────────────────────────
// shouldPersistProgress (the throttle boundary)
// ─────────────────────────────────────────────────────────────

describe('shouldPersistProgress', () => {
	it('flushes at exactly the interval and not one millisecond earlier', () => {
		expect(shouldPersistProgress(0, PROGRESS_PERSIST_MS)).toBe(true);
		expect(shouldPersistProgress(0, PROGRESS_PERSIST_MS - 1)).toBe(false);
	});

	it('measures from the last persist, not from zero', () => {
		expect(shouldPersistProgress(1000, 1000 + PROGRESS_PERSIST_MS)).toBe(true);
		expect(shouldPersistProgress(1000, 1000 + PROGRESS_PERSIST_MS - 1)).toBe(false);
	});

	it('accepts an explicit interval', () => {
		expect(shouldPersistProgress(500, 1500, 1000)).toBe(true);
		expect(shouldPersistProgress(500, 1499, 1000)).toBe(false);
	});
});

// ─────────────────────────────────────────────────────────────
// markEpisodeFullyPlayed
// ─────────────────────────────────────────────────────────────

describe('markEpisodeFullyPlayed', () => {
	it('marks the episode played, persists it, and records it as last-played', () => {
		const stored = makeEpisode({ progress: 60, positionSec: 1200 });
		const podcast = makePodcast({ episodes: [stored] });
		podcastData.podcasts = [podcast];
		const episode = makeEpisode({ progress: 60, positionSec: 1200 });

		markEpisodeFullyPlayed(1, episode, makeView());

		// The passed object is mutated in place.
		expect(episode.played).toBe(true);
		expect(episode.progress).toBe(100);
		expect(episode.positionSec).toBe(0);
		// And so is the stored copy.
		const written = podcastData.podcasts[0].episodes[0];
		expect(written.played).toBe(true);
		expect(written.progress).toBe(100);
		expect(written.positionSec).toBe(0);
		// Store bookkeeping.
		expect(podcastData.lastEpisodeId).toBe('ep-1');
		expect(podcastData.lastPodcastId).toBe(1);
		expect(podcastData.lastPositionSec).toBe(0);
	});
});

// ─────────────────────────────────────────────────────────────
// mergeEpisodeHistory
// ─────────────────────────────────────────────────────────────

describe('mergeEpisodeHistory', () => {
	it('keeps the saved playback state when the incoming record is older', () => {
		const saved = makeEpisode({ played: true, progress: 50, positionSec: 30 });
		podcastData.podcasts = [makePodcast({ episodes: [saved] })];
		const older = makeEpisode({ played: false, progress: 0, positionSec: 0 });

		const [merged] = mergeEpisodeHistory(1, [older]);

		expect(merged.played).toBe(true);
		expect(merged.progress).toBe(50);
		expect(merged.positionSec).toBe(30);
	});

	it('takes the new metadata but the saved playback state when the incoming record is newer', () => {
		const saved = makeEpisode({ played: false, progress: 50, positionSec: 30, title: 'Old Title', duration: 100 });
		podcastData.podcasts = [makePodcast({ episodes: [saved] })];
		const newer = makeEpisode({
			played: false,
			progress: 0,
			positionSec: 0,
			title: 'New Title',
			duration: 200,
			audioUrl: 'https://example.com/audio-1.mp3',
		});

		const [merged] = mergeEpisodeHistory(1, [newer]);

		// Incoming metadata wins.
		expect(merged.title).toBe('New Title');
		expect(merged.duration).toBe(200);
		// Saved playback state is the winner on disagreement.
		expect(merged.progress).toBe(50);
		expect(merged.positionSec).toBe(30);
	});

	it('matches by audioUrl when the id changed and remaps lastEpisodeId', () => {
		const saved = makeEpisode({ id: 'old-id', progress: 50, positionSec: 30 });
		podcastData.podcasts = [makePodcast({ episodes: [saved] })];
		podcastData.lastPodcastId = 1;
		podcastData.lastEpisodeId = 'old-id';
		const incoming = makeEpisode({ id: 'new-id', progress: 0, positionSec: 0 });

		const [merged] = mergeEpisodeHistory(1, [incoming]);

		expect(merged.id).toBe('new-id');
		expect(merged.progress).toBe(50);
		expect(podcastData.lastEpisodeId).toBe('new-id');
	});

	it('matches by title and publishedAt as a last resort', () => {
		const saved = makeEpisode({ id: 'old-id', audioUrl: '', progress: 50, positionSec: 30 });
		podcastData.podcasts = [makePodcast({ episodes: [saved] })];
		const incoming = makeEpisode({ id: 'new-id', audioUrl: '', progress: 0, positionSec: 0 });

		const [merged] = mergeEpisodeHistory(1, [incoming]);

		expect(merged.progress).toBe(50);
		expect(merged.positionSec).toBe(30);
	});

	it('returns an unmatched episode unchanged', () => {
		podcastData.podcasts = [makePodcast({ episodes: [makeEpisode()] })];
		const fresh = makeEpisode({ id: 'fresh', audioUrl: 'https://example.com/fresh.mp3', title: 'Fresh' });

		const [merged] = mergeEpisodeHistory(1, [fresh]);

		expect(merged).toEqual(fresh);
	});
});

// ─────────────────────────────────────────────────────────────
// getEpisodeResumePosition
// ─────────────────────────────────────────────────────────────

describe('getEpisodeResumePosition', () => {
	it('returns the episode saved position when it is not the last-played episode', () => {
		podcastData.lastEpisodeId = 'other';
		podcastData.lastPositionSec = 999;

		expect(getEpisodeResumePosition(makeEpisode({ positionSec: 120 }))).toBe(120);
	});

	it('returns 0 when a non-last-played episode has no saved position', () => {
		podcastData.lastEpisodeId = 'other';

		expect(getEpisodeResumePosition(makeEpisode({ positionSec: undefined as unknown as number }))).toBe(0);
	});

	it('returns the larger of the saved position and lastPositionSec for the last-played episode', () => {
		podcastData.lastEpisodeId = 'ep-1';
		podcastData.lastPositionSec = 40;

		expect(getEpisodeResumePosition(makeEpisode({ positionSec: 10 }))).toBe(40);
		expect(getEpisodeResumePosition(makeEpisode({ positionSec: 80 }))).toBe(80);
	});
});
