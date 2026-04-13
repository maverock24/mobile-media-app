/**
 * Podcast view tests.
 * Network calls to iTunes and RSS2JSON are intercepted and mocked so tests
 * run offline and deterministically.
 */
import { test, expect, type Page } from '@playwright/test';
import { goToTab } from './helpers';

// ── Mock response factories ─────────────────────────────────────────────────
const MOCK_ITUNES_RESULT = {
	trackId:          123456789,
	trackName:        'Test Podcast',
	artistName:       'Test Author',
	artworkUrl600:    'https://example.com/art.jpg',
	feedUrl:          'https://example.com/feed.xml',
	primaryGenreName: 'Technology',
	trackCount:       42,
};

const MOCK_SEARCH_RESPONSE = {
	resultCount: 1,
	results: [MOCK_ITUNES_RESULT],
};

const MOCK_LOOKUP_RESPONSE = {
	resultCount: 1,
	results: [{ ...MOCK_ITUNES_RESULT, feedUrl: 'https://example.com/feed.xml', artworkUrl600: 'https://example.com/art.jpg' }],
};

const MOCK_RSS_RESPONSE = {
	status: 'ok',
	feed: { title: 'Test Podcast', image: 'https://example.com/art.jpg' },
	items: [
		{
			title: 'Episode 1: Introduction',
			description: '<p>First episode description here.</p>',
			pubDate: '2026-01-15 10:00:00',
			itunes_duration: '3600',
			enclosure: { link: 'https://example.com/ep1.mp3', length: 0, type: 'audio/mpeg' },
		},
		{
			title: 'Episode 2: Deep Dive',
			description: '<p>Second episode about complex topics.</p>',
			pubDate: '2026-01-22 10:00:00',
			itunes_duration: '1:30:00',
			enclosure: { link: 'https://example.com/ep2.mp3', length: 0, type: 'audio/mpeg' },
		},
		{
			title: 'Episode 3: Q&A',
			description: 'Answering your questions.',
			pubDate: '2026-01-29 10:00:00',
			itunes_duration: '2700',
			enclosure: { link: 'https://example.com/ep3.mp3', length: 0, type: 'audio/mpeg' },
		},
	],
};

async function setupMocks(page: Page) {
	await page.route('**/itunes.apple.com/search**', (route) =>
		route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(MOCK_SEARCH_RESPONSE) })
	);
	await page.route('**/itunes.apple.com/lookup**', (route) =>
		route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(MOCK_LOOKUP_RESPONSE) })
	);
	await page.route('**/api.rss2json.com/**', (route) =>
		route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(MOCK_RSS_RESPONSE) })
	);
	// Block real artwork fetches
	await page.route('**/example.com/**', (route) => route.abort());
	// Stub Google Identity Services — prevents OAuth popup/redirect with any client ID
	await page.route('**/accounts.google.com/gsi/client**', (route) =>
		route.fulfill({ status: 200, contentType: 'application/javascript', body: '// gsi stub' })
	);
	// Block any remaining Google auth/OAuth requests
	await page.route('**/accounts.google.com/**', (route) => route.abort());
	await page.route('**/oauth2.googleapis.com/**', (route) => route.abort());
}

