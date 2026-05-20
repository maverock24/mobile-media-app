import { test, expect } from '@playwright/test';
import { goToTab } from './helpers';

const MINIMAL_MP3 = Buffer.from([
	0x49, 0x44, 0x33, 0x03, 0x00, 0x00,
	0x00, 0x00, 0x00, 0x00,
	0xff, 0xfb, 0x90, 0x00,
	0x00, 0x00, 0x00, 0x00,
]);

test.describe('Google Drive music library', () => {
	test('retries Google sign-in after an initial GIS script load failure', async ({ page }) => {
		let scriptRequests = 0;

		await page.addInitScript(() => {
			window.__GOOGLE_CLIENT_ID__ = 'playwright-google-client-id.apps.googleusercontent.com';
		});

		await page.route('https://accounts.google.com/gsi/client', async (route) => {
			scriptRequests += 1;
			if (scriptRequests === 1) {
				await route.abort('failed');
				return;
			}

			await route.fulfill({
				status: 200,
				contentType: 'application/javascript',
				body: `
					window.google = {
						accounts: {
							oauth2: {
								initTokenClient: function(config) {
									return {
										requestAccessToken: function() {
											config.callback({
												access_token: 'drive-token',
												expires_in: 3600,
												scope: 'https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/drive.appdata',
												token_type: 'Bearer'
											});
										}
									};
								},
								revoke: function(_token, done) { done(); }
							}
						}
					};
				`
			});
		});

		await page.route('https://www.googleapis.com/drive/v3/about?*', async (route) => {
			await route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify({
					user: {
						displayName: 'Drive Retry Tester',
						emailAddress: 'retry@example.com'
					}
				})
			});
		});

		await page.route('https://www.googleapis.com/drive/v3/files?*', async (route) => {
			const url = new URL(route.request().url());
			if (url.searchParams.get('spaces') === 'appDataFolder') {
				await route.fulfill({
					status: 200,
					contentType: 'application/json',
					body: JSON.stringify({ files: [] })
				});
				return;
			}
			await route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify({ files: [] })
			});
		});

		await page.goto('/');
		await goToTab(page, 'Music');

		await page.getByRole('button', { name: /Connect Google Drive/i }).click();
		await expect(page.getByText('Unable to load Google Identity Services.')).toBeVisible({ timeout: 5000 });

		await page.getByRole('button', { name: /Connect Google Drive/i }).click();

		await expect(page.getByRole('dialog', { name: 'Choose Google Drive folder' })).toBeVisible({ timeout: 5000 });
		await expect(page.getByRole('button', { name: /Select all/i })).toBeVisible();
		await expect.poll(() => scriptRequests).toBe(2);
	});

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
			const url = new URL(route.request().url());
			// Return empty for appDataFolder config-sync queries so findConfigFileId returns null
			if (url.searchParams.get('spaces') === 'appDataFolder') {
				await route.fulfill({
					status: 200,
					contentType: 'application/json',
					body: JSON.stringify({ files: [] })
				});
				return;
			}
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

		// A folder-selection dialog appears after connecting. Select all to load files.
		// locator.click() has built-in auto-waiting so it will wait for the button to appear.
		await page.getByRole('button', { name: /Select all/i }).click();

		await expect(page.getByText('drive.tester@example.com')).toBeVisible({ timeout: 5000 });
		await expect(page.getByText('Drive Song')).toBeVisible();

		await page.getByText('Drive Song').click();

		await expect.poll(() => downloadCount).toBe(1);
		await expect(page.getByText('Drive Song').first()).toBeVisible();
	});

	test('still opens the folder picker when Drive user lookup fails', async ({ page }) => {
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
									scope: 'https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/drive.appdata',
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
				status: 500,
				contentType: 'application/json',
				body: JSON.stringify({ error: { message: 'profile lookup failed' } })
			});
		});

		await page.route('https://www.googleapis.com/drive/v3/files?*', async (route) => {
			const url = new URL(route.request().url());
			if (url.searchParams.get('spaces') === 'appDataFolder') {
				await route.fulfill({
					status: 200,
					contentType: 'application/json',
					body: JSON.stringify({ files: [] })
				});
				return;
			}
			await route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify({ files: [] })
			});
		});

		await page.goto('/');
		await goToTab(page, 'Music');

		await page.getByRole('button', { name: /Connect Google Drive/i }).click();

		await expect(page.getByRole('dialog', { name: 'Choose Google Drive folder' })).toBeVisible({ timeout: 5000 });
		await expect(page.getByRole('button', { name: /Select all/i })).toBeVisible();
	});

	test('does not start a second interactive auth flow before the folder picker opens', async ({ page }) => {
		let interactiveAuthRequests = 0;

		await page.addInitScript(() => {
			window.__GOOGLE_CLIENT_ID__ = 'playwright-google-client-id.apps.googleusercontent.com';
			window.google = {
				accounts: {
					oauth2: {
						initTokenClient: (config) => ({
							requestAccessToken: ({ prompt } = {}) => {
								const scope = config.scope ?? '';
								if (scope.includes('drive.appdata') && !scope.includes('drive.readonly') && prompt === 'none') {
									config.error_callback?.({ type: 'silent_failed' });
									return;
								}

								if (prompt !== 'none') {
									window.__interactiveAuthRequests__ = (window.__interactiveAuthRequests__ ?? 0) + 1;
								}

								config.callback({
									access_token: 'drive-token',
									expires_in: 3600,
									scope,
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
			const url = new URL(route.request().url());
			if (url.searchParams.get('spaces') === 'appDataFolder') {
				await route.fulfill({
					status: 200,
					contentType: 'application/json',
					body: JSON.stringify({ files: [] })
				});
				return;
			}

			await route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify({ files: [] })
			});
		});

		await page.goto('/');
		await goToTab(page, 'Music');

		await page.getByRole('button', { name: /Connect Google Drive/i }).click();

		await expect(page.getByRole('dialog', { name: 'Choose Google Drive folder' })).toBeVisible({ timeout: 5000 });
		await expect(page.getByRole('button', { name: /Select all/i })).toBeVisible();
		await expect.poll(async () => page.evaluate(() => window.__interactiveAuthRequests__ ?? 0)).toBe(1);
	});
});