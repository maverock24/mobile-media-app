import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the Drive low-level API so we control exactly what config is "downloaded".
vi.mock('$lib/drive-config', async (importOriginal) => {
	const actual = await importOriginal<typeof import('$lib/drive-config')>();
	return {
		...actual,
		downloadDriveConfig: vi.fn(),
		uploadDriveConfig: vi.fn(),
	};
});

const freshPodcast = {
	id: 1, itunesId: 999, title: 'Fresh Cast', author: 'A', category: 'News',
	artworkUrl: '', feedUrl: 'https://example.com/f.xml', subscribed: true,
	episodes: [], episodesLoaded: false,
};

function seedLocal(podcasts: unknown[]) {
	localStorage.setItem('podcast-data', JSON.stringify({
		podcasts,
		nextId: podcasts.length,
		lastEpisodeId: '',
		lastPodcastId: -1,
		lastPositionSec: 0,
	}));
}

function staleDriveConfig(savedAt: string) {
	return {
		version: 3,
		savedAt,
		music: {}, podcastSettings: {}, podcasts: [] as unknown[],
		lastEpisodeId: '', lastPodcastId: -1, lastPositionSec: 0,
	};
}

// Fresh module state + empty localStorage each test, like a real app restart.
beforeEach(async () => {
	localStorage.clear();
	vi.resetModules();
	vi.clearAllMocks();
});

async function connectDriveAndApply(downloadSavedAt: string) {
	const { driveConfigSync } = await import('$lib/stores/driveConfigSync.svelte');
	driveConfigSync.accessToken = 'tok';
	driveConfigSync.expiresAt = Date.now() + 3600_000;
	vi.mocked((await import('$lib/drive-config')).downloadDriveConfig)
		.mockResolvedValue(staleDriveConfig(downloadSavedAt) as never);
	await driveConfigSync.downloadAndApply();
	return (await import('$lib/stores/settings.svelte')).podcastData.podcasts;
}

describe('driveConfigSync must not delete podcasts added locally', () => {
	it('keeps a podcast added while offline when the Drive session is restored (regression)', async () => {
		// Existing user (has synced before → localSavedAt non-empty). They add a
		// podcast while the Drive session is unavailable. The sync's savedAt must
		// reflect this local change so the stale Drive config can't wipe it.
		seedLocal([freshPodcast]);
		localStorage.setItem('drive-config-local-saved-at', '2024-01-01T00:00:00.000Z');

		// Offline add — no Drive session yet. scheduleSave runs from the
		// podcastData change effect but hasSession is false.
		const { driveConfigSync } = await import('$lib/stores/driveConfigSync.svelte');
		driveConfigSync.scheduleSave();

		// Reconnect a few minutes later; Drive config is stale (predates the add).
		const podcasts = await connectDriveAndApply('2024-01-02T00:00:00.000Z');
		expect(podcasts.map((p: { title: string }) => p.title)).toContain('Fresh Cast');
	});

	it('first-time connect still pulls the Drive config (no local history)', async () => {
		// Fresh device: no localSavedAt, no local podcasts. Drive should win.
		seedLocal([]);
		const podcasts = await connectDriveAndApply('2024-01-02T00:00:00.000Z');
		expect(podcasts).toHaveLength(0);
	});
});
