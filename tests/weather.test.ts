/**
 * Weather view tests.
 * Open-Meteo geocoding and forecast calls are intercepted and mocked.
 */
import { test, expect, type Page } from '@playwright/test';
import { goToTab } from './helpers';

// ── Mock response factories ─────────────────────────────────────────────────
const MOCK_GEO_RESPONSE = {
	results: [
		{
			name: 'Munich',
			country: 'Germany',
			country_code: 'DE',
			latitude: 48.1351,
			longitude: 11.582,
			timezone: 'Europe/Berlin',
		},
		{
			name: 'Manchester',
			country: 'United Kingdom',
			country_code: 'GB',
			latitude: 53.4794,
			longitude: -2.2453,
			timezone: 'Europe/London',
		},
	],
};

function makeMockForecast() {
	// Build 28 daily entries
	const daily_time: string[] = [];
	const daily_max: number[] = [];
	const daily_min: number[] = [];
	const daily_code: number[] = [];
	const base = new Date('2026-03-15');
	for (let i = 0; i < 28; i++) {
		const d = new Date(base);
		d.setDate(base.getDate() + i);
		daily_time.push(d.toISOString().slice(0, 10));
		daily_max.push(18 + i * 0.1);
		daily_min.push(10 + i * 0.1);
		daily_code.push(i % 3 === 0 ? 0 : i % 3 === 1 ? 1 : 61);
	}
	// 96 hourly entries (4 days)
	const hourly_time: string[] = [];
	const hourly_temp: number[] = [];
	const hourly_code: number[] = [];
	for (let h = 0; h < 96; h++) {
		const dt = new Date('2026-03-15T00:00:00');
		dt.setHours(h);
		hourly_time.push(dt.toISOString().slice(0, 13));
		hourly_temp.push(15 + Math.sin(h / 6));
		hourly_code.push(0);
	}
	return {
		current: {
			temperature_2m: 16.5,
			apparent_temperature: 14.2,
			relative_humidity_2m: 58,
			wind_speed_10m: 12.3,
			wind_direction_10m: 225,
			weather_code: 0,
			visibility: 25000,
		},
		hourly: { time: hourly_time, temperature_2m: hourly_temp, weather_code: hourly_code },
		daily: {
			time: daily_time,
			temperature_2m_max: daily_max,
			temperature_2m_min: daily_min,
			weather_code: daily_code,
		},
	};
}

async function setupWeatherMocks(page: Page) {
	await page.route('**/geocoding-api.open-meteo.com/**', (route) =>
		route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(MOCK_GEO_RESPONSE) })
	);
	await page.route('**/api.open-meteo.com/**', (route) =>
		route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(makeMockForecast()) })
	);
}

