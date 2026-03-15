/**
 * Shared helpers and selectors used across the test suite.
 */
import { type Page, expect } from '@playwright/test';

export const BASE = 'http://localhost:4173';

// ── Tab navigation ──────────────────────────────────────────────────────────
export async function goToTab(page: Page, label: 'Music' | 'Podcasts' | 'Weather' | 'Settings') {
	await page.getByRole('button', { name: label, exact: true }).click();
}

// ── Confirm a tab is visually active (dot indicator) ───────────────────────
export async function expectActiveTab(page: Page, label: string) {
	const btn = page.getByRole('button', { name: label, exact: true });
	await expect(btn).toHaveClass(/text-primary/);
}

// ── Wait for network idle after navigation ──────────────────────────────────
export async function navigationIdle(page: Page) {
	await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
}
