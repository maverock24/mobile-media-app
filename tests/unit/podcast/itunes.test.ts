import { describe, it, expect, vi, afterEach } from 'vitest';
import {
	resolvePodcastApiUrl,
	searchITunes,
	type ItunesConfig,
} from '$lib/podcast/itunes';

// ── helpers ──────────────────────────────────────────────────

const jsonResponse = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Install a fetch stub that resolves to `response` and return the mock. */
function mockFetch(response: Response) {
	const fn = vi.fn().mockResolvedValue(response);
	vi.stubGlobal('fetch', fn);
	return fn;
}

const proxy: ItunesConfig = { baseUrl: 'https://proxy.example', useHostedProxy: true };
const direct: ItunesConfig = { baseUrl: '', useHostedProxy: false };

afterEach(() => vi.unstubAllGlobals());

// ─────────────────────────────────────────────────────────────
// resolvePodcastApiUrl
// ─────────────────────────────────────────────────────────────

describe('resolvePodcastApiUrl', () => {
	it('passes absolute http(s) URLs through unchanged', () => {
		expect(resolvePodcastApiUrl('https://itunes.apple.com/search', 'https://proxy.example'))
			.toBe('https://itunes.apple.com/search');
		expect(resolvePodcastApiUrl('http://example.com/x', 'https://proxy.example'))
			.toBe('http://example.com/x');
	});

	it('returns the path unchanged when no base is configured', () => {
		expect(resolvePodcastApiUrl('/api/podcast/search?q=x', '')).toBe('/api/podcast/search?q=x');
	});

	it('joins a leading-slash path onto the base', () => {
		expect(resolvePodcastApiUrl('/api/podcast/search?q=x', 'https://proxy.example'))
			.toBe('https://proxy.example/api/podcast/search?q=x');
	});

	it('inserts a missing separator for a path without a leading slash', () => {
		expect(resolvePodcastApiUrl('api/podcast/search?q=x', 'https://proxy.example'))
			.toBe('https://proxy.example/api/podcast/search?q=x');
	});
});

// ─────────────────────────────────────────────────────────────
// searchITunes
// ─────────────────────────────────────────────────────────────

describe('searchITunes', () => {
	it('hits iTunes directly when the proxy is disabled, with the limit and query', async () => {
		const fetchMock = mockFetch(jsonResponse({ results: [] }));

		await searchITunes('science', direct);

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(fetchMock.mock.calls[0][0]).toBe(
			'https://itunes.apple.com/search?term=science&media=podcast&entity=podcast&limit=20'
		);
	});

	it('routes through the hosted proxy when enabled', async () => {
		const fetchMock = mockFetch(jsonResponse({ results: [] }));

		await searchITunes('science', proxy);

		expect(fetchMock.mock.calls[0][0]).toBe('https://proxy.example/api/podcast/search?q=science');
	});

	it('URL-encodes the query in both modes', async () => {
		const directFetch = mockFetch(jsonResponse({ results: [] }));
		await searchITunes('tech & science', direct);
		expect(directFetch.mock.calls[0][0]).toBe(
			'https://itunes.apple.com/search?term=tech%20%26%20science&media=podcast&entity=podcast&limit=20'
		);

		vi.unstubAllGlobals();
		const proxyFetch = mockFetch(jsonResponse({ results: [] }));
		await searchITunes('tech & science', proxy);
		expect(proxyFetch.mock.calls[0][0]).toBe('https://proxy.example/api/podcast/search?q=tech%20%26%20science');
	});

	it('returns the parsed result list', async () => {
		const results = [{ trackId: 1, trackName: 'A', feedUrl: 'https://x/feed' }];
		mockFetch(jsonResponse({ results }));

		await expect(searchITunes('science', direct)).resolves.toEqual(results);
	});

	it('returns an empty list for an empty result field', async () => {
		mockFetch(jsonResponse({}));
		await expect(searchITunes('science', direct)).resolves.toEqual([]);
	});

	it('returns an empty list for a short query without fetching', async () => {
		const fetchMock = mockFetch(jsonResponse({ results: [{ trackId: 1 }] }));

		await expect(searchITunes('a', direct)).resolves.toEqual([]);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('returns an empty list on a non-ok response', async () => {
		mockFetch(jsonResponse({ error: 'boom' }, 500));
		await expect(searchITunes('science', direct)).resolves.toEqual([]);
	});

	it('returns an empty list on a malformed body', async () => {
		mockFetch(new Response('<<not json>>', { status: 200 }));
		await expect(searchITunes('science', direct)).resolves.toEqual([]);
	});
});
