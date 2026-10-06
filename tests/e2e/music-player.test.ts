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

/** The player screen of whichever deck is currently shown. The other deck's copy
 *  is `display:none`, so this resolves to exactly one region while a deck plays. */
function visiblePlayerView(page: Page) {
	return page.locator('[role="region"][aria-label="Music player"]:visible');
}

/** The album-art pulse of whichever deck is currently shown. */
function visiblePlayingIndicator(page: Page) {
	return visiblePlayerView(page).locator('.animate-pulse');
}

/** The track title rendered by the currently shown deck's player screen. */
function visibleDeckTitle(page: Page) {
	return visiblePlayerView(page).locator('h2');
}

interface DeckAudioProbe {
	__deckAudios?: HTMLAudioElement[];
	__deckAudioNames?: Map<string, string>;
}

/**
 * The decks' audio elements do not exist in the document: the player module
 * creates each one with `new Audio()`, so they are detached and absent from
 * `document.querySelectorAll('audio')`. Two init-script patches make them
 * observable instead:
 *  - the `Audio` constructor is wrapped to collect every element it builds, and
 *  - `URL.createObjectURL` is wrapped to remember which file name each blob URL
 *    was built from (a local folder File is resolved with
 *    `URL.createObjectURL(file)`).
 * Reading a playing element's `src` back through that map names the file the deck
 * has actually loaded, independent of any UI state.
 */
async function installDeckAudioProbe(page: Page) {
	await page.addInitScript(() => {
		const w = window as unknown as DeckAudioProbe;
		w.__deckAudios = [];
		w.__deckAudioNames = new Map<string, string>();
		class ProbeAudio extends Audio {
			constructor(...args: ConstructorParameters<typeof Audio>) {
				super(...args);
				w.__deckAudios!.push(this);
			}
		}
		window.Audio = ProbeAudio as unknown as typeof Audio;
		const nativeCreateObjectURL = URL.createObjectURL.bind(URL);
		URL.createObjectURL = (obj: Blob | MediaSource) => {
			const url = nativeCreateObjectURL(obj);
			if (obj instanceof Blob && 'name' in obj) {
				w.__deckAudioNames!.set(url, String((obj as File).name));
			}
			return url;
		};
	});
}

/** File names loaded into the deck elements that are currently playing. */
async function playingDeckFiles(page: Page): Promise<string[]> {
	return page.evaluate(() => {
		const w = window as unknown as DeckAudioProbe;
		return (w.__deckAudios ?? [])
			.filter((el) => el.src !== '' && !el.paused)
			.map((el) => w.__deckAudioNames?.get(el.src) ?? el.src);
	});
}

/** The deck-owned audio element that loaded `file`, or null if no element has it.
 *  Identified by the file name its blob URL was built from, not by element order. */
async function deckElementState(page: Page, file: string): Promise<{ paused: boolean; loaded: boolean } | null> {
	return page.evaluate((wanted) => {
		const w = window as unknown as DeckAudioProbe;
		const el = (w.__deckAudios ?? []).find((e) => w.__deckAudioNames?.get(e.src) === wanted);
		return el ? { paused: el.paused, loaded: el.src !== '' } : null;
	}, file);
}

/** Assert the currently shown deck renders `title`, is not mistaken for empty,
 *  and really has `file` playing on its detached audio element. */
async function expectDeckShows(page: Page, title: string, file: string) {
	await expect(visibleDeckTitle(page)).toHaveText(title);
	const mini = miniPlayer(page);
	await expect(mini).toContainText(title);
	await expect(mini).not.toContainText('No track loaded');
	await expect(visiblePlayerView(page)).not.toContainText('No track loaded');
	await expect.poll(() => playingDeckFiles(page), { timeout: 10_000 }).toContain(file);
}

/** Deck B owns the third and fourth hidden file inputs on the page (Deck A
 *  renders the first two), so its folder picker is the third. */
