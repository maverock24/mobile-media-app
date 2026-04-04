/**
 * Shared helpers and selectors used across the test suite.
 */
import { type Page, expect } from '@playwright/test';

export const BASE = 'http://localhost:4173';

// ── Tab navigation ──────────────────────────────────────────────────────────
// Wait for SvelteKit to fully hydrate the page before switching tabs.
// We wait for body[data-hydrated] (set via onMount), falling back to waiting
// for the tablist to appear (visible in prerendered HTML before JS runs).
export async function waitForHydration(page: Page): Promise<void> {
	// Prefer the hydration marker (set by onMount in +layout.svelte).
	// If it never appears (e.g. an effect error prevented onMount from firing),
	// fall back to the tablist being visible — a reliable sign of rendering.
	await Promise.race([
		page.waitForSelector('body[data-hydrated]', { timeout: 15_000 }),
		page.waitForSelector('[role="tablist"]', { timeout: 15_000 }),
	]);
	// Small pause to let reactive effects settle after initial mount.
	await page.waitForTimeout(300);
}

export async function goToTab(page: Page, label: 'Music' | 'Podcasts' | 'Essays' | 'Weather' | 'Settings') {
	await waitForHydration(page);
	const tab = page.getByRole('tab', { name: label, exact: true });
	await tab.click();
	// On slow connections (e.g. Netlify CDN cold start) the click may not register
	// immediately. If aria-selected hasn't updated after 3s, try clicking again.
	const selected = await expect(tab)
		.toHaveAttribute('aria-selected', 'true', { timeout: 3_000 })
		.then(() => true)
		.catch(() => false);
	if (!selected) await tab.click();
	await expect(tab).toHaveAttribute('aria-selected', 'true');
}

// ── Confirm a tab is visually active (dot indicator) ───────────────────────
export async function expectActiveTab(page: Page, label: string) {
	const btn = page.getByRole('tab', { name: label, exact: true });
	await expect(btn).toHaveClass(/text-primary/);
}

// ── Wait for network idle after navigation ──────────────────────────────────
export async function navigationIdle(page: Page) {
	await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
}
