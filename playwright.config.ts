import { defineConfig, devices } from '@playwright/test';

// When PW_BASE_URL is set (e.g. a running dev server), use that directly.
// Otherwise, let webServer build + preview on port 4173.
const BASE_URL = process.env.PW_BASE_URL ?? 'http://localhost:4173';

export default defineConfig({
	testDir: './tests',
	fullyParallel: false,   // serial — tests share a preview server
	forbidOnly: !!process.env.CI,
	retries: 1,
	workers: 1,
	reporter: [['list'], ['html', { outputFolder: 'playwright-report', open: 'never' }]],

	// Raise the expect assertion timeout so that tests against the live
	// Netlify deployment (cold JS bundle download + hydration) don't flake.
	expect: {
		timeout: 10_000,
	},

	use: {
		baseURL: BASE_URL,
		// Mobile viewport — this is a mobile-first app
		viewport: { width: 390, height: 844 },
		trace: 'on-first-retry',
		screenshot: 'only-on-failure',
		// Block service workers so cache-first SW installation does not abort
		// the first page.goto() calls during test setup.
		serviceWorkers: 'block',
	},

	projects: [
		{
			name: 'chromium',
			use: { ...devices['Desktop Chrome'] , viewport: { width: 390, height: 844 } },
		},
	],

	// Build + start preview server unless caller already has one running (PW_BASE_URL).
	webServer: process.env.PW_BASE_URL ? undefined : {
		command: `PUBLIC_GOOGLE_CLIENT_ID=${process.env.PUBLIC_GOOGLE_CLIENT_ID ?? 'playwright-google-client-id.apps.googleusercontent.com'} pnpm build && PUBLIC_GOOGLE_CLIENT_ID=${process.env.PUBLIC_GOOGLE_CLIENT_ID ?? 'playwright-google-client-id.apps.googleusercontent.com'} pnpm preview`,
		url: 'http://localhost:4173',
		reuseExistingServer: false,
		timeout: 120_000,
	},
});