async function loadDeckBFolder(page: Page, dir: string) {
	const [fc] = await Promise.all([
		page.waitForEvent('filechooser'),
		page.evaluate(() => {
			const inputs = Array.from(document.querySelectorAll('input[type="file"][multiple]')) as HTMLInputElement[];
			const input = inputs[2];
			if (input) { input.style.display = 'block'; input.click(); }
		}),
	]);
	await fc.setFiles(dir);
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

	test('each deck shows its own current track while both decks play', async ({ page }) => {
		// Different queue lengths is the point: the shared index ends up out of
		// range for the two-track deck and in range but wrong for the four-track one.
		const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-deck-a-'));
		const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-deck-b-'));
		// Numeric names so the queue's alphabetical sort matches the indices below.
		createMinimalMp3('Alpha 1.mp3', dirA);
		createMinimalMp3('Alpha 2.mp3', dirA);
		createMinimalMp3('Beta 1.mp3', dirB);
		createMinimalMp3('Beta 2.mp3', dirB);
		createMinimalMp3('Beta 3.mp3', dirB);
		createMinimalMp3('Beta 4.mp3', dirB);

		try {
			// Repeat-one pins each 1 s fixture to its own track, so the indices this
			// test reasons about do not drift while both decks play.
			await page.addInitScript(() => {
				localStorage.setItem('music-settings', JSON.stringify({ isRepeat: true }));
			});
			await installDeckAudioProbe(page);

			await page.goto('/');
			await waitForHydration(page);

			// Deck A: two tracks, starting on the first.
			await loadMp3Folder(page, dirA);
			await page.getByRole('button', { name: /Play Alpha 1/ }).click();
			await expect(miniPlayer(page)).toContainText('Alpha 1', { timeout: 10_000 });

			// Deck B: four tracks, starting on the third — an index Deck A cannot hold.
			await page.getByRole('tab', { name: 'B', exact: true }).click();
			await loadDeckBFolder(page, dirB);
			await page.getByRole('button', { name: /Play Beta 3/ }).click();
			await expect(miniPlayer(page)).toContainText('Beta 3', { timeout: 10_000 });

			// Bring up both decks' player screens, then look at each in turn.
			await page.getByRole('button', { name: /Return to music player/ }).click();

			// Deck B displayed (the deck that acted last): it owns the shared index.
			await expectDeckShows(page, 'Beta 3', 'Beta 3.mp3');

			// Deck A displayed: the shared index belongs to Deck B and is past the end
			// of Deck A's two-track queue, so the old code showed "No track loaded"
			// for a deck whose audio was still playing.
			await page.getByRole('tab', { name: 'A', exact: true }).click();
			await expectDeckShows(page, 'Alpha 1', 'Alpha 1.mp3');

			// Advance Deck B and prove Deck A's screen does not follow it.
			await page.getByRole('tab', { name: 'B', exact: true }).click();
			// Wait for the deck switch to land: it is what re-points the MiniPlayer's
			// Next button at Deck B.
			await expect(miniPlayer(page)).toContainText('Beta 3');
			await miniPlayer(page).getByRole('button', { name: 'Next' }).click();
			await expectDeckShows(page, 'Beta 4', 'Beta 4.mp3');
			await page.getByRole('tab', { name: 'A', exact: true }).click();
			await expectDeckShows(page, 'Alpha 1', 'Alpha 1.mp3');

			// Now let Deck A act: its index is in range for Deck B but names a
			// different track, so the old code showed Deck B the wrong title.
			await miniPlayer(page).getByRole('button', { name: 'Next' }).click();
			await expectDeckShows(page, 'Alpha 2', 'Alpha 2.mp3');
			await page.getByRole('tab', { name: 'B', exact: true }).click();
			await expectDeckShows(page, 'Beta 4', 'Beta 4.mp3');
		} finally {
			fs.rmSync(dirA, { recursive: true, force: true });
			fs.rmSync(dirB, { recursive: true, force: true });
		}
	});

	test('stopping the displayed deck leaves the other deck playing, both directions', async ({ page }) => {
		// The user report this pins: with both decks playing, switching back to a
		// deck and pressing stop did not stop it. The only transport the UI offers
		// is the MiniPlayer's play/pause button (there is no distinct stop), so
		// "stop" is a deliberate pause of the displayed deck.
		const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-deck-a-'));
		const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-deck-b-'));
		createMinimalMp3('Alpha 1.mp3', dirA);
		createMinimalMp3('Alpha 2.mp3', dirA);
		createMinimalMp3('Beta 1.mp3', dirB);
		createMinimalMp3('Beta 2.mp3', dirB);
		createMinimalMp3('Beta 3.mp3', dirB);
		createMinimalMp3('Beta 4.mp3', dirB);

		try {
			// Repeat-one pins each 1 s fixture to its own track so neither deck
			// auto-advances (or stops at the end) while the other is being stopped.
			await page.addInitScript(() => {
				localStorage.setItem('music-settings', JSON.stringify({ isRepeat: true }));
			});
			await installDeckAudioProbe(page);

			await page.goto('/');
			await waitForHydration(page);

			// Deck A: two tracks, first playing. Deck B: four tracks, third playing.
			await loadMp3Folder(page, dirA);
			await page.getByRole('button', { name: /Play Alpha 1/ }).click();
			await expect(miniPlayer(page)).toContainText('Alpha 1', { timeout: 10_000 });

			await page.getByRole('tab', { name: 'B', exact: true }).click();
			await loadDeckBFolder(page, dirB);
			await page.getByRole('button', { name: /Play Beta 3/ }).click();
			await expect(miniPlayer(page)).toContainText('Beta 3', { timeout: 10_000 });

			await page.getByRole('button', { name: /Return to music player/ }).click();
			// Both detached deck elements really are playing their own file.
			await expect.poll(() => playingDeckFiles(page), { timeout: 10_000 })
				.toEqual(expect.arrayContaining(['Alpha 1.mp3', 'Beta 3.mp3']));

			const mini = miniPlayer(page);

			// ── Direction 1: display Deck A, stop it; Deck B must keep playing. ──
			await page.getByRole('tab', { name: 'A', exact: true }).click();
			await expect(visibleDeckTitle(page)).toHaveText('Alpha 1');
			await expect(mini.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();

			await mini.getByRole('button', { name: 'Pause', exact: true }).click();

			// The displayed deck's element is paused (not unloaded: this is a pause,
			// not a cross-source stop) and its UI shows the stopped state...
			await expect.poll(() => deckElementState(page, 'Alpha 1.mp3'), { timeout: 5_000 })
				.toEqual({ paused: true, loaded: true });
			await expect(mini.getByRole('button', { name: 'Play', exact: true })).toBeVisible();
			await expect(visibleDeckTitle(page)).toHaveText('Alpha 1');
			await expect(mini).toContainText('Alpha 1');
			await expect(visiblePlayingIndicator(page)).toHaveCount(0);
			// ...while the other deck's element is untouched and still on its track.
			await expect.poll(() => deckElementState(page, 'Beta 3.mp3'), { timeout: 5_000 })
				.toEqual({ paused: false, loaded: true });

			// ── Direction 2: resume Deck A, display Deck B, stop it. ──
			await mini.getByRole('button', { name: 'Play', exact: true }).click();
			await expect(mini.getByRole('button', { name: 'Pause', exact: true })).toBeVisible({ timeout: 10_000 });
			await expect.poll(() => deckElementState(page, 'Alpha 1.mp3'), { timeout: 5_000 })
				.toEqual({ paused: false, loaded: true });

			await page.getByRole('tab', { name: 'B', exact: true }).click();
			await expect(visibleDeckTitle(page)).toHaveText('Beta 3');
			await expect(mini.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();

			await mini.getByRole('button', { name: 'Pause', exact: true }).click();

			await expect.poll(() => deckElementState(page, 'Beta 3.mp3'), { timeout: 5_000 })
				.toEqual({ paused: true, loaded: true });
			await expect(mini.getByRole('button', { name: 'Play', exact: true })).toBeVisible();
			await expect(visibleDeckTitle(page)).toHaveText('Beta 3');
			await expect(mini).toContainText('Beta 3');
			await expect(visiblePlayingIndicator(page)).toHaveCount(0);
			await expect.poll(() => deckElementState(page, 'Alpha 1.mp3'), { timeout: 5_000 })
				.toEqual({ paused: false, loaded: true });
		} finally {
			fs.rmSync(dirA, { recursive: true, force: true });
			fs.rmSync(dirB, { recursive: true, force: true });
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
