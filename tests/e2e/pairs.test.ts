/**
 * Pairs sub-tab — the fourth music tab, between B and YouTube.
 *
 * The web build has no native library, so these tests reach the tab through the
 * real UI and assert on rendered text only. The saved-scene row is seeded into
 * `ab-pairings` with `addInitScript`, using native-source refs: they carry no
 * live `File`, so the payload is serialisable and needs no library index.
 */
import { test, expect } from '@playwright/test';
import { goToTab } from './helpers';

const PAIR = {
	id: 7,
	name: 'Atomic Habits + Rain, 4.6.2026',
	savedAt: 1775433600000,
	a: {
		key: 'n:books/Atomic Habits.mp3',
		name: 'Atomic Habits.mp3',
		relativePath: 'books/Atomic Habits.mp3',
		source: 'native',
		path: '/storage/emulated/0/Books/Atomic Habits.mp3',
	},
	b: {
		key: 'n:music/Rain.mp3',
		name: 'Rain.mp3',
		relativePath: 'music/Rain.mp3',
		source: 'native',
		path: '/storage/emulated/0/Music/Rain.mp3',
	},
	bVolume: 40,
	bSpeed: 0.9,
	positionSec: 125,
	durationSec: 3600,
};

test.describe('Pairs sub-tab', () => {
	test('the Pairs tab opens and shows its empty state', async ({ page }) => {
		await page.goto('/');
		await goToTab(page, 'Music');

		const pairsTab = page.getByRole('tab', { name: 'Pairs', exact: true });
		await expect(pairsTab).toBeVisible();
		await pairsTab.click();
		await expect(pairsTab).toHaveAttribute('aria-selected', 'true');

		// The empty state explains what a scene is; no rows exist yet.
		await expect(page.getByText('No pairings yet.')).toBeVisible();
		await expect(
			page.getByText('A scene saves an audiobook on deck A together with music on deck B so you can resume both at once.')
		).toBeVisible();

		// The deck tabs stay reachable, so Pairs is a fourth tab, not a replacement.
		await expect(page.getByRole('tab', { name: 'A', exact: true })).toBeVisible();
		await expect(page.getByRole('tab', { name: 'B', exact: true })).toBeVisible();

		// ...and tapping a deck tab leaves the pairs panel behind.
		await page.getByRole('tab', { name: 'A', exact: true }).click();
		await expect(page.getByText('No pairings yet.')).toBeHidden();
	});

	test('renders a saved pairing with its position and a delete button', async ({ page }) => {
		await page.addInitScript((pair) => {
			localStorage.setItem('ab-pairings', JSON.stringify({ pairs: [pair], nextId: 8, activePairId: null }));
		}, PAIR);

		await page.goto('/');
		await goToTab(page, 'Music');
		await page.getByRole('tab', { name: 'Pairs', exact: true }).click();

		// The rows replace the empty state.
		await expect(page.getByText('No pairings yet.')).toBeHidden();

		// Anchored: the delete button's accessible name also contains the pair name.
		const row = page.getByRole('button', { name: /^Atomic Habits \+ Rain, 4\.6\.2026/ });
		await expect(row).toBeVisible();
		// Position 125 s over a one-hour duration, and deck B's volume.
		await expect(row).toContainText('2:05 / 1:00:00');
		await expect(row).toContainText('40%');

		// The delete affordance is a sibling button with an accessible name.
		await expect(page.getByRole('button', { name: 'Delete Atomic Habits + Rain, 4.6.2026' })).toBeVisible();

		// The panel mounts no player of its own. These two DOM <audio> elements
		// belong to PodcastView and YoutubePanel; the music decks create their
		// elements with `new Audio()` in the player module and never append them, so
		// a deck mounted behind the Pairs tab adds none.
		await expect(page.locator('audio')).toHaveCount(2);
	});
});
