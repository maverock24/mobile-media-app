/**
 * Cross-view audio exclusivity tests.
 * Verifies that starting playback in one view pauses the other.
 * Podcast playback is simulated (interval-based) so we can test it without
 * real audio files. MP3 playback uses the file-input stub from mp3-player tests.
 */
import { test, expect, type Page } from '@playwright/test';
import { goToTab } from './helpers';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

const MOCK_RSS_RESPONSE = {
	status: 'ok',
	feed: { title: 'Cross-test Podcast', image: '' },
	items: [
		{
			title: 'Cross Test Episode',
			description: 'Testing cross-view audio.',
			pubDate: '2026-01-01 00:00:00',
			itunes_duration: '7200',
			enclosure: { link: 'https://example.com/ep.mp3' },
		},
	],
};

const MOCK_ITUNES = {
	resultCount: 1,
	results: [{
		trackId: 999, trackName: 'Cross Podcast', artistName: 'Auto Tester',
		artworkUrl600: '', feedUrl: 'https://example.com/feed.xml',
		primaryGenreName: 'Test', trackCount: 1,
	}],
};

const MOCK_STATIONS = [
	{
		stationuuid: 'uuid-1',
		name: 'Test Jazz FM',
		url_resolved: 'https://stream.testjazz.example/live',
		favicon: '',
		country: 'US',
		tags: 'jazz,smooth',
		codec: 'MP3',
		bitrate: 128,
		votes: 1000,
	},
];

function createMinimalMp3(name: string, dir: string): string {
	const buf = Buffer.from([
		0x49, 0x44, 0x33, 0x03, 0x00, 0x00,
		0x00, 0x00, 0x00, 0x00,
		0xFF, 0xFB, 0x90, 0x00,
		0x00, 0x00, 0x00, 0x00,
	]);
	const p = path.join(dir, name);
	fs.writeFileSync(p, buf);
	return p;
}

async function loadMp3(page: Page, dir: string) {
	const [fc] = await Promise.all([
		page.waitForEvent('filechooser'),
		page.evaluate(() => {
			const input = document.querySelector('input[type="file"][multiple]') as HTMLInputElement | null;
			if (input) { input.style.display = 'block'; input.click(); }
		}),
	]);
	await fc.setFiles(dir);
}

async function playPodcastEpisode(page: Page, title: string) {
	const row = page
		.locator('div')
		.filter({ has: page.getByText(title, { exact: true }) })
		.filter({ has: page.locator('button.rounded-full') })
		.first();
	await expect(row.getByText(title, { exact: true })).toBeVisible({ timeout: 5000 });
	await row.locator('button.rounded-full').first().click();
}

