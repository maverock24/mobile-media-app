/**
 * Smoke E2E — a small, fast set of end-to-end checks that the unit/component
 * suite cannot cover: app boots, hydrates, tabs navigate, and the primary MP3
 * load+play path works through the real UI.
 *
 * Deep feature behaviour lives in the Vitest unit/component suite under
 * tests/unit + src/**.*.test.ts. Keep this file small and resilient.
 */
import { test, expect } from '@playwright/test';
import { goToTab, expectActiveTab, waitForHydration } from './helpers';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

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

async function loadMp3Folder(page: import('@playwright/test').Page, dir: string) {
	const [fc] = await Promise.all([
		page.waitForEvent('filechooser'),
		page.evaluate(() => {
			const input = document.querySelector('input[type="file"][multiple]') as HTMLInputElement | null;
			if (input) { input.style.display = 'block'; input.click(); }
		}),
	]);
	await fc.setFiles(dir);
}

test.describe('Smoke', () => {
	test('app boots, hydrates, and defaults to the Music tab', async ({ page }) => {
		await page.goto('/');
		await waitForHydration(page);
		await expect(page.getByRole('tablist')).toBeVisible();
		await expect(page.getByRole('tab', { name: 'Music', exact: true })).toBeVisible();
		await expect(page.getByRole('tab', { name: 'Podcasts', exact: true })).toBeVisible();
		await expect(page.getByRole('tab', { name: 'Weather', exact: true })).toBeVisible();
		await expect(page.getByRole('tab', { name: 'Settings', exact: true })).toBeVisible();
		await expectActiveTab(page, 'Music');
	});

	test('tab navigation switches views', async ({ page }) => {
		await page.goto('/');
		await waitForHydration(page);

		await goToTab(page, 'Podcasts');
		await expectActiveTab(page, 'Podcasts');
		await expect(page.getByRole('button', { name: 'Discover', exact: true })).toBeVisible();

		await goToTab(page, 'Weather');
		await expectActiveTab(page, 'Weather');
		await expect(page.getByText('Weather').first()).toBeVisible();

		await goToTab(page, 'Settings');
		await expectActiveTab(page, 'Settings');
		await expect(page.getByRole('button', { name: /^Appearance/ })).toBeVisible();

		// Back to Music
		await goToTab(page, 'Music');
		await expectActiveTab(page, 'Music');
	});

	test('MP3 library loads and a track opens the player', async ({ page }) => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-smoke-'));
		createMinimalMp3('Track One.mp3', dir);
		createMinimalMp3('Track Two.mp3', dir);

		await page.goto('/');
		await waitForHydration(page);
		await loadMp3Folder(page, dir);

		// Both tracks appear
		await expect(page.getByText('Track One').first()).toBeVisible({ timeout: 5000 });
		await expect(page.getByText('Track Two').first()).toBeVisible();

		// Clicking a track opens the player and surfaces the MiniPlayer seek bar
		await page.getByText('Track One').first().click();
		await expect(page.locator('input[aria-label="Seek"]')).toBeVisible({ timeout: 5000 });

		fs.rmSync(dir, { recursive: true, force: true });
	});
});
