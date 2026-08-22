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
});
