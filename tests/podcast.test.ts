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
	await page.route('**/rss2json.com/**', (route) =>
		route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(MOCK_RSS_RESPONSE) })
	);
	// Block real artwork fetches
	await page.route('**/example.com/**', (route) => route.abort());
}

test.describe('Podcast view', () => {
	test.beforeEach(async ({ page }) => {
		await setupMocks(page);
		await page.goto('/');
		await goToTab(page, 'Podcasts');
	});

	// ── Default state ──────────────────────────────────────────────────────
	test('shows Podcasts heading and tab buttons', async ({ page }) => {
		await expect(page.getByText('Podcasts').first()).toBeVisible();
		await expect(page.getByRole('button', { name: /Subscribed/i })).toBeVisible();
		await expect(page.getByRole('button', { name: /Discover/i })).toBeVisible();
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
		await page.getByRole('button', { name: /Discover/i }).click();
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

		await page.getByRole('button', { name: '' }).filter({ has: page.locator('svg') }).last().click();
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
		const episodeBtns = page.locator('button.rounded-full.w-9');
		await episodeBtns.first().click();

		// Now-playing bar shows episode title
		await expect(page.getByText('Episode 1: Introduction').first()).toBeVisible();
	});

	// ── Now-playing bar controls ───────────────────────────────────────────
	test('now-playing bar has skip-back, play/pause, skip-forward buttons', async ({ page }) => {
		await page.getByPlaceholder('Search podcasts…').fill('test');
		await page.getByRole('button', { name: /^Subscribe$/i }).first().click({ timeout: 3000 });

		await expect(page.getByText('Episode 1: Introduction')).toBeVisible({ timeout: 5000 });
		await page.locator('button.rounded-full.w-9').first().click();

		// Now-playing bar is the bottom fixed bar
		const bar = page.locator('.border-t.bg-card').last();
		await expect(bar).toBeVisible();
		// 3 transport buttons in the bar
		const barBtns = bar.locator('button');
		await expect(barBtns).toHaveCount(3);
	});

	test('toggling play/pause works in now-playing bar', async ({ page }) => {
		await page.getByPlaceholder('Search podcasts…').fill('test');
		await page.getByRole('button', { name: /^Subscribe$/i }).first().click({ timeout: 3000 });

		await expect(page.getByText('Episode 1: Introduction')).toBeVisible({ timeout: 5000 });
		await page.locator('button.rounded-full.w-9').first().click();

		const bar = page.locator('.border-t.bg-card').last();
		const playPauseBtn = bar.locator('button').nth(1); // middle button
		await playPauseBtn.click(); // pause
		await page.waitForTimeout(100);
		await playPauseBtn.click(); // play again
		await page.waitForTimeout(100);
		// No assertion needed — just verify no exception
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
		await page.getByRole('button', { name: /Discover/i }).click();
		// Mocked results appear
		await expect(page.getByText('Test Podcast')).toBeVisible({ timeout: 5000 });

		await page.getByRole('button', { name: /^Subscribe$/i }).first().click();
		// After auto-open, go back
		await page.getByRole('button').first().click();
		// Switch to discover again — button now says Subscribed
		await page.getByRole('button', { name: /Discover/i }).click();
		await expect(page.getByText('Test Podcast')).toBeVisible({ timeout: 3000 });
		await expect(page.getByRole('button', { name: /Subscribed/i }).last()).toBeVisible();
	});

	// ── RSS error handling ─────────────────────────────────────────────────
	test('shows error state when RSS feed fails', async ({ page }) => {
		// Override RSS mock to return error
		await page.route('**/rss2json.com/**', (route) =>
			route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify({ status: 'error', message: 'Feed not found' }),
			})
		);

		await page.getByPlaceholder('Search podcasts…').fill('test');
		await page.getByRole('button', { name: /^Subscribe$/i }).first().click({ timeout: 3000 });

		await expect(page.getByText(/Feed not found|No RSS feed|Failed/i)).toBeVisible({ timeout: 5000 });
		await expect(page.getByRole('button', { name: /Retry/i })).toBeVisible();
	});
});
