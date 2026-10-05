/**
 * Music deck playback after the ADR-0001 migration.
 *
 * The player module owns each deck's `<audio>` element, so it is not in the
 * document any more. These tests therefore assert on what is genuinely
 * observable: the transport the engine hands to the MiniPlayer, the deck's
 * playing indicator in the player view, and the number of audio elements in the
 * document (which must not grow by one per music deck).
 *
 * Exclusivity: `claimAudio()` stops every other source through the stop callback
 * that source registered. The radio is the only other source that can be driven
 * without live network, so the exclusivity test plays a featured station whose
 * stream is answered from the local fixture.
 */
import { test, expect, type Page } from '@playwright/test';
import { goToTab, waitForHydration } from './helpers';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { fileURLToPath } from 'url';

const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const SILENCE_MP3 = path.join(FIXTURES_DIR, 'silence.mp3');

/** A real 1 s silent LAME encode — short enough to auto-advance quickly. */
function createMinimalMp3(name: string, dir: string): string {
	const dest = path.join(dir, name);
	fs.copyFileSync(SILENCE_MP3, dest);
	return dest;
}

async function loadMp3Folder(page: Page, dir: string) {
	const [fc] = await Promise.all([
		page.waitForEvent('filechooser'),
		page.evaluate(() => {
			const input = document.querySelector('input[type="file"][multiple]') as HTMLInputElement | null;
			if (input) { input.style.display = 'block'; input.click(); }
		}),
	]);
	await fc.setFiles(dir);
}

function miniPlayer(page: Page) {
	return page.locator('[aria-label^="Mini player"]');
}

/** The music player view (the only deck that loaded a library in a test).
 *  CSS, not getByRole: the inactive deck is display-hidden, which drops it out of
 *  the accessibility tree, and the sub-tab bar carries the same aria-label. */
function playerView(page: Page) {
	return page.locator('[role="region"][aria-label="Music player"]').first();
}

/** The album-art pulse. Renders only while the deck's element is playing. */
function playingIndicator(page: Page) {
	return playerView(page).locator('.animate-pulse');
}

