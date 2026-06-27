import { test, expect, type Page } from '@playwright/test';
import { goToTab, waitForHydration } from './helpers';

// Regression: starting a radio stream (or podcast) must reach the playing
// state and show the pause indicator. The mixer's global playing-flag sync
// previously called mediaEngine.setPlaying(false) reactively when the decks
// were paused by claimAudio(), which clobbered the newly-started stream's
// isPlaying=true and made the play/pause button never switch to Pause.
//
// A short valid WAV is served as the "live stream" so <audio> can reach
// 'playing' without a real network source.

const WAV = Buffer.from([
	0x52,0x49,0x46,0x46, 0x24,0x00,0x00,0x00, 0x57,0x41,0x56,0x45,
	0x66,0x6d,0x74,0x20, 0x10,0x00,0x00,0x00, 0x01,0x00,0x01,0x00,
	0x44,0xac,0x00,0x00, 0x88,0x58,0x01,0x00, 0x02,0x00,0x10,0x00,
	0x64,0x61,0x74,0x61, 0x04,0x00,0x00,0x00, 0x00,0x00,0x00,0x00,
]);

const MOCK_STATION = {
	stationuuid: 'uuid-stream',
	name: 'Playable Stream',
	url: 'https://stream.playable.example/live.wav',
	url_resolved: 'https://stream.playable.example/live.wav',
	favicon: '', country: 'US', tags: '', codec: 'MP3', bitrate: 128, votes: 1000,
};

async function setup(page: Page) {
	await page.route('**/accounts.google.com/gsi/client**', (route) =>
		route.fulfill({ status: 200, contentType: 'application/javascript', body: '// gsi stub' })
	);
	await page.route('**/accounts.google.com/**', (route) => route.abort());
	await page.route('**/oauth2.googleapis.com/**', (route) => route.abort());
	await page.route('**/api/radio/search**', (route) =>
		route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([MOCK_STATION]) })
	);
	await page.route('**/stream.playable.example/**', (route) =>
		route.fulfill({ status: 200, contentType: 'audio/wav', body: WAV })
	);
}

test('radio stream reaches playing state after start', async ({ page }) => {
	await setup(page);
	await page.goto('/');
	await waitForHydration(page);
	await goToTab(page, 'Radio');

	await page.getByRole('button', { name: /Search/i }).first().click();
	const form = page.locator('form').filter({ has: page.getByPlaceholder(/Search radio stations/i) });
	await form.getByPlaceholder(/Search radio stations/i).fill('playable');
	await form.getByRole('button', { name: 'Search', exact: true }).click();

	await expect(page.getByText('Playable Stream')).toBeVisible({ timeout: 5000 });

	await page.locator('main').getByText('Playable Stream').click();
	await page.waitForTimeout(3000);

	// Playing indicator: animated equalizer bars OR MiniPlayer Pause button
	const equalizer = page.locator('div.animate-pulse.bg-primary').first();
	const miniPause = page.locator('button[aria-label="Pause"]').first();
	const playing = await equalizer.isVisible().catch(() => false);
	const paused = await miniPause.isVisible().catch(() => false);

	expect(playing || paused).toBeTruthy();
});
