/**
 * Pairs sub-tab — the fourth music tab, between B and YouTube.
 *
 * The web build has no native library, so these tests reach the tab through the
 * real UI and assert on rendered text only. Nothing here seeds the pairings
 * store: the tab owns an empty state at this stage and the row list lands in a
 * later phase.
 */
import { test, expect } from '@playwright/test';
import { goToTab } from './helpers';

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
});
