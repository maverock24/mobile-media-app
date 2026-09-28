import { test, expect, type Route, type Page } from '@playwright/test';
import { waitForHydration } from './helpers';

/**
 * YouTube panel — end-to-end against the real YouTube.
 *
 * On a device, InnerTube calls go out through CapacitorHttp, which is why the
 * browser CORS wall never applies. This test recreates that condition by
 * proxying the requests from Node via route.fetch() and attaching CORS headers
 * to the replies. `bypassCSP` removes the second obstacle: the app's CSP has no
 * youtube.com in connect-src, which is correct for production because the
 * native path never issues a browser fetch.
 *
 * So this exercises the real panel component, the real client module, the real
 * extraction, the real googlevideo stream and the real engine wiring —
 * everything except the native HTTP transport itself, which is pinned
 * separately in tests/unit/youtube/native-http.test.ts.
 *
 * It has already earned its keep: it caught that ANDROID_VR player URLs answer
 * an unbounded `Range: bytes=0-` probe with 403 text/plain, which an <audio>
 * element cannot recover from. See PLAYBACK_CLIENT in $lib/youtube/client.
 */

test.use({ bypassCSP: true });

/**
 * Opt-in. These tests hit real YouTube, and CI runs on datacenter IPs — the
 * exact case YouTube blocks, and the reason this feature is on-device at all.
 * Leaving them ungated would make `quality.yml` red on every push to main, and
 * would couple the pipeline to YouTube's availability.
 *
 * Run locally with: pnpm test:e2e:live
 */
const LIVE = process.env.YOUTUBE_E2E === '1';

const CORS_HEADERS = 'content-type, x-goog-visitor-id, x-origin, x-youtube-client-name, x-youtube-client-version, accept, accept-language';

/**
 * Proxy a cross-origin request from Node and make it CORS-legal for the page.
 *
 * Two deviations from a plain pass-through, both harness artifacts that do not
 * exist on device:
 *
 *  1. youtubei.js sends `credentials: 'include'`, so the browser rejects a
 *     wildcard Access-Control-Allow-Origin. Echo the page's origin instead.
 *  2. The browser forces `Origin: http://127.0.0.1:4177` (Origin is a forbidden
 *     header, so the page cannot override it) and YouTube answers 403. On
 *     device CapacitorHttp adds no browser Origin at all, so rewrite it to what
 *     youtubei.js intends.
 */
async function proxy(route: Route) {
	const requestHeaders = route.request().headers();
	const pageOrigin = requestHeaders['origin'] ?? '*';
	const allowOrigin: Record<string, string> = {
		'access-control-allow-origin': pageOrigin,
		'access-control-allow-credentials': 'true',
	};

	if (route.request().method() === 'OPTIONS') {
		await route.fulfill({
			status: 204,
			headers: {
				...allowOrigin,
				'access-control-allow-methods': 'GET, POST, OPTIONS',
				'access-control-allow-headers': requestHeaders['access-control-request-headers'] ?? CORS_HEADERS,
				'access-control-max-age': '600',
			},
			body: '',
		});
		return;
	}

	const forwarded: Record<string, string> = { ...requestHeaders };
	delete forwarded['origin'];
	delete forwarded['referer'];
	delete forwarded['content-length'];
	forwarded['origin'] = 'https://www.youtube.com';
	forwarded['referer'] = 'https://www.youtube.com/';

	try {
		// route.fetch() runs in Node, so the request leaves from this machine's
		// IP — the same IP the resulting googlevideo URL is bound to.
		const response = await route.fetch({ headers: forwarded });
		await route.fulfill({ response, headers: { ...response.headers(), ...allowOrigin } });
	} catch (error) {
		await route.fulfill({
			status: 502,
			headers: { ...allowOrigin, 'content-type': 'application/json' },
			body: JSON.stringify({ error: String(error) }),
		});
	}
}

/** Open the panel from the empty state — reachable without an MP3 library. */
async function openPanel(page: Page) {
	await page.goto('/');
	await waitForHydration(page);
	await page.getByRole('button', { name: /Play from YouTube/ }).click();
	await expect(page.getByRole('button', { name: 'Close YouTube' })).toBeVisible();
}

async function search(page: Page, query: string) {
	await page.getByPlaceholder('Search, or paste a link').fill(query);
	await page.getByRole('button', { name: 'Search YouTube' }).click();
	await expect(page.locator('button[aria-label^="Play "]').first()).toBeVisible({ timeout: 45_000 });
}

