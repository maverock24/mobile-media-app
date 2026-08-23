import { describe, it, expect, vi, beforeEach } from 'vitest';

// Confirms the base localStorage persistence path is sound: a newly subscribed
// podcast is written synchronously on mutation. (The bug that removed podcasts
// was the Drive config apply, covered in podcast-drive-sync.test.ts.)

beforeEach(async () => {
	localStorage.clear();
	vi.resetModules();
});

describe('podcastData persistence across app restart', () => {
	it('a newly subscribed podcast is persisted synchronously to localStorage', async () => {
		const { podcastData } = await import('$lib/stores/settings.svelte');
		podcastData.podcasts = [...podcastData.podcasts, {
			id: ++podcastData.nextId,
			itunesId: 12345,
			title: 'Fresh Cast',
			author: 'Author',
			category: 'News',
			artworkUrl: '',
			feedUrl: 'https://example.com/feed.xml',
			subscribed: true,
			episodes: [],
			episodesLoaded: false,
		}];

		// Persisted store writes synchronously; yield a tick for the effect.
		await new Promise((r) => setTimeout(r, 10));

		const raw = localStorage.getItem('podcast-data');
		expect(raw).not.toBeNull();
		const stored = JSON.parse(raw!);
		expect(stored.podcasts).toHaveLength(1);
		expect(stored.podcasts[0].title).toBe('Fresh Cast');
		expect(stored.podcasts[0].subscribed).toBe(true);
		// nextId persisted so a future podcast gets a fresh, non-colliding id.
		expect(stored.nextId).toBe(1);
	});

	it('podcasts saved by a previous version survive a fresh app start (update)', async () => {
		// Simulate localStorage as written by an OLDER build, then boot the app
		// fresh (like an APK update): the stored podcasts must load.
		localStorage.setItem('podcast-data', JSON.stringify({
			podcasts: [{
				id: 7, itunesId: 999, title: 'Old Cast', author: 'A', category: 'News',
				artworkUrl: '', feedUrl: 'https://example.com/f.xml', subscribed: true,
				episodes: [], episodesLoaded: false,
			}],
			nextId: 8, lastEpisodeId: '', lastPodcastId: -1, lastPositionSec: 0,
		}));

		const { podcastData } = await import('$lib/stores/settings.svelte');
		expect(podcastData.podcasts).toHaveLength(1);
		expect(podcastData.podcasts[0].title).toBe('Old Cast');
		expect(podcastData.podcasts[0].subscribed).toBe(true);
	});

	it('full cycle: a new subscription added in one session survives a restart', async () => {
		// Session 1: subscribe to a new podcast.
		const { podcastData } = await import('$lib/stores/settings.svelte');
		podcastData.podcasts = [...podcastData.podcasts, {
			id: ++podcastData.nextId, itunesId: 555, title: 'New Cast', author: 'A',
			category: 'News', artworkUrl: '', feedUrl: 'https://example.com/new.xml',
			subscribed: true, episodes: [], episodesLoaded: false,
		}];
		await new Promise((r) => setTimeout(r, 10)); // flush persisted store
		const raw = localStorage.getItem('podcast-data');
		expect(JSON.parse(raw!).podcasts.some((p: { itunesId: number }) => p.itunesId === 555)).toBe(true);

		// Session 2: fresh app start.
		vi.resetModules();
		const { podcastData: reloaded } = await import('$lib/stores/settings.svelte');
		expect(reloaded.podcasts.some((p: { itunesId: number }) => p.itunesId === 555)).toBe(true);
		expect(reloaded.podcasts).toHaveLength(1);
	});
});
