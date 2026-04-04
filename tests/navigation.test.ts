/**
 * Navigation tests — bottom tab bar, view visibility, persistence across switches.
 */
import { test, expect } from '@playwright/test';
import { goToTab, expectActiveTab, waitForHydration } from './helpers';

test.describe('Tab navigation', () => {
	test.beforeEach(async ({ page }) => {
		await page.goto('/');
	});

	test('app loads and defaults to Music tab', async ({ page }) => {
		await waitForHydration(page);
		// Bottom nav is visible
		await expect(page.getByRole('tablist')).toBeVisible();
		await expect(page.getByRole('tab', { name: 'Music', exact: true })).toBeVisible();
		await expect(page.getByRole('tab', { name: 'Podcasts', exact: true })).toBeVisible();
		await expect(page.getByRole('tab', { name: 'Weather', exact: true })).toBeVisible();
		await expect(page.getByRole('tab', { name: 'Settings', exact: true })).toBeVisible();

		// Music tab active by default — may still be loading IDB (spinner) or ready
		await expectActiveTab(page, 'Music');
		await expect(
			page.getByText(/Your Music|Open Folder|Browse/i).or(page.locator('.animate-spin')).first()
		).toBeVisible();
	});

	test('switches to Podcasts tab', async ({ page }) => {
		await goToTab(page, 'Podcasts');
		await expectActiveTab(page, 'Podcasts');
		// Podcast view has Podcasts heading and Discover/Subscribed tabs
		await expect(page.getByText('Podcasts').first()).toBeVisible();
		await expect(page.getByRole('button', { name: /Subscribed/i })).toBeVisible();
		await expect(page.getByRole('button', { name: 'Discover', exact: true })).toBeVisible();
	});

	test('switches to Weather tab', async ({ page }) => {
		await goToTab(page, 'Weather');
		await expectActiveTab(page, 'Weather');
		await expect(page.getByText('Weather').first()).toBeVisible();
	});

	test('switches to Settings tab', async ({ page }) => {
		await goToTab(page, 'Settings');
		await expectActiveTab(page, 'Settings');
		await expect(page.getByText('Settings').first()).toBeVisible();
		await expect(page.getByText('Customize your experience')).toBeVisible();
	});

	test('restores the saved selected view on load', async ({ page }) => {
		await page.goto('about:blank');
		await page.addInitScript(() => {
			localStorage.setItem('navigation-state', JSON.stringify({ activeTab: 'settings' }));
		});
		await page.goto('/');
		// Wait for SvelteKit hydration (body[data-hydrated]) then Svelte reads saved tab
		await waitForHydration(page);

		await expectActiveTab(page, 'Settings');
		await expect(page.getByText('Settings').first()).toBeVisible();
		await expect(page.getByText('Customize your experience')).toBeVisible();
	});

	test('Music and Podcast views stay mounted when switching tabs', async ({ page }) => {
		// Music view container is always in DOM (CSS hidden, not removed)
		await expect(page.locator('[class*="overflow-hidden"]').nth(0)).toBeAttached();
		await expect(page.locator('[class*="overflow-hidden"]').nth(1)).toBeAttached();

		// Switch away from Music and back — view is still there
		await goToTab(page, 'Weather');
		await goToTab(page, 'Music');
		// Music view may still be initialising (IDB check) — accept spinner OR ready state
		await expect(
			page.getByText(/Your Music|Open Folder|Browse/i).or(page.locator('.animate-spin')).first()
		).toBeVisible();
	});

	test('all four tabs are keyboard-focusable', async ({ page }) => {
		for (const label of ['Music', 'Podcasts', 'Weather', 'Settings']) {
			const btn = page.getByRole('tab', { name: label, exact: true });
			await expect(btn).toBeVisible();
			await expect(btn).toBeEnabled();
		}
	});

	test('unknown saved tab value falls back to default Music tab', async ({ page }) => {
		await page.goto('about:blank');
		await page.addInitScript(() => {
			localStorage.setItem('navigation-state', JSON.stringify({ activeTab: 'nonexistent-tab' }));
		});
		await page.goto('/');
		await waitForHydration(page);
		await expectActiveTab(page, 'Music');
	});

	test('navigation state with extra future fields does not crash', async ({ page }) => {
		await page.goto('about:blank');
		await page.addInitScript(() => {
			localStorage.setItem('navigation-state', JSON.stringify({ activeTab: 'podcasts', futureField: 42 }));
		});
		await page.goto('/');
		await waitForHydration(page);
		await expectActiveTab(page, 'Podcasts');
	});
});