/**
 * The panel's own controls. The MiniPlayer sits in the same DOM (behind the
 * overlay) and reuses labels like "Pause" and "Seek", so panel assertions must
 * be scoped to avoid strict-mode violations.
 */
function panel(page: Page) {
	return page
		.locator('div.absolute.inset-0.z-50')
		.filter({ has: page.getByRole('button', { name: 'Close YouTube' }) });
}

/** The panel's audio element: rendered once at the shell level. */
function youtubeAudio(page: Page) {
	return page.locator('main > audio');
}

test.describe('YouTube panel', () => {
	test.skip(
		!LIVE,
		'Needs live YouTube. Re-run with pnpm test:e2e:live (datacenter IPs are blocked by YouTube).'
	);

	// Real network to YouTube, plus a resolve per track change. The default 30s
	// budget is not enough for the playback test.
	test.describe.configure({ timeout: 180_000 });

	test.beforeEach(async ({ context }) => {
		await context.route('https://www.youtube.com/**', proxy);
		await context.route('https://youtubei.googleapis.com/**', proxy);
	});

	test('opens from the empty state and reports the platform clearly', async ({ page }) => {
		await openPanel(page);

		await expect(page.getByText('Audio only')).toBeVisible();
		await expect(page.getByRole('button', { name: 'Search YouTube' })).toBeVisible();
		await expect(page.getByText(/only works in the Android app build/)).toBeVisible();

		// Both tabs exist; favorites starts empty.
		await expect(page.getByRole('button', { name: /^Favorites/ })).toBeVisible();
		await page.getByRole('button', { name: /^Favorites/ }).click();
		await expect(page.getByText(/No favorite YouTube tracks yet/)).toBeVisible();
	});

	test('searches YouTube and renders real results', async ({ page }) => {
		await openPanel(page);
		await search(page, 'top hits 2024');

		// Results come from the live InnerTube search, not a fixture.
		expect(await page.locator('button[aria-label^="Play "]').count()).toBeGreaterThan(3);

		// Thumbnails must genuinely load from i.ytimg.com.
		const thumb = page.locator('img[src*="ytimg.com"]').first();
		await expect(thumb).toBeVisible();
		expect(await thumb.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);

		// Duration labels prove the video-shaped nodes were narrowed correctly.
		await expect(page.getByText(/\d+:\d\d/).first()).toBeVisible();
	});

	test('plays a search result and hands off to the MiniPlayer', async ({ page }) => {
		await openPanel(page);
		await search(page, 'lofi hip hop');

		const audio = youtubeAudio(page);
		await expect(audio).toHaveCount(1);

		await page.locator('button[aria-label^="Play "]').first().click();

		// The resolved URL must be a real googlevideo stream.
		await expect(audio).toHaveAttribute('src', /googlevideo\.com/, { timeout: 45_000 });

		// Real bytes must arrive. This is the assertion that fails if a client
		// whose URLs reject unbounded range probes is used.
		await expect
			.poll(async () => audio.evaluate((el: HTMLAudioElement) => el.readyState), {
				timeout: 45_000,
				message: 'audio never reached HAVE_METADATA (unbounded range probe blocked?)',
			})
			.toBeGreaterThanOrEqual(1);

		await expect
			.poll(async () => audio.evaluate((el: HTMLAudioElement) => el.paused), {
				timeout: 30_000,
				message: 'audio never started playing',
			})
			.toBe(false);

		await expect
			.poll(async () => audio.evaluate((el: HTMLAudioElement) => el.currentTime), {
				timeout: 30_000,
				message: 'currentTime never advanced',
			})
			.toBeGreaterThan(0.2);

		expect(await audio.evaluate((el: HTMLAudioElement) => el.duration)).toBeGreaterThan(0);

		// Panel transport + queue counter. exact:true because every result row is
		// labelled `Play <title>`, which substring-matches "Play".
		await expect(panel(page).getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
		await expect(panel(page).getByText(/^1 \/ \d+$/)).toBeVisible();

		// Pause/resume through the panel. Resume must re-use the existing src (it
		// is still set), not re-resolve.
		await panel(page).getByRole('button', { name: 'Pause', exact: true }).click();
		await expect
			.poll(async () => audio.evaluate((el: HTMLAudioElement) => el.paused), { timeout: 15_000 })
			.toBe(true);
		const srcAtPause = await audio.evaluate((el: HTMLAudioElement) => el.src);
		await panel(page).getByRole('button', { name: 'Play', exact: true }).click();
		await expect
			.poll(async () => audio.evaluate((el: HTMLAudioElement) => el.paused), { timeout: 30_000, message: 'resume did not restart playback' })
			.toBe(false);
		expect(await audio.evaluate((el: HTMLAudioElement) => el.src)).toBe(srcAtPause);

		// The panel's own next control steps the queue: it must resolve a
		// different video and keep playing.
		const firstSrc = await audio.evaluate((el: HTMLAudioElement) => el.src);
		await panel(page).getByRole('button', { name: 'Next track' }).click();
		await expect(panel(page).getByText(/^2 \/ \d+$/)).toBeVisible({ timeout: 45_000 });
		await expect
			.poll(async () => audio.evaluate((el: HTMLAudioElement) => el.src), {
				timeout: 45_000,
				message: 'queue did not advance to another video',
			})
			.not.toBe(firstSrc);
		await expect
			.poll(async () => audio.evaluate((el: HTMLAudioElement) => el.paused), { timeout: 30_000, message: 'next track never played' })
			.toBe(false);

		// Closing the panel must NOT stop playback: the audio element is mounted
		// outside the panel's `{#if open}` block precisely so this holds.
		await page.getByRole('button', { name: 'Close YouTube' }).click();
		await expect(page.getByRole('button', { name: 'Close YouTube' })).toHaveCount(0);
		await page.waitForTimeout(500);
		expect(await audio.evaluate((el: HTMLAudioElement) => el.paused)).toBe(false);

		// The engine must have received the now-playing item, so the MiniPlayer
		// advertises the YouTube track and offers a seek bar (canSeek).
		// Its Next button also only renders when the panel registered skip
		// handlers (canSkipNext), so finding it proves the engine wiring.
		const mini = page.locator('[aria-label^="Mini player"]');
		await expect(mini).toBeVisible();
		await expect(mini).toHaveAttribute('aria-label', /^Mini player — .+/);
		// The MiniPlayer's seek control is gated on canSeek, which now includes the
		// youtube source — so its presence proves the engine treats YouTube as
		// seekable. It is a role="slider" div, not an <input> (that lives in
		// PlayerControls, which only renders in the full player view).
		await expect(mini.getByRole('slider', { name: 'Seek' })).toBeVisible();

		// Next from the MiniPlayer must step the same queue.
		const secondSrc = await audio.evaluate((el: HTMLAudioElement) => el.src);
		await mini.getByRole('button', { name: 'Next' }).click();
		await expect
			.poll(async () => audio.evaluate((el: HTMLAudioElement) => el.src), {
				timeout: 45_000,
				message: 'MiniPlayer next did not advance the YouTube queue',
			})
			.not.toBe(secondSrc);
	});

	test('favourites persist across closing the panel and a full reload', async ({ page }) => {
		await openPanel(page);
		await search(page, 'top hits 2024');

		const addStar = page.locator('button[aria-label^="Add "]').first();
		const starLabel = (await addStar.getAttribute('aria-label')) ?? '';
		const title = starLabel.replace(/^Add /, '').replace(/ to favorites$/, '');

		await addStar.click();
		await expect(page.locator('button[aria-label^="Remove "]').first()).toBeVisible();

		// Close and reopen the panel.
		await page.getByRole('button', { name: 'Close YouTube' }).click();
		await expect(page.getByRole('button', { name: 'Close YouTube' })).toHaveCount(0);
		await page.getByRole('button', { name: /Play from YouTube/ }).click();
		await page.getByRole('button', { name: /^Favorites/ }).click();
		await expect(page.getByText(/No favorite YouTube tracks yet/)).toHaveCount(0);

		expect(title.length).toBeGreaterThan(0);
		await expect(page.getByText(title, { exact: false }).first()).toBeVisible();

		// And it survives a reload, because it lives in a persisted store.
		await page.reload();
		await waitForHydration(page);
		await page.getByRole('button', { name: /Play from YouTube/ }).click();
		await page.getByRole('button', { name: /^Favorites/ }).click();
		await expect(page.getByText(title, { exact: false }).first()).toBeVisible();
	});
});