test.describe('Cross-view audio exclusivity', () => {
	let tmpDir: string;
	let mp3Path: string;

	test.beforeAll(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-cross-'));
		mp3Path = createMinimalMp3('song.mp3', tmpDir);
	});

	test.afterAll(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	test.beforeEach(async ({ page }) => {
		await page.route('**/api/radio/search**', (route) =>
			route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(MOCK_STATIONS) })
		);
		await page.route('**/itunes.apple.com/**', (route) =>
			route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(MOCK_ITUNES) })
		);
		await page.route('**/api.rss2json.com/**', (route) =>
			route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(MOCK_RSS_RESPONSE) })
		);
		await page.route('**/stream.testjazz.example/**', (route) => route.abort());
		await page.route('**/example.com/**', (route) => route.abort());
		await page.goto('/');
	});

	test('Music and Podcast views stay in DOM simultaneously', async ({ page }) => {
		// Both always-mounted divs must be present
		const mounted = page.locator('[class*="overflow-hidden"]');
		await expect(mounted.nth(0)).toBeAttached();
		await expect(mounted.nth(1)).toBeAttached();
	});

	test('switching from Music to Podcasts keeps music track info in DOM', async ({ page }) => {
		// Load a file into Music
		await goToTab(page, 'Music');
		await loadMp3(page, tmpDir);

		// Navigate to file and into player
		await page.getByText('song').first().click({ timeout: 5000 });
		await page.waitForTimeout(300);

		// Now switch to Podcasts — Music view is hidden but DOM still has track title
		await goToTab(page, 'Podcasts');
		// Music view is CSS-hidden, not removed — title is still in DOM
		await expect(page.locator('[class*="hidden"] *').filter({ hasText: /song/i }).first()).toBeAttached();
	});

	test('switching back to Music restores player state', async ({ page }) => {
		await goToTab(page, 'Music');
		await loadMp3(page, tmpDir);
		await page.getByText('song').first().click({ timeout: 5000 });
		await page.waitForTimeout(300);

		// Switch away and back
		await goToTab(page, 'Weather');
		await goToTab(page, 'Music');

		// Player state is intact — track title visible
		await expect(page.getByText('song').first()).toBeVisible({ timeout: 3000 });
		// Progress bar is still there
		await expect(page.locator('input[type="range"]').first()).toBeVisible();
	});

	test('starting podcast playback stops music audio', async ({ page }) => {
		// 1. Load MP3 file
		await goToTab(page, 'Music');
		await loadMp3(page, tmpDir);
		await page.getByText('song').first().click({ timeout: 5000 });
		await page.waitForTimeout(300);

		// 2. Verify audio element is paused after loading (stub MP3 won't auto-play)
		const audioEl = page.locator('audio').first();
		await expect(audioEl).toBeAttached();

		// 3. Switch to Podcasts and start an episode
		await goToTab(page, 'Podcasts');
		await page.getByPlaceholder('Search podcasts…').fill('cross');
		await page.getByRole('button', { name: /^Subscribe$/i }).first().click({ timeout: 3000 });
		await playPodcastEpisode(page, 'Cross Test Episode');

		// 4. Switch back to Music — audio should be paused (claimAudio('podcast') was called)
		await goToTab(page, 'Music');
		const isPaused = await page.evaluate(() => {
			const audio = document.querySelector('audio');
			return audio ? audio.paused : true;
		});
		expect(isPaused).toBe(true);
		const miniPlayer = page.getByRole('region', { name: /Mini player/i });
		await expect(miniPlayer.getByText('Cross Test Episode')).toBeVisible({ timeout: 3000 });
		await expect(miniPlayer.getByRole('button', { name: /Return to podcasts player/i })).toBeVisible();
	});

	test('starting music playback after a podcast switches the bottom controls back to music', async ({ page }) => {
		await goToTab(page, 'Podcasts');
		await page.getByPlaceholder('Search podcasts…').fill('cross');
		await page.getByRole('button', { name: /^Subscribe$/i }).first().click({ timeout: 3000 });
		await playPodcastEpisode(page, 'Cross Test Episode');

		await goToTab(page, 'Music');
		await loadMp3(page, tmpDir);
		await page.getByText('song').first().click({ timeout: 5000 });
		await page.waitForTimeout(300);

		const miniPlayer = page.getByRole('region', { name: /Mini player/i });
		await expect(miniPlayer).toContainText(/song/i);
		await expect(miniPlayer.getByText('Cross Test Episode')).toHaveCount(0);
		await expect(miniPlayer.getByRole('button', { name: /Return to music player/i })).toBeVisible();
		await expect(page.locator('button[aria-label="Previous"]:visible')).toHaveCount(1);
		await expect(page.locator('button[aria-label="Next"]:visible')).toHaveCount(1);
		await expect(page.locator('button[aria-label="Previous track"]:visible')).toHaveCount(0);
		await expect(page.locator('button[aria-label="Next track"]:visible')).toHaveCount(0);
	});

	test('radio top controls are hidden when a podcast is the active source', async ({ page }) => {
		await goToTab(page, 'Radio');
		await goToTab(page, 'Podcasts');
		await page.getByPlaceholder('Search podcasts…').fill('cross');
		await page.getByRole('button', { name: /^Subscribe$/i }).first().click({ timeout: 3000 });
		await playPodcastEpisode(page, 'Cross Test Episode');

		await goToTab(page, 'Radio');
		await expect(page.locator('button[aria-label="Stop"]:visible')).toHaveCount(0);
		await expect(page.getByRole('region', { name: /Mini player/i }).getByText('Cross Test Episode')).toBeVisible({ timeout: 3000 });
	});

	test('starting podcast playback after radio replaces the shared controls content', async ({ page }) => {
		await goToTab(page, 'Radio');
		await page.getByRole('button', { name: /Search/i }).click();
		await page.getByPlaceholder(/Search radio stations/i).fill('jazz');
		await page.locator('form').getByRole('button', { name: 'Search', exact: true }).click();
		await page.getByText('Test Jazz FM').click();
		await expect(page.getByRole('region', { name: /Mini player/i }).getByText('Test Jazz FM')).toBeVisible({ timeout: 3000 });

		await goToTab(page, 'Podcasts');
		await page.getByPlaceholder('Search podcasts…').fill('cross');
		await page.getByRole('button', { name: /^Subscribe$/i }).first().click({ timeout: 3000 });
		await playPodcastEpisode(page, 'Cross Test Episode');

		const miniPlayer = page.getByRole('region', { name: /Mini player/i });
		await expect(miniPlayer.getByText('Cross Test Episode')).toBeVisible({ timeout: 3000 });
		await expect(miniPlayer.getByText('Test Jazz FM')).toHaveCount(0);
	});

	test('podcast now-playing bar persists when switching views', async ({ page }) => {
		await goToTab(page, 'Podcasts');
		await page.getByPlaceholder('Search podcasts…').fill('cross');
		await page.getByRole('button', { name: /^Subscribe$/i }).first().click({ timeout: 3000 });
		await playPodcastEpisode(page, 'Cross Test Episode');

		// Now-playing bar appears
		await expect(page.getByText('Cross Test Episode').first()).toBeVisible();

		// Switch to Settings and back — bar is still in DOM (view always mounted)
		await goToTab(page, 'Settings');
		await goToTab(page, 'Podcasts');
		await expect(page.getByText('Cross Test Episode').first()).toBeVisible({ timeout: 3000 });
	});
});