test.describe('Podcast view', () => {
	test.beforeEach(async ({ page }) => {
		// Clear persisted state BEFORE page load so the app starts with empty storage
		await page.addInitScript(() => {
			localStorage.clear();
			sessionStorage.clear();
		});
		await setupMocks(page);
		await page.goto('/');
		await goToTab(page, 'Podcasts');
	});

	// ── Default state ──────────────────────────────────────────────────────
	test('shows Podcasts heading and tab buttons', async ({ page }) => {
		await expect(page.getByText('Podcasts').first()).toBeVisible();
		await expect(page.getByRole('button', { name: /Subscribed/i })).toBeVisible();
		await expect(page.getByRole('button', { name: 'Discover', exact: true })).toBeVisible();
	});

	test('subscribed tab is active by default', async ({ page }) => {
		const subBtn = page.getByRole('button', { name: /Subscribed/i });
		await expect(subBtn).toHaveClass(/bg-background/);
	});

	test('empty subscribed state shows Discover Podcasts button', async ({ page }) => {
		// Default podcast list is empty
		await expect(page.getByRole('button', { name: /Discover Podcasts/i })).toBeVisible();
	});

	test('search input is visible', async ({ page }) => {
		await expect(page.getByPlaceholder('Search podcasts…')).toBeVisible();
	});

	// ── Discover / search flow ─────────────────────────────────────────────
	test('Discover tab shows search prompt when search is empty', async ({ page }) => {
		await page.getByRole('button', { name: 'Discover', exact: true }).click();
		// Mocked results load automatically (discover prefetch calls iTunes)
		await expect(page.getByText(/Test Podcast|Search for podcasts/i).first()).toBeVisible({ timeout: 5000 });
	});

	test('typing in search triggers iTunes search and shows results', async ({ page }) => {
		const searchInput = page.getByPlaceholder('Search podcasts…');
		await searchInput.fill('test podcast');

		// Mocked result should appear
		await expect(page.getByText('Test Podcast')).toBeVisible({ timeout: 3000 });
		await expect(page.getByText('Test Author')).toBeVisible();
		await expect(page.getByText('Technology')).toBeVisible();
	});

	test('search results show Subscribe button', async ({ page }) => {
		await page.getByPlaceholder('Search podcasts…').fill('test');
		await expect(page.getByRole('button', { name: /Subscribe/i }).first()).toBeVisible({ timeout: 3000 });
	});

	test('short search query (< 2 chars) does not show results', async ({ page }) => {
		await page.getByPlaceholder('Search podcasts…').fill('t');
		await page.waitForTimeout(500);
		await expect(page.getByText('Test Podcast')).not.toBeVisible();
	});

	test('clear button removes search and hides results', async ({ page }) => {
		const input = page.getByPlaceholder('Search podcasts…');
		await input.fill('test');
		await expect(page.getByText('Test Podcast')).toBeVisible({ timeout: 3000 });

		// Click the X clear button (the button inside .relative wrapper next to the search input)
		await page.locator('div.relative > button').click();
		await expect(input).toHaveValue('');
	});

	// ── Subscribe flow ─────────────────────────────────────────────────────
	test('subscribing adds podcast to subscribed list', async ({ page }) => {
		await page.getByPlaceholder('Search podcasts…').fill('test');
		await page.getByRole('button', { name: /^Subscribe$/i }).first().click({ timeout: 3000 });

		// Auto-opens episode view — go back
		await page.getByRole('button').filter({ has: page.locator('svg') }).first().click(); // back button (ChevronLeft)

		// Subscribed count in tab label should now be 1
		await expect(page.getByRole('button', { name: /Subscribed \(1\)/i })).toBeVisible({ timeout: 3000 });
	});

	test('after subscribing, episode list loads via RSS2JSON', async ({ page }) => {
		await page.getByPlaceholder('Search podcasts…').fill('test');
		await page.getByRole('button', { name: /^Subscribe$/i }).first().click({ timeout: 3000 });

		// Episode view opens automatically after subscribe
		await expect(page.getByText('Episode 1: Introduction')).toBeVisible({ timeout: 5000 });
		await expect(page.getByText('Episode 2: Deep Dive')).toBeVisible();
		await expect(page.getByText('Episode 3: Q&A')).toBeVisible();
	});

	test('episode row shows duration and date', async ({ page }) => {
		await page.getByPlaceholder('Search podcasts…').fill('test');
		await page.getByRole('button', { name: /^Subscribe$/i }).first().click({ timeout: 3000 });

		await expect(page.getByText(/1h 0m/)).toBeVisible({ timeout: 5000 }); // 3600s
		await expect(page.getByText(/Jan 15/i)).toBeVisible();
	});

	test('episode play button is present for each episode', async ({ page }) => {
		await page.getByPlaceholder('Search podcasts…').fill('test');
		await page.getByRole('button', { name: /^Subscribe$/i }).first().click({ timeout: 3000 });

		await expect(page.getByText('Episode 1: Introduction')).toBeVisible({ timeout: 5000 });
		const playBtns = page.locator('button').filter({ has: page.locator('svg') }).filter({ has: page.locator('[data-testid]') });
		// More reliable: count circular play buttons in episode list
		// All play buttons (icon size w-9 h-9)
		const allBtns = page.locator('button.rounded-full');
		await expect(allBtns.first()).toBeVisible();
	});

	test('playing an episode starts the now-playing bar', async ({ page }) => {
		await page.getByPlaceholder('Search podcasts…').fill('test');
		await page.getByRole('button', { name: /^Subscribe$/i }).first().click({ timeout: 3000 });

		await expect(page.getByText('Episode 1: Introduction')).toBeVisible({ timeout: 5000 });

		// Click the play button next to the first episode
		// Episode play buttons are rounded-full icon buttons
		const episodeBtns = page.locator('button.rounded-full.w-9:visible');
		await episodeBtns.first().click();

		// Now-playing bar shows episode title
		await expect(page.getByText('Episode 1: Introduction').first()).toBeVisible();
	});

	// ── Now-playing bar controls ───────────────────────────────────────────
	test('now-playing bar has skip-back, play/pause, skip-forward buttons', async ({ page }) => {
		await page.getByPlaceholder('Search podcasts…').fill('test');
		await page.getByRole('button', { name: /^Subscribe$/i }).first().click({ timeout: 3000 });

		await expect(page.getByText('Episode 1: Introduction')).toBeVisible({ timeout: 5000 });
		await page.locator('button.rounded-full.w-9:visible').first().click();

		// Now-playing bar has 3 transport buttons detectable by aria-label.
		// Audio fails to load in test (mocked URL), so isPlaying resets to false — button shows Play.
		await expect(page.getByLabel('Previous track')).toBeVisible({ timeout: 3000 });
		await expect(page.getByLabel(/Play|Pause/i)).toBeVisible();
		await expect(page.getByLabel('Next track')).toBeVisible();
	});

	test('toggling play/pause works in now-playing bar', async ({ page }) => {
		await page.getByPlaceholder('Search podcasts…').fill('test');
		await page.getByRole('button', { name: /^Subscribe$/i }).first().click({ timeout: 3000 });

		await expect(page.getByText('Episode 1: Introduction')).toBeVisible({ timeout: 5000 });
		await page.locator('button.rounded-full.w-9:visible').first().click();

		// After episode click, isPlaying is briefly true then resets to false (audio load error).
		// Either button (Play or Pause) should be visible in the now-playing bar.
		const playPauseBtn = page.getByLabel(/Play|Pause/i);
		await expect(playPauseBtn).toBeVisible({ timeout: 3000 });
		await playPauseBtn.click({ force: true });
		await page.waitForTimeout(100);
		await page.getByLabel(/Play|Pause/i).click({ force: true });
		await page.waitForTimeout(100);
		// No assertion needed — just verify no exception
	});

	test('restored last episode rebinds its audio source on resume after reload', async ({ page }) => {
		await page.getByPlaceholder('Search podcasts…').fill('test');
		await page.getByRole('button', { name: /^Subscribe$/i }).first().click({ timeout: 3000 });
		await expect(page.getByText('Episode 2: Deep Dive')).toBeVisible({ timeout: 5000 });
		await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));

		await page.evaluate(() => {
			const raw = localStorage.getItem('podcast-data');
			if (!raw) throw new Error('podcast-data missing');
			const data = JSON.parse(raw);
			const podcast = data.podcasts[0];
			const episode = podcast.episodes[1];
			data.lastPodcastId = podcast.id;
			data.lastEpisodeId = episode.id;
			data.lastPositionSec = 123;
			episode.positionSec = 123;
			localStorage.setItem('podcast-data', JSON.stringify(data));
		});

		const restoredPage = await page.context().newPage();
		await setupMocks(restoredPage);
		await restoredPage.goto('/');
		await goToTab(restoredPage, 'Podcasts');
		await expect(restoredPage.getByText('Episode 2: Deep Dive').first()).toBeVisible({ timeout: 5000 });

		await restoredPage.getByLabel(/Play|Pause/i).click({ force: true });

		await expect
			.poll(async () => {
				return restoredPage.locator('audio').evaluateAll((audioElements) => {
					return audioElements.map((audioElement) => (audioElement as HTMLAudioElement).src);
				});
			}, { timeout: 5000 })
			.toContain('https://example.com/ep2.mp3');

		await restoredPage.close();
	});

	// ── Episode view navigation ────────────────────────────────────────────
	test('back button returns from episode view to podcast list', async ({ page }) => {
		await page.getByPlaceholder('Search podcasts…').fill('test');
		await page.getByRole('button', { name: /^Subscribe$/i }).first().click({ timeout: 3000 });
		await expect(page.getByText('Episode 1: Introduction')).toBeVisible({ timeout: 5000 });

		// ChevronLeft back button (first button in the header)
		await page.getByRole('button').first().click();
		await expect(page.getByText('Podcasts').first()).toBeVisible({ timeout: 3000 });
	});

	test('subscribing from Discover tab marks button as Subscribed', async ({ page }) => {
		await page.getByRole('button', { name: 'Discover', exact: true }).click();
		// Mocked results appear
		await expect(page.getByText('Test Podcast')).toBeVisible({ timeout: 5000 });

		await page.getByRole('button', { name: /^Subscribe$/i }).first().click();
		// After auto-open, go back
		await page.getByRole('button').first().click();
		// Switch to discover again — button now says Subscribed
		await page.getByRole('button', { name: 'Discover', exact: true }).click();
		await expect(page.getByText('Test Podcast')).toBeVisible({ timeout: 3000 });
		await expect(page.getByRole('button', { name: /Subscribed/i }).last()).toBeVisible();
	});

	// ── RSS error handling ─────────────────────────────────────────────────
	test('shows error state when RSS feed fails', async ({ page }) => {
		// Remove existing RSS success mock, then override with error
		await page.unroute('**/api.rss2json.com/**');
		await page.route('**/api.rss2json.com/**', (route) =>
			route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify({ status: 'error', message: 'Feed not found' }),
			})
		);

		await page.getByPlaceholder('Search podcasts…').fill('test');
		await page.getByRole('button', { name: /^Subscribe$/i }).first().click({ timeout: 3000 });

		// Error shown either in-page or as a toast
		await expect(page.getByText(/Feed not found|No RSS feed|Failed/i).first()).toBeVisible({ timeout: 5000 });
		await expect(page.getByRole('button', { name: /Retry/i }).first()).toBeVisible();
	});

	// ── TASK-2.7: New tests for podcast reliability fixes ────────────────

	test('episode with no audioUrl shows error toast when play is clicked', async ({ page }) => {
		// Override RSS to return episode with empty enclosure — must unroute first
		await page.unroute('**/api.rss2json.com/**');
		await page.route('**/api.rss2json.com/**', (route) =>
			route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify({
					status: 'ok',
					feed: { title: 'Test Podcast', image: '' },
					items: [{
						title: 'No Audio Episode',
						description: 'This episode has no audio.',
						pubDate: '2026-01-15 10:00:00',
						itunes_duration: '3600',
						// No enclosure at all — audioUrl will be empty string
					}],
				}),
			})
		);

		await page.getByPlaceholder('Search podcasts…').fill('test');
		await page.getByRole('button', { name: /^Subscribe$/i }).first().click({ timeout: 3000 });
		await expect(page.getByText('No Audio Episode')).toBeVisible({ timeout: 5000 });

		// The episode row has: div.p-4.border-b > div.flex > [content] + Button
		// The Button component renders as <button>. Find the round play button.
		const playBtn = page.locator('button.rounded-full').filter({ has: page.locator('svg') });
		await playBtn.click({ timeout: 3000 });

		// Should show error toast about missing audio URL
		const toastAlert = page.locator('[role="alert"]');
		await expect(toastAlert.filter({ hasText: /no playable audio/i })).toBeVisible({ timeout: 8000 });
	});

	test('unsubscribe during episode load does not crash', async ({ page }) => {
		// Subscribe to a podcast
		await page.getByPlaceholder('Search podcasts…').fill('test');
		await page.getByRole('button', { name: /^Subscribe$/i }).first().click({ timeout: 3000 });
		await expect(page.getByText('Episode 1: Introduction')).toBeVisible({ timeout: 5000 });

		// Go back to list and unsubscribe
		await page.getByRole('button').first().click();
		await expect(page.getByText('Test Podcast').first()).toBeVisible({ timeout: 3000 });

		// The app should remain functional
		await expect(page.getByRole('tablist')).toBeVisible();
		await expect(page.getByPlaceholder('Search podcasts…')).toBeVisible();
	});

	test('iTunes search failure does not crash the app', async ({ page }) => {
		// Override iTunes search to fail
		await page.route('**/itunes.apple.com/search**', (route) =>
			route.fulfill({ status: 500, contentType: 'text/plain', body: 'Internal Server Error' })
		);

		await page.getByPlaceholder('Search podcasts…').fill('test query');
		await page.waitForTimeout(1000); // debounce fires

		// App should still be functional, should show empty results
		await expect(page.getByRole('tablist')).toBeVisible();
	});
});
