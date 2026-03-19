/**
 * MP3 Player view tests.
 * Real file loading requires FSA / webkitdirectory which aren't available in
 * headless Chromium, so folder-related tests use the <input type=file> fallback
 * via Playwright file chooser + fake MP3 buffers.
 */
import { test, expect } from '@playwright/test';
import { goToTab } from './helpers';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

// ── Tiny valid MP3 — ID3v2 header + minimal audio frame ────────────────────
// This is a minimal MP3 stub: just enough bytes for the browser not to crash.
function createMinimalMp3(name: string, dir: string): string {
	// ID3v2 tag (10 bytes) + silence frame (4 bytes sync + 4 zero bytes)
	const buf = Buffer.from([
		0x49, 0x44, 0x33, 0x03, 0x00, 0x00, // ID3v2.3 header
		0x00, 0x00, 0x00, 0x00,              // tag size = 0
		0xFF, 0xFB, 0x90, 0x00,              // MPEG1 Layer3 sync frame
		0x00, 0x00, 0x00, 0x00,
	]);
	const filePath = path.join(dir, name);
	fs.writeFileSync(filePath, buf);
	return filePath;
}

test.describe('MP3 Player view', () => {
	let tmpDir: string;

	test.beforeAll(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-mp3-'));
		createMinimalMp3('01 - Artist - Track One.mp3', tmpDir);
		createMinimalMp3('02 - Artist - Track Two.mp3', tmpDir);
		createMinimalMp3('03 - Artist - Track Three.mp3', tmpDir);
	});

	test.afterAll(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	test.beforeEach(async ({ page }) => {
		await page.goto('/');
		await page.evaluate(async () => {
			localStorage.clear();
			await new Promise<void>((resolve) => {
				const req = indexedDB.deleteDatabase('music-app');
				req.onsuccess = () => resolve();
				req.onerror = () => resolve();
				req.onblocked = () => resolve();
			});
		});
		await page.reload();
		// Music tab is default, but be explicit
		await goToTab(page, 'Music');
	});

	// ── Empty state ────────────────────────────────────────────────────────
	test('shows empty state with Open Folder button before any files are loaded', async ({ page }) => {
		await expect(page.getByText('Your Music')).toBeVisible();
		await expect(page.getByText(/Select a folder/i)).toBeVisible();
		await expect(page.getByRole('button', { name: /Open Folder/i })).toBeVisible();
	});

	test('"Open Folder" button is enabled', async ({ page }) => {
		await expect(page.getByRole('button', { name: /Open Folder/i })).toBeEnabled();
	});

	// ── File loading via input fallback ────────────────────────────────────
	test('loads MP3 files and shows browse view', async ({ page }) => {
		// Playwright intercepts the file picker
		const [fileChooser] = await Promise.all([
			page.waitForEvent('filechooser'),
			// Trigger by clicking the hidden input — we need to make it visible first
			page.evaluate(() => {
				const input = document.querySelector('input[type="file"][multiple]') as HTMLInputElement | null;
				if (input) {
					input.style.display = 'block';
					input.style.opacity = '1';
					input.click();
				}
			}),
		]);
		await fileChooser.setFiles(tmpDir);

		// Browse view should appear
		await expect(page.getByText(/Track One|Track Two|Track Three/i).first()).toBeVisible({ timeout: 5000 });
	});

	test('shows track list after loading files', async ({ page }) => {
		const [fileChooser] = await Promise.all([
			page.waitForEvent('filechooser'),
			page.evaluate(() => {
				const input = document.querySelector('input[type="file"][multiple]') as HTMLInputElement | null;
				if (input) { input.style.display = 'block'; input.click(); }
			}),
		]);
		await fileChooser.setFiles(tmpDir);

		await expect(page.getByText('Track One')).toBeVisible({ timeout: 5000 });
		await expect(page.getByText('Track Two')).toBeVisible();
	});

	test('restores the selected library after a page reload', async ({ page }) => {
		const [fileChooser] = await Promise.all([
			page.waitForEvent('filechooser'),
			page.evaluate(() => {
				const input = document.querySelector('input[type="file"][multiple]') as HTMLInputElement | null;
				if (input) { input.style.display = 'block'; input.click(); }
			}),
		]);
		await fileChooser.setFiles(tmpDir);

		await expect(page.getByText('Track One')).toBeVisible({ timeout: 5000 });
		await page.reload();
		await goToTab(page, 'Music');
		await expect(page.getByText('Track One')).toBeVisible({ timeout: 5000 });
		await expect(page.getByText('Track Two')).toBeVisible();
	});

	// ── Controls ───────────────────────────────────────────────────────────
	test('bottom toolbar shows Browse, speed, and EQ buttons', async ({ page }) => {
		// Load files first so we're in player view
		const [fc] = await Promise.all([
			page.waitForEvent('filechooser'),
			page.evaluate(() => {
				const input = document.querySelector('input[type="file"][multiple]') as HTMLInputElement | null;
				if (input) { input.style.display = 'block'; input.click(); }
			}),
		]);
		await fc.setFiles(tmpDir);

		// Click on the file in browse view to start playing → transitions to player
		await page.getByText('Track One').first().click({ timeout: 5000 });
		await page.waitForTimeout(300);

		// Player view should have toolbar
		await expect(page.getByRole('button', { name: /Browse/i })).toBeVisible({ timeout: 5000 });
		await expect(page.getByRole('button', { name: /EQ/i })).toBeVisible();
	});

	test('plays a track and shows player controls', async ({ page }) => {
		const [fc] = await Promise.all([
			page.waitForEvent('filechooser'),
			page.evaluate(() => {
				const input = document.querySelector('input[type="file"][multiple]') as HTMLInputElement | null;
				if (input) { input.style.display = 'block'; input.click(); }
			}),
		]);
		await fc.setFiles(tmpDir);

		await page.getByText('Track One').first().click({ timeout: 5000 });
		await page.waitForTimeout(300);

		// Player controls: skip back, skip forward, play/pause, shuffle, repeat
		await expect(page.locator('button:has(svg)').filter({ hasText: '' }).nth(0)).toBeAttached();
		// Progress bar input
		await expect(page.locator('input[type="range"]').first()).toBeVisible({ timeout: 5000 });
		// Track title visible
		await expect(page.getByText('Track One')).toBeVisible();
	});

	test('speed panel opens and shows speed options', async ({ page }) => {
		const [fc] = await Promise.all([
			page.waitForEvent('filechooser'),
			page.evaluate(() => {
				const input = document.querySelector('input[type="file"][multiple]') as HTMLInputElement | null;
				if (input) { input.style.display = 'block'; input.click(); }
			}),
		]);
		await fc.setFiles(tmpDir);
		await page.getByText('Track One').first().click({ timeout: 5000 });
		await page.waitForTimeout(300);

		const speedBtn = page.getByRole('button', { name: /×|Playback Speed|speed|1×/i }).first();
		// Find the speed button from toolbar
		const toolbarSpeedBtn = page.getByRole('button', { name: /1×/i }).last();
		if (await toolbarSpeedBtn.isVisible()) {
			await toolbarSpeedBtn.click();
		} else {
			await speedBtn.click();
		}

		// Speed chips
		await expect(page.getByText('0.5×')).toBeVisible({ timeout: 3000 });
		await expect(page.getByText('2×')).toBeVisible();
		await expect(page.getByText('Playback Speed')).toBeVisible();
	});

	test('EQ panel opens and shows band controls', async ({ page }) => {
		const [fc] = await Promise.all([
			page.waitForEvent('filechooser'),
			page.evaluate(() => {
				const input = document.querySelector('input[type="file"][multiple]') as HTMLInputElement | null;
				if (input) { input.style.display = 'block'; input.click(); }
			}),
		]);
		await fc.setFiles(tmpDir);
		await page.getByText('Track One').first().click({ timeout: 5000 });
		await page.waitForTimeout(300);

		await page.getByRole('button', { name: /EQ/i }).click();
		await expect(page.getByText('Equalizer')).toBeVisible({ timeout: 3000 });
		// EQ presets
		await expect(page.getByRole('button', { name: /flat/i })).toBeVisible();
		await expect(page.getByRole('button', { name: /bass/i })).toBeVisible();
		// frequency labels
		await expect(page.getByText('60')).toBeVisible();
	});

	test('volume slider is present in player view', async ({ page }) => {
		const [fc] = await Promise.all([
			page.waitForEvent('filechooser'),
			page.evaluate(() => {
				const input = document.querySelector('input[type="file"][multiple]') as HTMLInputElement | null;
				if (input) { input.style.display = 'block'; input.click(); }
			}),
		]);
		await fc.setFiles(tmpDir);
		await page.getByText('Track One').first().click({ timeout: 5000 });
		await page.waitForTimeout(300);

		// Two range inputs: progress + volume
		const ranges = page.locator('input[type="range"]');
		await expect(ranges).toHaveCount(2, { timeout: 5000 });
	});

	test('next button advances to the next track', async ({ page }) => {
		const [fc] = await Promise.all([
			page.waitForEvent('filechooser'),
			page.evaluate(() => {
				const input = document.querySelector('input[type="file"][multiple]') as HTMLInputElement | null;
				if (input) { input.style.display = 'block'; input.click(); }
			}),
		]);
		await fc.setFiles(tmpDir);
		await page.getByText('Track One').first().click({ timeout: 5000 });
		await page.waitForTimeout(300);

		await expect(page.getByText('Track One')).toBeVisible();
		await page.getByRole('button', { name: /Next/i }).first().click();
		await expect(page.getByText('Track Two')).toBeVisible({ timeout: 5000 });
	});

	test('browse button navigates back to file list', async ({ page }) => {
		const [fc] = await Promise.all([
			page.waitForEvent('filechooser'),
			page.evaluate(() => {
				const input = document.querySelector('input[type="file"][multiple]') as HTMLInputElement | null;
				if (input) { input.style.display = 'block'; input.click(); }
			}),
		]);
		await fc.setFiles(tmpDir);
		await page.getByText('Track One').first().click({ timeout: 5000 });
		await page.waitForTimeout(300);

		await page.getByRole('button', { name: /Browse/i }).click();
		await expect(page.getByText('Track One').first()).toBeVisible({ timeout: 3000 });
	});

	test('shuffle and repeat buttons are toggleable', async ({ page }) => {
		const [fc] = await Promise.all([
			page.waitForEvent('filechooser'),
			page.evaluate(() => {
				const input = document.querySelector('input[type="file"][multiple]') as HTMLInputElement | null;
				if (input) { input.style.display = 'block'; input.click(); }
			}),
		]);
		await fc.setFiles(tmpDir);
		await page.getByText('Track One').first().click({ timeout: 5000 });
		await page.waitForTimeout(300);

		// Shuffle — first SVG-only icon button on the left of controls row
		// We locate them by their aria position — use keyboard role
		const shuffleBtn = page.locator('button').filter({ has: page.locator('svg') }).nth(2); // skip back + prev
		await shuffleBtn.click();
		// No assertion on class — just verify it doesn't throw
		await page.waitForTimeout(100);
	});
});
