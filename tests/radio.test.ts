/**
 * Radio view tests.
 * The /api/radio/search route is intercepted and mocked so tests run offline
 * and deterministically.
 */
import { test, expect, type Page } from '@playwright/test';
import { goToTab, waitForHydration } from './helpers';

// ── Mock data ───────────────────────────────────────────────────────────────
const MOCK_STATIONS = [
	{
		stationuuid:  'uuid-1',
		name:         'Test Jazz FM',
		url_resolved: 'https://stream.testjazz.example/live',
		favicon:      '',
		country:      'US',
		tags:         'jazz,smooth',
		codec:        'MP3',
		bitrate:      128,
		votes:        1000,
	},
	{
		stationuuid:  'uuid-2',
		name:         'Test Classical Radio',
		url_resolved: 'https://stream.testclassical.example/live',
		favicon:      '',
		country:      'DE',
		tags:         'classical',
		codec:        'AAC',
		bitrate:      192,
		votes:        800,
	},
];

// Station returned with an HTTP (not HTTPS) url — should be filtered out
const MOCK_HTTP_STATION = {
	stationuuid:  'uuid-http',
	name:         'Insecure Station',
	url_resolved: 'http://stream.insecure.example/live',
	favicon:      '',
	country:      'US',
	tags:         '',
	codec:        'MP3',
	bitrate:      64,
	votes:        10,
};

async function setupMocks(page: Page) {
	await page.route('**/api/radio/search**', (route) =>
		route.fulfill({
			status:      200,
			contentType: 'application/json',
			body:        JSON.stringify(MOCK_STATIONS),
		})
	);
	// Block real stream requests
	await page.route('**/stream.testjazz.example/**', (route) => route.abort());
	await page.route('**/stream.testclassical.example/**', (route) => route.abort());
	// Stub Google Identity Services
	await page.route('**/accounts.google.com/gsi/client**', (route) =>
		route.fulfill({ status: 200, contentType: 'application/javascript', body: '// gsi stub' })
	);
	await page.route('**/accounts.google.com/**', (route) => route.abort());
	await page.route('**/oauth2.googleapis.com/**', (route) => route.abort());
}

// Navigate to Radio tab with mocks active
async function goToRadio(page: Page) {
	await setupMocks(page);
	await page.goto('/');
	await goToTab(page, 'Radio');
}

async function openRadioSearch(page: Page) {
	await page.getByRole('button', { name: /Search/i }).first().click();
	const form = page.locator('form').filter({ has: page.getByPlaceholder(/Search radio stations/i) }).first();
	await expect(form.getByPlaceholder(/Search radio stations/i)).toBeVisible();
	return form;
}

async function openRadioFavorites(page: Page) {
	const favoritesTab = page.getByRole('button', { name: /^Favorites/ }).first();
	await favoritesTab.click();
	return favoritesTab;
}

