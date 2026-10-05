import { describe, it, expect } from 'vitest';
import {
	isActiveEpisode,
	getEpisodeProgressPercent,
	getEpisodeProgressLabel,
	isNewEpisode,
	artworkFallback,
	NEW_EPISODE_WINDOW_MS,
	type EpisodeDisplay,
} from '$lib/podcast/episodeDisplay';

// ── helpers ──────────────────────────────────────────────────

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 0, 15, 12, 0, 0);

/** The view's active-episode pair; tests override the id. */
const active = (id = 'ep1') => ({ episode: { id } });

/** An inert episode; tests override the fields they drive. */
function episode(overrides: Partial<EpisodeDisplay> = {}): EpisodeDisplay {
	return { id: 'ep1', duration: 0, ...overrides };
}

/** ISO `publishedAt` for `days` before the pinned NOW. */
const publishedDaysAgo = (days: number) => new Date(NOW - days * DAY).toISOString();

// ─────────────────────────────────────────────────────────────
// isActiveEpisode
// ─────────────────────────────────────────────────────────────

describe('isActiveEpisode', () => {
	it('is true when the id matches the current episode', () => {
		expect(isActiveEpisode(episode({ id: 'ep1' }), active('ep1'))).toBe(true);
	});

	it('is false for a different id', () => {
		expect(isActiveEpisode(episode({ id: 'ep2' }), active('ep1'))).toBe(false);
	});

	it('is false when nothing is playing', () => {
		expect(isActiveEpisode(episode(), null)).toBe(false);
		expect(isActiveEpisode(episode(), undefined)).toBe(false);
	});
});

// ─────────────────────────────────────────────────────────────
// getEpisodeProgressPercent
// ─────────────────────────────────────────────────────────────

describe('getEpisodeProgressPercent', () => {
	it('returns the saved progress for a non-active episode', () => {
		expect(getEpisodeProgressPercent(episode({ id: 'ep2', progress: 42 }), active('ep1'), 30, 60)).toBe(42);
	});

	it('treats a missing saved progress as zero', () => {
		expect(getEpisodeProgressPercent(episode({ progress: null }), active(), 0, 0)).toBe(0);
	});

	it('returns the saved progress when there is no live position yet', () => {
		const ep = episode({ progress: 10 });
		expect(getEpisodeProgressPercent(ep, active(), 0, 600)).toBe(10);
	});

	it('returns the saved progress when neither duration is known', () => {
		const ep = episode({ progress: 10, duration: 0 });
		expect(getEpisodeProgressPercent(ep, active(), 30, 0)).toBe(10);
	});

	it('falls back to the episode duration when the live duration is zero', () => {
		const ep = episode({ duration: 100 });
		expect(getEpisodeProgressPercent(ep, active(), 25, 0)).toBe(25);
	});

	it('prefers the live duration over the episode duration', () => {
		const ep = episode({ duration: 100 });
		expect(getEpisodeProgressPercent(ep, active(), 50, 200)).toBe(25);
	});

	it('rounds to one decimal place', () => {
		expect(getEpisodeProgressPercent(episode({ duration: 3 }), active(), 1, 3)).toBe(33.3);
	});

	it('clamps to 100 when the position exceeds the duration', () => {
		expect(getEpisodeProgressPercent(episode({ duration: 60 }), active(), 90, 60)).toBe(100);
	});
});

// ─────────────────────────────────────────────────────────────
// getEpisodeProgressLabel
// ─────────────────────────────────────────────────────────────

describe('getEpisodeProgressLabel', () => {
	it('is empty for a non-active episode', () => {
		expect(getEpisodeProgressLabel(episode({ id: 'ep2', positionSec: 90 }), active('ep1'), 90, 600)).toBe('');
	});

	it('is empty when the active episode has no saved position', () => {
		expect(getEpisodeProgressLabel(episode({ positionSec: 0 }), active(), 0, 600)).toBe('');
	});

	it('falls back to the saved position when the live time is zero', () => {
		expect(getEpisodeProgressLabel(episode({ positionSec: 90 }), active(), 0, 600)).toBe('1:30 of 10:00');
	});

	it('formats a sub-hour position', () => {
		expect(getEpisodeProgressLabel(episode(), active(), 90, 600)).toBe('1:30 of 10:00');
	});

	it('formats an over-hour position', () => {
		expect(getEpisodeProgressLabel(episode(), active(), 3723, 7200)).toBe('1h 2m of 2h 0m');
	});

	it('reports only the position when the duration is unknown', () => {
		expect(getEpisodeProgressLabel(episode({ duration: 0 }), active(), 0, 0)).toBe('');
		expect(getEpisodeProgressLabel(episode({ positionSec: 90, duration: 0 }), active(), 0, 0)).toBe('Playing 1:30');
	});
});

// ─────────────────────────────────────────────────────────────
// isNewEpisode
// ─────────────────────────────────────────────────────────────

describe('isNewEpisode', () => {
	it('is new when unplayed, unheard and inside the window', () => {
		expect(isNewEpisode(episode({ publishedAt: publishedDaysAgo(13) }), NOW)).toBe(true);
	});

	it('is not new once past the window', () => {
		expect(isNewEpisode(episode({ publishedAt: publishedDaysAgo(15) }), NOW)).toBe(false);
	});

	it('is still new exactly at the window boundary', () => {
		expect(isNewEpisode(episode({ publishedAt: publishedDaysAgo(14) }), NOW)).toBe(true);
	});

	it('is not new one millisecond past the window', () => {
		const justPast = new Date(NOW - NEW_EPISODE_WINDOW_MS - 1).toISOString();
		expect(isNewEpisode(episode({ publishedAt: justPast }), NOW)).toBe(false);
	});

	it('is not new once played', () => {
		expect(isNewEpisode(episode({ publishedAt: publishedDaysAgo(1), played: true }), NOW)).toBe(false);
	});

	it('is not new once partly listened to (progress)', () => {
		expect(isNewEpisode(episode({ publishedAt: publishedDaysAgo(1), progress: 1 }), NOW)).toBe(false);
	});

	it('is not new once partly listened to (position)', () => {
		expect(isNewEpisode(episode({ publishedAt: publishedDaysAgo(1), positionSec: 5 }), NOW)).toBe(false);
	});

	it('is new when the publish date is missing or unparseable', () => {
		expect(isNewEpisode(episode({ publishedAt: null }), NOW)).toBe(true);
		expect(isNewEpisode(episode({ publishedAt: 'not a date' }), NOW)).toBe(true);
	});
});

// ─────────────────────────────────────────────────────────────
// artworkFallback
// ─────────────────────────────────────────────────────────────

describe('artworkFallback', () => {
	it('maps an id to a stable gradient', () => {
		expect(artworkFallback({ id: 0 })).toBe('from-indigo-500 to-purple-600');
		expect(artworkFallback({ id: 1 })).toBe('from-cyan-500 to-blue-600');
	});

	it('wraps around the palette', () => {
		expect(artworkFallback({ id: 4 })).toBe(artworkFallback({ id: 0 }));
	});

	it('does not depend on the artwork URL (with or without artwork)', () => {
		const withArt = { id: 2, artworkUrl: 'https://example.test/a.jpg' } as { id: number };
		const withoutArt = { id: 2 } as { id: number };
		expect(artworkFallback(withArt)).toBe(artworkFallback(withoutArt));
	});
});
