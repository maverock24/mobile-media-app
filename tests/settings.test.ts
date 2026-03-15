/**
 * Settings view tests.
 */
import { test, expect } from '@playwright/test';
import { goToTab } from './helpers';

test.describe('Settings view', () => {
	test.beforeEach(async ({ page }) => {
		await page.goto('/');
		await goToTab(page, 'Settings');
	});

	// ── Structure ──────────────────────────────────────────────────────────
	test('shows Settings heading and subtitle', async ({ page }) => {
		await expect(page.getByText('Settings').first()).toBeVisible();
		await expect(page.getByText('Customize your experience')).toBeVisible();
	});

	test('shows all four section headers', async ({ page }) => {
		await expect(page.getByText('Appearance')).toBeVisible();
		await expect(page.getByText('Music Player')).toBeVisible();
		await expect(page.getByText('Podcast Player')).toBeVisible();
		await expect(page.getByText('Weather')).toBeVisible();
	});

	test('shows Reset Settings button', async ({ page }) => {
		await expect(page.getByRole('button', { name: /Reset.*Setting|Reset All/i })).toBeVisible();
	});

	// ── Appearance section ─────────────────────────────────────────────────
	test('clicking Appearance expands the panel', async ({ page }) => {
		await page.getByText('Appearance').click();
		await expect(page.getByText('Theme')).toBeVisible({ timeout: 2000 });
		await expect(page.getByText('Font Size')).toBeVisible();
	});

	test('theme buttons are selectable', async ({ page }) => {
		await page.getByText('Appearance').click();
		await expect(page.getByRole('button', { name: 'Light' })).toBeVisible();
		await expect(page.getByRole('button', { name: 'Dark' })).toBeVisible();
		await expect(page.getByRole('button', { name: 'System' })).toBeVisible();
	});

	test('clicking Light theme selects it', async ({ page }) => {
		await page.getByText('Appearance').click();
		await page.getByRole('button', { name: 'Light' }).click();
		// Light button should now have primary border style
		await expect(page.getByRole('button', { name: 'Light' })).toHaveClass(/border-primary|text-primary/);
	});

	test('font size buttons are selectable', async ({ page }) => {
		await page.getByText('Appearance').click();
		await expect(page.getByRole('button', { name: 'Small' })).toBeVisible();
		await expect(page.getByRole('button', { name: 'Medium' })).toBeVisible();
		await expect(page.getByRole('button', { name: 'Large' })).toBeVisible();
	});

	test('Reduced Motion toggle is switchable', async ({ page }) => {
		await page.getByText('Appearance').click();
		const toggle = page.getByRole('switch', { name: 'Reduced Motion' });
		await expect(toggle).toBeVisible();
		const before = await toggle.getAttribute('aria-checked');
		await toggle.click();
		const after = await toggle.getAttribute('aria-checked');
		expect(before).not.toBe(after);
	});

	test('Haptic Feedback toggle is switchable', async ({ page }) => {
		await page.getByText('Appearance').click();
		const toggle = page.getByRole('switch', { name: 'Haptic Feedback' });
		await expect(toggle).toBeVisible();
		const before = await toggle.getAttribute('aria-checked');
		await toggle.click();
		const after = await toggle.getAttribute('aria-checked');
		expect(before).not.toBe(after);
	});

	test('clicking Appearance again collapses the panel', async ({ page }) => {
		await page.getByText('Appearance').click();
		await expect(page.getByText('Theme')).toBeVisible();
		await page.getByText('Appearance').click();
		await expect(page.getByText('Theme')).not.toBeVisible({ timeout: 1000 });
	});

	// ── Music section ──────────────────────────────────────────────────────
	test('clicking Music Player expands the panel', async ({ page }) => {
		await page.getByText('Music Player').click();
		await expect(page.getByText('Volume')).toBeVisible({ timeout: 2000 });
	});

	test('music section shows Sort Order and EQ Preset', async ({ page }) => {
		await page.getByText('Music Player').click();
		await expect(page.getByText(/Sort Order|Equalizer|EQ Preset/i).first()).toBeVisible({ timeout: 2000 });
	});

	test('music section includes auto-play and shuffle toggles', async ({ page }) => {
		await page.getByText('Music Player').click();
		await expect(page.getByText(/Auto.?play|Shuffle/i).first()).toBeVisible({ timeout: 2000 });
	});

	test('only one section expands at a time', async ({ page }) => {
		await page.getByText('Appearance').click();
		await expect(page.getByText('Theme')).toBeVisible();

		await page.getByText('Music Player').click();
		await expect(page.getByText('Volume')).toBeVisible({ timeout: 2000 });
		// Appearance collapsed
		await expect(page.getByText('Theme')).not.toBeVisible({ timeout: 1000 });
	});

	// ── Podcast section ────────────────────────────────────────────────────
	test('clicking Podcast Player expands and shows speed controls', async ({ page }) => {
		await page.getByText('Podcast Player').click();
		await expect(page.getByText(/Skip Back|Playback Speed|Skip Forward/i).first()).toBeVisible({ timeout: 2000 });
	});

	// ── Weather section ────────────────────────────────────────────────────
	test('clicking Weather expands and shows unit options', async ({ page }) => {
		await page.getByText('Weather').first().click();
		await expect(page.getByText(/Temperature Unit|Wind Unit|Celsius|Fahrenheit/i).first()).toBeVisible({ timeout: 2000 });
	});

	// ── Reset ──────────────────────────────────────────────────────────────
	test('Reset Settings button triggers confirm dialog', async ({ page }) => {
		let dialogText = '';
		page.on('dialog', async (dialog) => {
			dialogText = dialog.message();
			await dialog.dismiss(); // cancel so no actual reset
		});
		await page.getByRole('button', { name: /Reset.*Setting|Reset All/i }).click();
		await page.waitForTimeout(300);
		expect(dialogText).toMatch(/Reset all settings/i);
	});

	test('cancelling reset keeps current settings', async ({ page }) => {
		// Change theme to Light first
		await page.getByText('Appearance').click();
		await page.getByRole('button', { name: 'Light' }).click();
		await expect(page.getByRole('button', { name: 'Light' })).toHaveClass(/border-primary|text-primary/);

		// Now try reset but cancel
		page.on('dialog', (d) => d.dismiss());
		await page.getByRole('button', { name: /Reset.*Setting|Reset All/i }).click();
		await page.waitForTimeout(300);

		// Light should still be selected
		await expect(page.getByRole('button', { name: 'Light' })).toHaveClass(/border-primary|text-primary/);
	});

	test('confirm reset restores default settings', async ({ page }) => {
		// Change theme to Light
		await page.getByText('Appearance').click();
		await page.getByRole('button', { name: 'Light' }).click();

		// Accept the reset dialog
		page.on('dialog', (d) => d.accept());
		await page.getByRole('button', { name: /Reset.*Setting|Reset All/i }).click();
		await page.waitForTimeout(300);

		// Theme should revert to System (default)
		// Collapse and re-expand to get fresh render
		await page.getByText('Appearance').click();
		await page.getByText('Appearance').click();
		await expect(page.getByRole('button', { name: 'System' })).toHaveClass(/border-primary|text-primary/);
	});
});
