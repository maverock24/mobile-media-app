import { test, expect } from '@playwright/test';
import { goToTab } from './helpers';

const MINIMAL_MP3 = Buffer.from([
	0x49, 0x44, 0x33, 0x03, 0x00, 0x00,
	0x00, 0x00, 0x00, 0x00,
	0xff, 0xfb, 0x90, 0x00,
	0x00, 0x00, 0x00, 0x00,
]);

test.describe('Google Drive music library', () => {
	test('connects to Google Drive and loads MP3 files', async ({ page }) => {
		let downloadCount = 0;

		await page.addInitScript(() => {
			window.__GOOGLE_CLIENT_ID__ = 'playwright-google-client-id.apps.googleusercontent.com';
			window.google = {
				accounts: {
					oauth2: {
						initTokenClient: (config) => ({
							requestAccessToken: () => {
								config.callback({
									access_token: 'drive-token',
									expires_in: 3600,
									scope: 'https://www.googleapis.com/auth/drive.readonly',
									token_type: 'Bearer'
								});
							}
						}),
						revoke: (_token, done) => done()
					}
				}
			};
		});

		await page.route('https://www.googleapis.com/drive/v3/about?*', async (route) => {
			await route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify({
					user: {
						displayName: 'Drive Tester',
						emailAddress: 'drive.tester@example.com'
					}
				})
			});
		});

		await page.route('https://www.googleapis.com/drive/v3/files?*', async (route) => {
			await route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify({
					files: [
						{
							id: 'drive-track-1',
							name: 'Drive Artist - Drive Song.mp3',
							mimeType: 'audio/mpeg',
							fileExtension: 'mp3',
							modifiedTime: '2026-03-17T12:00:00Z',
							size: '2048'
						}
					]
				})
			});
		});

		await page.route('https://www.googleapis.com/drive/v3/files/drive-track-1?alt=media', async (route) => {
			downloadCount += 1;
			await route.fulfill({
				status: 200,
				contentType: 'audio/mpeg',
				body: MINIMAL_MP3
			});
		});

		await page.goto('/');
		await goToTab(page, 'Music');

		await page.getByRole('button', { name: /Connect Google Drive/i }).click();

		await expect(page.getByText('drive.tester@example.com')).toBeVisible();
		await expect(page.getByText('Drive Song')).toBeVisible();

		await page.getByText('Drive Song').click();

		await expect.poll(() => downloadCount).toBe(1);
		await expect(page.getByText('Drive Song').first()).toBeVisible();
	});
});