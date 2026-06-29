import { test, expect, type Page } from '@playwright/test';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function loadLibrary(page: Page, dir: string) {
	const [fileChooser] = await Promise.all([
		page.waitForEvent('filechooser'),
		page.evaluate(() => {
			const input = document.querySelector('input[type="file"][multiple]') as HTMLInputElement | null;
			if (input) { input.style.display = 'block'; input.click(); }
		}),
	]);
	await fileChooser.setFiles(dir);
	await page.waitForTimeout(800);
}

async function readSession(page: Page, name: string) {
	return page.evaluate((n) => {
		const all = JSON.parse(localStorage.getItem('mixer-sessions') || '[]');
		return all.find((s: any) => s.name === n) || null;
	}, name);
}

test('mixer sessions — saved sessions are immutable snapshots; saving never overrides a previous one', async ({ page }) => {
	const dir = mkdtempSync(join(tmpdir(), 'mixer-sess-'));
	const stub = Buffer.concat([Buffer.from('ID3\x04\x00\x00\x00\x00\x00'), Buffer.alloc(200, 0)]);
	writeFileSync(join(dir, 'alpha.mp3'), stub);
	writeFileSync(join(dir, 'beta.mp3'), stub);
	writeFileSync(join(dir, 'gamma.mp3'), stub);

	await page.goto('/');
	await page.waitForTimeout(1500);
	await loadLibrary(page, dir);

	// Open the mixer view via the MiniPlayer button (click a track first to set mediaEngine.item)
	await page.getByText('alpha').first().click();
	await page.waitForTimeout(500);
	await page.getByRole('button', { name: /Open mixer/i }).click();
	await page.waitForTimeout(400);

	// Load alpha into deck A, beta into deck B
	await page.locator('button[aria-label="Load into deck A"]').first().click();
	await page.waitForTimeout(500);
	await page.locator('button[aria-label="Load into deck B"]').nth(1).click();
	await page.waitForTimeout(500);

	// Switch to Sessions tab and save "Mix One"
	await page.getByRole('button', { name: /^Sessions$/i }).click();
	await page.waitForTimeout(200);
	await page.locator('input[aria-label="Session name"]').fill('Mix One');
	await page.getByRole('button', { name: /Save current mixer session/i }).click();
	await page.waitForTimeout(500);

	// Saved session reflects the state at save time
	const s1 = await readSession(page, 'Mix One');
	expect(s1.A.displayName).toBe('alpha');
	expect(s1.B.displayName).toBe('beta');
	expect(s1.A.loop).toBe(false);
	// The freshly saved session becomes the active one
	const activeId = await page.evaluate(() => JSON.parse(localStorage.getItem('mixer-active-session') || 'null'));
	expect(activeId).toBe(s1.id);

	// Mutate the decks AFTER saving — loop A on, B volume ~0.5. Saved sessions are
	// immutable snapshots, so "Mix One" must NOT change (the old auto-persist bug
	// would silently overwrite it here).
	await page.locator('button[aria-label="Loop deck A"]').click();
	await page.locator('input[aria-label="Deck B volume"]').fill('0.5');
	await page.waitForTimeout(400);
	const s1Untouched = await readSession(page, 'Mix One');
	expect(s1Untouched.A.loop).toBe(false);
	expect(Math.abs(s1Untouched.B.volume - 0.85)).toBeLessThan(0.05);

	// Save a second session with different decks (gamma in A)
	await page.getByRole('button', { name: /^Library$/i }).click();
	await page.waitForTimeout(200);
	await page.locator('button[aria-label="Load into deck A"]').nth(2).click();
	await page.waitForTimeout(500);
	await page.getByRole('button', { name: /^Sessions$/i }).click();
	await page.waitForTimeout(200);
	await page.locator('input[aria-label="Session name"]').fill('Mix Two');
	await page.getByRole('button', { name: /Save current mixer session/i }).click();
	await page.waitForTimeout(500);

	const s2 = await readSession(page, 'Mix Two');
	expect(s2.A.displayName).toBe('gamma');
	// Saving "Mix Two" must NOT have overridden "Mix One" (the user's reported bug)
	const s1StillUntouched = await readSession(page, 'Mix One');
	expect(s1StillUntouched.A.displayName).toBe('alpha');
	expect(s1StillUntouched.B.displayName).toBe('beta');
	expect(s1StillUntouched.A.loop).toBe(false);
	// The newly saved session is now active
	const activeId2 = await page.evaluate(() => JSON.parse(localStorage.getItem('mixer-active-session') || 'null'));
	expect(activeId2).toBe(s2.id);

	// Load "Mix One" back — restores the SAVED snapshot (alpha/beta, loop off),
	// not whatever the live decks held before the load.
	await page.getByRole('button', { name: /Load session Mix One/i }).click();
	await page.waitForTimeout(800);
	await expect(page.locator('button[aria-label="Loop deck A"]')).toHaveAttribute('aria-pressed', 'false');
	// "Mix One" becomes active again
	const activeId3 = await page.evaluate(() => JSON.parse(localStorage.getItem('mixer-active-session') || 'null'));
	const s1Reloaded = await readSession(page, 'Mix One');
	expect(activeId3).toBe(s1Reloaded.id);

	// Delete both sessions
	await page.getByRole('button', { name: /Delete session Mix One/i }).click();
	await page.waitForTimeout(300);
	await page.getByRole('button', { name: /Delete session Mix Two/i }).click();
	await page.waitForTimeout(300);
	await expect(page.getByText('Mix One')).toHaveCount(0);
	await expect(page.getByText('Mix Two')).toHaveCount(0);
	const storedAfter = await page.evaluate(() => JSON.parse(localStorage.getItem('mixer-sessions') || '[]'));
	expect(storedAfter.length).toBe(0);
});
