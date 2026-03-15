import { defineConfig, devices } from '@playwright/test';

// When PW_BASE_URL is set (e.g. a running dev server), use that directly.
// Otherwise, let webServer build + preview on port 4173.
const BASE_URL = process.env.PW_BASE_URL ?? 'http://localhost:4173';

export default defineConfig({
	testDir: './tests',
	fullyParallel: false,   // serial — tests share a preview server
	forbidOnly: !!process.env.CI,
	retries: process.env.CI ? 1 : 0,
	workers: 1,
	reporter: [['list'], ['html', { outputFolder: 'playwright-report', open: 'never' }]],

	use: {
		baseURL: BASE_URL,
		// Mobile viewport — this is a mobile-first app
		viewport: { width: 390, height: 844 },
		trace: 'on-first-retry',
		screenshot: 'only-on-failure',
	},

	projects: [
		{
			name: 'chromium',
			use: { ...devices['Desktop Chrome'] , viewport: { width: 390, height: 844 } },
		},
	],

	// Build + start preview server unless caller already has one running (PW_BASE_URL).
	webServer: process.env.PW_BASE_URL ? undefined : {
		command: 'pnpm build && pnpm preview',
		url: 'http://localhost:4173',
		reuseExistingServer: !process.env.CI,
		timeout: 120_000,
	},
});