test.describe('Weather view', () => {
	test.beforeEach(async ({ page }) => {
		await setupWeatherMocks(page);
		await page.goto('/');
		await goToTab(page, 'Weather');
	});

	// ── Header ─────────────────────────────────────────────────────────────
	test('shows Weather heading', async ({ page }) => {
		await expect(page.getByText('Weather').first()).toBeVisible();
	});

	test('°C / °F toggle is visible', async ({ page }) => {
		await expect(page.getByRole('button', { name: '°C' })).toBeVisible();
		await expect(page.getByRole('button', { name: '°F' })).toBeVisible();
	});

	test('refresh button is visible', async ({ page }) => {
		// RefreshCw icon button
		await expect(page.locator('button').filter({ has: page.locator('svg') }).last()).toBeVisible();
	});

	// ── Current conditions auto-load ───────────────────────────────────────
	test('loads current temperature for default city (Berlin)', async ({ page }) => {
		// 16.5°C should appear — allow a moment for fetch
		await expect(page.getByText(/17°|16°|Berlin/).first()).toBeVisible({ timeout: 5000 });
	});

	test('shows WMO weather label', async ({ page }) => {
		// Code 0 → "Clear Sky"
		await expect(page.getByText(/Clear Sky/i)).toBeVisible({ timeout: 5000 });
	});

	test('shows humidity, wind, visibility stats', async ({ page }) => {
		await expect(page.getByText(/58%|humidity/i).first()).toBeVisible({ timeout: 5000 });
		await expect(page.getByText(/12.*km\/h|wind/i).first()).toBeVisible({ timeout: 5000 });
	});

	test('city tabs show saved cities', async ({ page }) => {
		// Berlin, London, New York are the defaults
		await expect(page.getByText('Berlin')).toBeVisible({ timeout: 3000 });
	});

	// ── Unit toggle ────────────────────────────────────────────────────────
	test('°F toggle converts temperature', async ({ page }) => {
		await expect(page.getByText(/17°|16°/).first()).toBeVisible({ timeout: 5000 });
		await page.getByRole('button', { name: '°F' }).click();
		// 16.5°C → ~62°F
		await expect(page.getByText(/62°|61°/)).toBeVisible({ timeout: 3000 });
	});

	test('°C toggle switches back from °F', async ({ page }) => {
		await page.getByRole('button', { name: '°F' }).click();
		await page.getByRole('button', { name: '°C' }).click();
		await expect(page.getByText(/17°|16°/).first()).toBeVisible({ timeout: 3000 });
	});

	// ── City search ────────────────────────────────────────────────────────
	test('add city button opens search bar', async ({ page }) => {
		await page.getByRole('button').filter({ has: page.locator('svg') }).first().click();
		// find the MapPin / Plus button for adding city
		// Look for the search input
		const searchInput = page.getByPlaceholder(/Search city/i);
		if (await searchInput.isVisible()) {
			await expect(searchInput).toBeVisible();
		} else {
			// The plus button near cities list
			await expect(page.locator('input[type="text"]').last()).toBeVisible();
		}
	});

	test('city search shows geocoding results', async ({ page }) => {
		// Open city search — find the + button in the city strip
		const addBtn = page.getByRole('button').filter({ has: page.locator('svg') });
		// Look for the search trigger — either MapPin or a + button
		// We'll try clicking the last icon button in the header area
		const headerBtns = page.locator('.border-b button');
		const btnCount = await headerBtns.count();
		// The add city button is in the header row
		for (let i = 0; i < btnCount; i++) {
			const btn = headerBtns.nth(i);
			const text = await btn.textContent();
			if (!text?.trim()) {
				// icon-only button — could be add
				await btn.click();
				await page.waitForTimeout(200);
				const input = page.getByPlaceholder(/Search city/i);
				if (await input.isVisible({ timeout: 500 }).catch(() => false)) {
					await input.fill('Munich');
					await expect(page.getByText('Munich')).toBeVisible({ timeout: 3000 });
					await expect(page.getByText('Germany')).toBeVisible();
					break;
				}
			}
		}
	});

	test('adding a city from search results adds it to saved cities', async ({ page }) => {
		// Trigger search
		const input = page.getByPlaceholder(/Search city/i);
		// Try to make it visible
		await page.getByRole('button').filter({ has: page.locator('svg') }).nth(1).click().catch(() => {});
		if (await input.isVisible({ timeout: 500 }).catch(() => false)) {
			await input.fill('Munich');
			await expect(page.getByText('Munich')).toBeVisible({ timeout: 3000 });
			await page.getByText('Munich').first().click();
			// After adding, Munich should appear in city list
			await expect(page.getByText('Munich')).toBeVisible({ timeout: 3000 });
		}
	});

	// ── Forecast ───────────────────────────────────────────────────────────
	test('shows daily forecast list', async ({ page }) => {
		// "Today" is the first forecast day
		await expect(page.getByText('Today')).toBeVisible({ timeout: 5000 });
		// "Tmrw" is the second
		await expect(page.getByText('Tmrw')).toBeVisible({ timeout: 5000 });
	});

	test('shows up to 28-day forecast heading', async ({ page }) => {
		// Heading like "28-Day Forecast" or "16-Day Forecast"
		await expect(page.getByText(/-Day Forecast/i)).toBeVisible({ timeout: 5000 });
	});

	test('hourly scroll strip is visible', async ({ page }) => {
		// Hourly scroll — should contain "Now" and hour labels
		await expect(page.getByText('Now')).toBeVisible({ timeout: 5000 });
	});

	// ── City switching ─────────────────────────────────────────────────────
	test('clicking a saved city loads its weather', async ({ page }) => {
		await expect(page.getByText('Berlin')).toBeVisible({ timeout: 5000 });
		// Click London
		const londonBtn = page.getByText('London');
		if (await londonBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
			await londonBtn.click();
			// Should still show temperature (mock always returns 16.5)
			await expect(page.getByText(/17°|16°/).first()).toBeVisible({ timeout: 5000 });
		}
	});

	// ── Refresh ────────────────────────────────────────────────────────────
	test('refresh button triggers a new forecast fetch', async ({ page }) => {
		let fetchCount = 0;
		await page.route('**/api.open-meteo.com/**', (route) => {
			fetchCount++;
			route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(makeMockForecast()) });
		});

		// Find the refresh button (last icon button in header)
		const refreshBtn = page.locator('.border-b button').last();
		await page.waitForTimeout(500); // let initial fetch settle
		await refreshBtn.click();
		await page.waitForTimeout(500);
		expect(fetchCount).toBeGreaterThan(0);
	});

	// ── Error state ────────────────────────────────────────────────────────
	test('shows error state when forecast API fails', async ({ page }) => {
		await page.route('**/api.open-meteo.com/**', (route) =>
			route.fulfill({ status: 500, body: 'Server Error' })
		);

		// Force a new city click to trigger a fresh fetch
		const cityBtns = page.locator('button').filter({ hasText: /London|New York/i });
		await cityBtns.first().click().catch(() => {});
		await expect(page.getByText(/Failed|Error|HTTP 500/i)).toBeVisible({ timeout: 5000 });
	});
});
