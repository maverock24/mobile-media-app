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

	// The podcast-data store persists a size-bounded snapshot (trim), so episode
	// history can never grow the localStorage blob past the WebView quota and kill
	// the store. Subscriptions (the must-survive data) are always fully written;
	// only heavy episode bodies are capped, keeping played/progress markers.
	it('persists a bounded snapshot: subscriptions kept, episodes capped, markers preserved', async () => {
		const { podcastData } = await import('$lib/stores/settings.svelte');

		// 150 episodes, newest-first. One OLD episode (index 130) was played.
		const episodes = Array.from({ length: 150 }, (_, i) => ({
			id: `ep-${i}`,
			title: `Episode ${i}`,
			description: 'x'.repeat(200),
			duration: 1800,
			publishedAt: `2026-01-${String((i % 28) + 1).padStart(2, '0')}T00:00:00Z`,
			played: i === 130,
			progress: i === 130 ? 100 : 0,
			positionSec: i === 130 ? 0 : 0,
			audioUrl: `https://example.com/audio-${i}.mp3`,
		}));
		podcastData.podcasts = [{
			id: 1, itunesId: 1, title: 'Big Cast', author: 'A', category: 'News',
			artworkUrl: '', feedUrl: 'https://example.com/feed.xml', subscribed: true,
			episodes, episodesLoaded: true,
		}];
		podcastData.nextId = 2;
		await new Promise((r) => setTimeout(r, 20));

		const raw = localStorage.getItem('podcast-data');
		expect(raw).not.toBeNull();
		const stored = JSON.parse(raw!);
		// Subscription manifest survives fully.
		expect(stored.podcasts).toHaveLength(1);
		expect(stored.podcasts[0].title).toBe('Big Cast');
		expect(stored.podcasts[0].subscribed).toBe(true);
		// Episode body is bounded well under the 150 in memory.
		expect(stored.podcasts[0].episodes.length).toBeLessThan(150);
		expect(stored.podcasts[0].episodes.length).toBeLessThanOrEqual(120);
		// The old played marker survives the cap.
		const ids = stored.podcasts[0].episodes.map((e: { id: string }) => e.id);
		expect(ids).toContain('ep-130');
		expect(ids).toContain('ep-0'); // newest kept
	});

	it('a failed localStorage write does NOT permanently disable the store', async () => {		// Regression: a single QuotaExceededError thrown inside the store's $effect
		// used to make Svelte tear that effect down, so every later mutation was
		// silently never persisted (while other, smaller stores kept working). A
		// failed write must not kill the store.
		const realSet = Storage.prototype.setItem.bind(localStorage);
		let podcastWrites = 0;
		vi.spyOn(Storage.prototype, 'setItem').mockImplementation((key: string, value: string) => {
			if (key === 'podcast-data' && podcastWrites === 0) {
				podcastWrites++;
				throw new DOMException('quota exceeded', 'QuotaExceededError');
			}
			if (key === 'podcast-data') podcastWrites++;
			realSet(key, value);
		});

		const { podcastData } = await import('$lib/stores/settings.svelte');

		podcastData.nextId = 1; // first podcast-data write → throws
		await new Promise((r) => setTimeout(r, 20));

		podcastData.nextId = 2; // store must survive and persist this one
		await new Promise((r) => setTimeout(r, 20));

		const raw = localStorage.getItem('podcast-data');
		expect(raw).not.toBeNull();
		expect(JSON.parse(raw!).nextId).toBe(2);
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