test.describe('Music deck playback (player module)', () => {
	test('plays a folder through the module-owned element and keeps the transport in the engine', async ({ page }) => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-module-'));
		createMinimalMp3('Track One.mp3', dir);
		createMinimalMp3('Track Two.mp3', dir);

		try {
			await page.goto('/');
			await waitForHydration(page);
			await loadMp3Folder(page, dir);
			await page.getByRole('button', { name: /Play Track One/ }).click();

			const mini = miniPlayer(page);
			await expect(mini).toBeVisible({ timeout: 10_000 });
			await expect(mini).toContainText('Track One');
			await expect(mini.getByRole('slider', { name: 'Seek' })).toBeVisible({ timeout: 10_000 });
			await expect(mini.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();

			// The two music decks render no element of their own: the only audio
			// elements in the document belong to PodcastView and YoutubePanel.
			// (Before the migration each deck rendered one, so this was 4.)
			await expect(page.locator('audio')).toHaveCount(2);

			// Playback reaches the engine, so the deck's own player view reports it.
			await page.getByRole('button', { name: /Return to music player/ }).click();
			await expect(playingIndicator(page)).toHaveCount(1);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test('auto-advances to the next queue entry when a track ends', async ({ page }) => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-module-'));
		createMinimalMp3('Track One.mp3', dir);
		createMinimalMp3('Track Two.mp3', dir);

		try {
			await page.goto('/');
			await waitForHydration(page);
			await loadMp3Folder(page, dir);
			await page.getByRole('button', { name: /Play Track One/ }).click();

			const mini = miniPlayer(page);
			await expect(mini).toContainText('Track One', { timeout: 10_000 });

			// The fixture is one second long: the element's `ended` event must move
			// the queue on and the new track must reach the engine.
			await expect(mini).toContainText('Track Two', { timeout: 30_000 });
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test('repeat-one keeps the deck playing, and pause/resume go through the module', async ({ page }) => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-module-'));
		createMinimalMp3('Track One.mp3', dir);

		try {
			// Repeat-one makes the 1 s fixture loop, so the deck stays playing while
			// the rest of this test runs.
			await page.addInitScript(() => {
				localStorage.setItem('music-settings', JSON.stringify({ isRepeat: true }));
			});
			await page.goto('/');
			await waitForHydration(page);
			await loadMp3Folder(page, dir);
			await page.getByRole('button', { name: /Play Track One/ }).click();

			const mini = miniPlayer(page);
			await expect(mini.getByRole('button', { name: 'Pause', exact: true })).toBeVisible({ timeout: 10_000 });
			await expect(mini).toContainText('Track One');
			await page.getByRole('button', { name: /Return to music player/ }).click();
			await expect(playingIndicator(page)).toHaveCount(1);

			// Deliberate pause: the deck stops and the engine sees it.
			await mini.getByRole('button', { name: 'Pause', exact: true }).click();
			await expect(mini.getByRole('button', { name: 'Play', exact: true })).toBeVisible();
			await page.waitForTimeout(1500);
			await expect(mini).toContainText('Track One');
			await expect(playingIndicator(page)).toHaveCount(0);

			// Resume: the module restarts the loaded queue.
			await mini.getByRole('button', { name: 'Play', exact: true }).click();
			await expect(mini.getByRole('button', { name: 'Pause', exact: true })).toBeVisible({ timeout: 10_000 });
			await expect(playingIndicator(page)).toHaveCount(1);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});


	test('deck B runs its own player instance', async ({ page }) => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-module-'));
		createMinimalMp3('Track One.mp3', dir);

		try {
			await page.goto('/');
			await waitForHydration(page);
			await page.getByRole('tab', { name: 'B', exact: true }).click();

			// Each deck keeps its own library and its own file input. Deck A renders
			// its two hidden inputs first, so deck B's folder input is the third.
			const [fc] = await Promise.all([
				page.waitForEvent('filechooser'),
				page.evaluate(() => {
					const inputs = Array.from(document.querySelectorAll('input[type="file"][multiple]')) as HTMLInputElement[];
					const input = inputs[2];
					if (input) { input.style.display = 'block'; input.click(); }
				}),
			]);
			await fc.setFiles(dir);
			await page.getByRole('button', { name: /Play Track One/ }).click();

			const mini = miniPlayer(page);
			await expect(mini).toContainText('Track One', { timeout: 10_000 });
			await expect(mini).toContainText('Deck B');
			await expect(mini.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();

			// Two decks, still no audio element of their own.
			await expect(page.locator('audio')).toHaveCount(2);

			// Deck B's own player view reports its own playback. Deck A loaded no
			// library in this test, so the only player view on the page is deck B's.
			await page.getByRole('button', { name: /Return to music player/ }).click();
			await expect(playerView(page).locator('.animate-pulse')).toHaveCount(1);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test('another source claiming audio stops the deck (deck exclusivity)', async ({ page }) => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-module-'));
		createMinimalMp3('Track One.mp3', dir);

		// The featured station streams from the BBC; answer it with the local
		// fixture so the claim happens without live network.
		await page.route('https://stream.live.vc.bbcmedia.co.uk/**', (route) =>
			route.fulfill({
				status: 200,
				contentType: 'audio/mpeg',
				body: fs.readFileSync(SILENCE_MP3),
			})
		);

		try {
			await page.addInitScript(() => {
				localStorage.setItem('music-settings', JSON.stringify({ isRepeat: true }));
			});
			await page.goto('/');
			await waitForHydration(page);
			await loadMp3Folder(page, dir);
			await page.getByRole('button', { name: /Play Track One/ }).click();

			const mini = miniPlayer(page);
			await expect(mini.getByRole('button', { name: 'Pause', exact: true })).toBeVisible({ timeout: 10_000 });

			// The player view is what the listener watches while the deck plays.
			await page.getByRole('button', { name: /Return to music player/ }).click();
			await expect(playingIndicator(page)).toHaveCount(1);

			// Start the radio: it claims audio, which must run this deck's
			// registered stop callback.
			await goToTab(page, 'Radio');
			await page.getByRole('button', { name: 'Search', exact: true }).first().click();
			await expect(page.getByText('Featured Stations')).toBeVisible();
			await page.locator('button').filter({ hasText: 'BBC Radio 4' }).first().click();

			// The engine now belongs to the radio ...
			await expect(miniPlayer(page)).toContainText('BBC Radio', { timeout: 10_000 });

			// ... and the music deck's element is paused, even though it owns no
			// DOM element that a test could inspect directly.
			await expect(playingIndicator(page)).toHaveCount(0);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