// ── Tests ───────────────────────────────────────────────────────────────────
test.describe('Radio view', () => {
	// ── Structure ────────────────────────────────────────────────────────────
	test('shows Favorites and Search tabs', async ({ page }) => {
		await goToRadio(page);
		await expect(page.getByRole('button', { name: /Favorites/i })).toBeVisible();
		await expect(page.getByRole('button', { name: /Search/i })).toBeVisible();
	});

	test('defaults to Favorites tab with empty state message', async ({ page }) => {
		await goToRadio(page);
		await expect(page.getByText(/No favorite stations yet/i)).toBeVisible();
		await expect(page.getByText(/Search for stations and tap the star/i)).toBeVisible();
	});

	test('Search tab shows search input and button', async ({ page }) => {
		await goToRadio(page);
		const form = await openRadioSearch(page);
		await expect(form.getByRole('button', { name: 'Search', exact: true })).toBeVisible();
	});

	test('Search button is disabled when query is empty', async ({ page }) => {
		await goToRadio(page);
		const form = await openRadioSearch(page);
		await expect(form.getByRole('button', { name: 'Search', exact: true })).toBeDisabled();
	});

	// ── Searching ────────────────────────────────────────────────────────────
	test('searching for a station shows results', async ({ page }) => {
		await goToRadio(page);
		const form = await openRadioSearch(page);
		await form.getByPlaceholder(/Search radio stations/i).fill('jazz');
		await form.getByRole('button', { name: 'Search', exact: true }).click();

		await expect(page.getByText('Test Jazz FM')).toBeVisible();
		await expect(page.getByText('Test Classical Radio')).toBeVisible();
	});

	test('station metadata is displayed in results', async ({ page }) => {
		await goToRadio(page);
		const form = await openRadioSearch(page);
		await form.getByPlaceholder(/Search radio stations/i).fill('jazz');
		await form.getByRole('button', { name: 'Search', exact: true }).click();

		// Meta line for Jazz FM: "US · MP3 · 128kbps"
		await expect(page.getByText(/US.*MP3.*128kbps/i)).toBeVisible();
	});

	test('HTTP-only results are filtered out', async ({ page }) => {
		// Override the mock to return only the HTTP station
		await page.route('**/api/radio/search**', (route) =>
			route.fulfill({
				status:      200,
				contentType: 'application/json',
				body:        JSON.stringify([MOCK_HTTP_STATION]),
			})
		);
		await page.goto('/');
		await goToTab(page, 'Radio');
		const form = await openRadioSearch(page);
		await form.getByPlaceholder(/Search radio stations/i).fill('insecure');
		await form.getByRole('button', { name: 'Search', exact: true }).click();

		await expect(page.getByText(/No secure.*HTTPS.*stream/i)).toBeVisible();
		await expect(page.getByText('Insecure Station')).not.toBeVisible();
	});

	test('search API error shows error message', async ({ page }) => {
		await page.route('**/api/radio/search**', (route) =>
			route.fulfill({ status: 502, contentType: 'application/json', body: JSON.stringify({ error: 'Upstream error' }) })
		);
		await page.goto('/');
		await goToTab(page, 'Radio');
		const form = await openRadioSearch(page);
		await form.getByPlaceholder(/Search radio stations/i).fill('jazz');
		await form.getByRole('button', { name: 'Search', exact: true }).click();

		await expect(page.getByText(/Upstream error|unavailable|Try again/i)).toBeVisible();
	});

	// ── Favorites ────────────────────────────────────────────────────────────
	test('searching a station adds it to favorites', async ({ page }) => {
		await goToRadio(page);
		const form = await openRadioSearch(page);
		await form.getByPlaceholder(/Search radio stations/i).fill('jazz');
		await form.getByRole('button', { name: 'Search', exact: true }).click();
		await expect(page.getByText('Test Jazz FM')).toBeVisible();

		// Click the star next to the first result
		await page.getByRole('button', { name: 'Add to favorites' }).first().click();

		// Switch to Favorites tab and verify the station appears
		await openRadioFavorites(page);
		await expect(page.getByText('Test Jazz FM')).toBeVisible();
	});

	test('favorites count badge updates when a station is starred', async ({ page }) => {
		await goToRadio(page);
		const form = await openRadioSearch(page);
		await form.getByPlaceholder(/Search radio stations/i).fill('jazz');
		await form.getByRole('button', { name: 'Search', exact: true }).click();
		await expect(page.getByText('Test Jazz FM')).toBeVisible();

		await page.getByRole('button', { name: 'Add to favorites' }).first().click();

		// Favorites tab should now show a badge with count 1
		await expect(page.getByRole('button', { name: /^Favorites/ }).first()).toContainText('1');
	});

	test('starring multiple stations adds all to favorites', async ({ page }) => {
		await goToRadio(page);
		const form = await openRadioSearch(page);
		await form.getByPlaceholder(/Search radio stations/i).fill('jazz');
		await form.getByRole('button', { name: 'Search', exact: true }).click();
		await expect(page.getByText('Test Jazz FM')).toBeVisible();

		// Star both results
		const starButtons = page.getByRole('button', { name: 'Add to favorites' });
		await starButtons.nth(0).click();
		await starButtons.nth(0).click(); // second result (first is now "Remove")

		const favoritesTab = await openRadioFavorites(page);
		await expect(page.getByText('Test Jazz FM')).toBeVisible();
		await expect(page.getByText('Test Classical Radio')).toBeVisible();
		await expect(favoritesTab).toContainText('2');
	});

	test('removing a station from favorites via Favorites tab works', async ({ page }) => {
		// Pre-seed favorites in localStorage
		await page.addInitScript(() => {
			window.localStorage.setItem(
				'radio-data',
				JSON.stringify({
					favorites: [
						{
							stationuuid:  'uuid-1',
							name:         'Test Jazz FM',
							url_resolved: 'https://stream.testjazz.example/live',
							favicon:      '',
							country:      'US',
							tags:         'jazz',
							codec:        'MP3',
							bitrate:      128,
							votes:        1000,
						},
					],
				})
			);
		});
		await goToRadio(page);

		await expect(page.getByText('Test Jazz FM')).toBeVisible();
		await page.getByRole('button', { name: 'Remove from favorites' }).click();
		await expect(page.getByText('Test Jazz FM')).not.toBeVisible();
		await expect(page.getByText(/No favorite stations yet/i)).toBeVisible();
	});

	test('favorites persist across page reload', async ({ page }) => {
		await goToRadio(page);
		const form = await openRadioSearch(page);
		await form.getByPlaceholder(/Search radio stations/i).fill('jazz');
		await form.getByRole('button', { name: 'Search', exact: true }).click();
		await expect(page.getByText('Test Jazz FM')).toBeVisible();
		await page.getByRole('button', { name: 'Add to favorites' }).first().click();

		// Reload and re-navigate
		await page.reload();
		await waitForHydration(page);
		await goToTab(page, 'Radio');

		await expect(page.getByText('Test Jazz FM')).toBeVisible();
	});

	test('star icon is filled/highlighted for favorited stations in search results', async ({ page }) => {
		await goToRadio(page);
		const form = await openRadioSearch(page);
		await form.getByPlaceholder(/Search radio stations/i).fill('jazz');
		await form.getByRole('button', { name: 'Search', exact: true }).click();
		await expect(page.getByText('Test Jazz FM')).toBeVisible();

		await page.getByRole('button', { name: 'Add to favorites' }).first().click();

		// The star button for Test Jazz FM should now be "Remove from favorites"
		await expect(page.getByRole('button', { name: 'Remove from favorites' }).first()).toBeVisible();
	});
});
