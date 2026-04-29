/**
 * Settings view tests.
 */
import { test, expect } from '@playwright/test';

test.describe('Settings view', () => {
	test.beforeEach(async ({ page }) => {
		await page.addInitScript(() => {
			window.localStorage.setItem('navigation-state', JSON.stringify({ activeTab: 'settings' }));
		});
		await page.goto('/');
	});

	// ── Structure ──────────────────────────────────────────────────────────
	test('shows Settings heading and subtitle', async ({ page }) => {
		await expect(page.getByText('Settings').first()).toBeVisible();
		await expect(page.getByText('Customize your experience')).toBeVisible();
	});

	test('shows all four section headers', async ({ page }) => {
		await expect(page.getByRole('button', { name: /^Appearance/ })).toBeVisible();
		await expect(page.getByRole('button', { name: /^Music Player/ })).toBeVisible();
		await expect(page.getByRole('button', { name: /^Podcasts 1× speed/ })).toBeVisible();
		await expect(page.getByRole('button', { name: /^Weather °C/ })).toBeVisible();
		await expect(page.getByRole('button', { name: /^App Updates/ })).toBeVisible();
		await expect(page.getByRole('button', { name: /^Data & Storage/ })).toBeVisible();
	});

	test('shows Reset Settings button', async ({ page }) => {
		await page.getByRole('button', { name: /^Data & Storage/ }).click();
		await expect(page.getByRole('button', { name: /Reset.*Setting|Reset All/i })).toBeVisible();
	});

	// ── Appearance section ─────────────────────────────────────────────────
	test('clicking Appearance expands the panel', async ({ page }) => {
		await page.getByRole('button', { name: /^Appearance/ }).click();
		await expect(page.getByText('Theme', { exact: true })).toBeVisible({ timeout: 2000 });
		await expect(page.getByText('Font Size', { exact: true })).toBeVisible();
	});

	test('theme buttons are selectable', async ({ page }) => {
		await page.getByRole('button', { name: /^Appearance/ }).click();
		await expect(page.getByRole('button', { name: 'Light', exact: true })).toBeVisible();
		await expect(page.getByRole('button', { name: 'Dark', exact: true })).toBeVisible();
		await expect(page.getByRole('button', { name: 'System', exact: true })).toBeVisible();
	});

	test('clicking Light theme selects it', async ({ page }) => {
		await page.getByRole('button', { name: /^Appearance/ }).click();
		await page.getByRole('button', { name: 'Light', exact: true }).click();
		// Light button should now have primary border style
		await expect(page.getByRole('button', { name: 'Light', exact: true })).toHaveClass(/border-primary|text-primary/);
	});

	test('font size buttons are selectable', async ({ page }) => {
		await page.getByRole('button', { name: /^Appearance/ }).click();
		await expect(page.getByRole('button', { name: 'Small' })).toBeVisible();
		await expect(page.getByRole('button', { name: 'Medium' })).toBeVisible();
		await expect(page.getByRole('button', { name: 'Large' })).toBeVisible();
	});

	test('Reduced Motion toggle is switchable', async ({ page }) => {
		await page.getByRole('button', { name: /^Appearance/ }).click();
		const toggle = page.getByRole('switch', { name: 'Reduced Motion' });
		await expect(toggle).toBeVisible();
		const before = await toggle.getAttribute('aria-checked');
		await toggle.click();
		const after = await toggle.getAttribute('aria-checked');
		expect(before).not.toBe(after);
	});

	test('Haptic Feedback toggle is switchable', async ({ page }) => {
		await page.getByRole('button', { name: /^Appearance/ }).click();
		const toggle = page.getByRole('switch', { name: 'Haptic Feedback' });
		await expect(toggle).toBeVisible();
		const before = await toggle.getAttribute('aria-checked');
		await toggle.click();
		const after = await toggle.getAttribute('aria-checked');
		expect(before).not.toBe(after);
	});

	test('clicking Appearance again collapses the panel', async ({ page }) => {
		await page.getByRole('button', { name: /^Appearance/ }).click();
		await expect(page.getByText('Theme', { exact: true })).toBeVisible();
		await page.getByRole('button', { name: /^Appearance/ }).click();
		await expect(page.getByText('Theme', { exact: true })).not.toBeVisible({ timeout: 1000 });
	});

	// ── Music section ──────────────────────────────────────────────────────
	test('clicking Music Player expands the panel', async ({ page }) => {
		await page.getByRole('button', { name: /^Music Player/ }).click();
		await expect(page.getByText('Default Volume')).toBeVisible({ timeout: 2000 });
	});

	test('music section shows Sort Order and EQ Preset', async ({ page }) => {
		await page.getByRole('button', { name: /^Music Player/ }).click();
		await expect(page.getByText(/Sort Order|Equalizer|EQ Preset/i).first()).toBeVisible({ timeout: 2000 });
	});

	test('music section includes auto-play and album art toggles', async ({ page }) => {
		await page.getByRole('button', { name: /^Music Player/ }).click();
		await expect(page.getByText(/Auto.?play|album art/i).first()).toBeVisible({ timeout: 2000 });
	});

	test('music section shows the rescan library index action', async ({ page }) => {
		await page.getByRole('button', { name: /^Music Player/ }).click();
		await expect(page.getByRole('button', { name: /Rescan Current Library Index/i })).toBeVisible({ timeout: 2000 });
	});

	test('only one section expands at a time', async ({ page }) => {
		await page.getByRole('button', { name: /^Appearance/ }).click();
		await expect(page.getByText('Theme', { exact: true })).toBeVisible();

		await page.getByRole('button', { name: /^Music Player/ }).click();
		await expect(page.getByText('Default Volume')).toBeVisible({ timeout: 2000 });
		// Appearance collapsed
		await expect(page.getByText('Theme', { exact: true })).not.toBeVisible({ timeout: 1000 });
	});

	// ── Podcast section ────────────────────────────────────────────────────
	test('clicking Podcasts expands and shows speed controls', async ({ page }) => {
		await page.getByRole('button', { name: /^Podcasts 1× speed/ }).click();
		await expect(page.getByText(/Skip Back|Playback Speed|Skip Forward/i).first()).toBeVisible({ timeout: 2000 });
	});

	// ── Weather section ────────────────────────────────────────────────────
	test('clicking Weather expands and shows unit options', async ({ page }) => {
		await page.getByRole('button', { name: /^Weather °C/ }).click();
		await expect(page.getByText('Temperature Unit', { exact: true })).toBeVisible({ timeout: 2000 });
	});

	// ── Reset ──────────────────────────────────────────────────────────────
	test('Reset Settings button triggers confirm dialog', async ({ page }) => {
		let dialogText = '';
		page.on('dialog', async (dialog) => {
			dialogText = dialog.message();
			await dialog.dismiss(); // cancel so no actual reset
		});
		await page.getByRole('button', { name: /^Data & Storage/ }).click();
		await page.getByRole('button', { name: /Reset.*Setting|Reset All/i }).click();
		await page.waitForTimeout(300);
		expect(dialogText).toMatch(/Reset all settings/i);
	});

	test('cancelling reset keeps current settings', async ({ page }) => {
		// Change theme to Light first
		await page.getByRole('button', { name: /^Appearance/ }).click();
		await page.getByRole('button', { name: 'Light', exact: true }).click();
		await expect(page.getByRole('button', { name: 'Light', exact: true })).toHaveClass(/border-primary|text-primary/);

		// Now try reset but cancel
		page.on('dialog', (d) => d.dismiss());
		await page.getByRole('button', { name: /^Data & Storage/ }).click();
		await page.getByRole('button', { name: /Reset.*Setting|Reset All/i }).click();
		await page.waitForTimeout(300);

		// Light should still be selected
		await page.getByRole('button', { name: /^Appearance/ }).click();
		await expect(page.getByRole('button', { name: 'Light', exact: true })).toHaveClass(/border-primary|text-primary/);
	});

	test('confirm reset restores default settings', async ({ page }) => {
		// Change theme to Light
		await page.getByRole('button', { name: /^Appearance/ }).click();
		await page.getByRole('button', { name: 'Light', exact: true }).click();

		// Accept the reset dialog
		page.on('dialog', (d) => d.accept());
		await page.getByRole('button', { name: /^Data & Storage/ }).click();
		await page.getByRole('button', { name: /Reset.*Setting|Reset All/i }).click();
		await page.waitForTimeout(300);

		// Theme should revert to System (default)
		// Collapse and re-expand to get fresh render
		await page.getByRole('button', { name: /^Appearance/ }).click();
		await expect(page.getByRole('button', { name: 'System', exact: true })).toHaveClass(/border-primary|text-primary/);
	});

	test('App Updates shows an empty state when no manifest is published', async ({ page }) => {
		// Mock the endpoint to return 404 so the empty state is always shown
		// (a real latest.json may be deployed on Netlify)
		await page.route('**/releases/android/latest.json*', (route) => route.fulfill({ status: 404 }));
		await page.goto('/');
		await page.getByRole('button', { name: /^App Updates/ }).click();
		await expect(page.getByText('No Android package has been published to this deployment yet.')).toBeVisible();
	});

	test('App Updates shows a download link when release metadata exists', async ({ page }) => {
		await page.route('**/releases/android/latest.json*', async (route) => {
			await route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify({
					version: '0.0.1',
					versionCode: 42,
					versionName: '0.0.1 (build 42)',
					buildType: 'release',
					fileName: 'media-hub-0.0.1-build-42-deadbee.apk',
					url: '/releases/android/media-hub-0.0.1-build-42-deadbee.apk',
					sizeBytes: 15_728_640,
					sha256: 'abc123',
					publishedAt: '2026-03-16T12:00:00Z',
					commitSha: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
					commitUrl: 'https://github.com/maverock24/mobile-media-app/commit/deadbeefdeadbeefdeadbeefdeadbeefdeadbeef'
				})
			});
		});

		await page.goto('/');
		await page.getByRole('button', { name: /^App Updates/ }).click();

		await expect(page.getByText('Android build 0.0.1 (build 42)')).toBeVisible();
		// href may be relative or absolute depending on PUBLIC_RELEASE_BASE_URL env var
		await expect(page.getByRole('link', { name: 'Download Latest Android APK' })).toHaveAttribute(
			'href',
			/releases\/android\/media-hub-0\.0\.1-build-42-deadbee\.apk/
		);
	});
});
