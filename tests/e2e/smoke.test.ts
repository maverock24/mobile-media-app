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
import { fileURLToPath } from 'url';

/** This file is ESM, so there is no __dirname. */
const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

/**
 * Copy a playable MP3 into `dir`.
 *
 * The previous fixture was 18 hand-written bytes, which is far short of a single
 * MPEG-1 Layer III frame (417 bytes at 128 kbps / 44.1 kHz), so the browser
 * could never decode it and playback never started. `fixtures/silence.mp3` is a
 * real 1 s silent LAME encode.
 */
function createMinimalMp3(name: string, dir: string): string {
	const dest = path.join(dir, name);
	fs.copyFileSync(path.join(FIXTURES_DIR, 'silence.mp3'), dest);
	return dest;
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

	test('YouTube is reachable from the file browser, and Return reaches the player', async ({ page }) => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-nav-'));
		createMinimalMp3('Track One.mp3', dir);

		await page.goto('/');
		await waitForHydration(page);
		await loadMp3Folder(page, dir);
		await expect(page.getByText('Track One').first()).toBeVisible({ timeout: 5000 });
		await page.getByRole('button', { name: /Play Track One/ }).click();
		await expect(page.getByRole('button', { name: /Return to music player/ })).toBeVisible({ timeout: 10_000 });

		// Loading a folder leaves you in the file browser, which renders no player
		// toolbar at all. YouTube has to be reachable from here.
		await expect(page.getByRole('button', { name: 'YouTube', exact: true })).toBeVisible();
		await page.getByRole('button', { name: 'YouTube', exact: true }).click();
		await expect(page.getByRole('button', { name: 'Close YouTube' })).toBeVisible();
		await page.getByRole('button', { name: 'Close YouTube' }).click();
		await expect(page.getByRole('button', { name: 'Close YouTube' })).toHaveCount(0);

		// "Return to music player" previously only switched tabs, which is a no-op
		// while the Music tab is already active — leaving the file browser with no
		// way back to the now-playing screen. The player toolbar is the proof.
		await page.getByRole('button', { name: /Return to music player/ }).click();
		await expect(page.getByRole('button', { name: 'Browse' })).toBeVisible();

		fs.rmSync(dir, { recursive: true, force: true });
	});

	test('MP3 library loads and a track plays', async ({ page }) => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-smoke-'));
		createMinimalMp3('Track One.mp3', dir);
		createMinimalMp3('Track Two.mp3', dir);

		await page.goto('/');
		await waitForHydration(page);
		await loadMp3Folder(page, dir);

		// Both tracks appear
		await expect(page.getByText('Track One').first()).toBeVisible({ timeout: 5000 });
		await expect(page.getByText('Track Two').first()).toBeVisible();

		// Tapping a track starts playback but deliberately keeps the browser open so
		// the listener can keep browsing. It is the MiniPlayer, not the full player
		// view, that surfaces the transport controls.
		await page.getByRole('button', { name: /Play Track One/ }).click();

		const mini = page.locator('[aria-label^="Mini player"]');
		await expect(mini).toBeVisible({ timeout: 10_000 });
		await expect(mini).toContainText('Track One');

		// Playback reaching the engine is what makes the source seekable, which is
		// what renders the seek control. The MiniPlayer's control is a role=slider
		// div — `input[aria-label="Seek"]` only exists in PlayerControls, which is
		// part of the full player view.
		await expect(mini.getByRole('slider', { name: 'Seek' })).toBeVisible({ timeout: 10_000 });
		await expect(mini.getByRole('button', { name: 'Pause' })).toBeVisible();

		fs.rmSync(dir, { recursive: true, force: true });
	});
});
