import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─────────────────────────────────────────────────────────────
// CapacitorHttp adapter contract.
//
// This adapter is the only part of the YouTube feature that cannot be exercised
// in a browser, so its behaviour is pinned here against the native plugin's real
// semantics, read from the Capacitor Android sources:
//
//  - CapacitorHttpUrlConnection.setRequestBody() returns early when the request
//    has no Content-Type, so the body is silently dropped.
//  - HttpRequestHandler.readData() parses JSON replies and ignores the requested
//    responseType, so `data` arrives as an object, not a string.
//
// Both are silent failures that would only ever show up on a device.
// ─────────────────────────────────────────────────────────────

const isNativePlatform = vi.fn(() => true);
const request = vi.fn();

vi.mock('@capacitor/core', () => ({
	Capacitor: { isNativePlatform: () => isNativePlatform() },
	CapacitorHttp: { request: (...args: unknown[]) => request(...args) },
}));

const { createYoutubeFetch } = await import('$lib/youtube/native-http');

/** Default native reply: a JSON body, which the plugin pre-parses into an object. */
function nativeReply(overrides: Record<string, unknown> = {}) {
	return { status: 200, headers: { 'content-type': 'application/json' }, data: { ok: true }, ...overrides };
}

beforeEach(() => {
	isNativePlatform.mockReturnValue(true);
	request.mockReset();
	request.mockResolvedValue(nativeReply());
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('native request translation', () => {
	it('sends a string input as a GET by default', async () => {
		await createYoutubeFetch()('https://www.youtube.com/youtubei/v1/config');
		expect(request).toHaveBeenCalledTimes(1);
		expect(request.mock.calls[0][0]).toMatchObject({
			url: 'https://www.youtube.com/youtubei/v1/config',
			method: 'GET',
		});
	});

	it('accepts a URL instance', async () => {
		await createYoutubeFetch()(new URL('https://www.youtube.com/youtubei/v1/search'));
		expect(request.mock.calls[0][0]).toMatchObject({
			url: 'https://www.youtube.com/youtubei/v1/search',
			method: 'GET',
		});
	});

	it('accepts a Request and copies its url, method, headers and body', async () => {
		const req = new Request('https://www.youtube.com/youtubei/v1/player', {
			method: 'POST',
			headers: { 'content-type': 'application/json', 'x-youtube-client-name': '28' },
			body: JSON.stringify({ videoId: 'dQw4w9WgXcQ' }),
		});
		await createYoutubeFetch()(req);

		const options = request.mock.calls[0][0];
		expect(options.url).toBe('https://www.youtube.com/youtubei/v1/player');
		expect(options.method).toBe('POST');
		expect(options.headers['content-type']).toBe('application/json');
		expect(options.headers['x-youtube-client-name']).toBe('28');
		expect(options.data).toBe(JSON.stringify({ videoId: 'dQw4w9WgXcQ' }));
	});

	it('lets init override the Request method and headers', async () => {
		const req = new Request('https://www.youtube.com/x', { method: 'POST', body: 'a' });
		await createYoutubeFetch()(req, { method: 'PUT', headers: { 'x-custom': 'yes' } });

		const options = request.mock.calls[0][0];
		expect(options.method).toBe('PUT');
		expect(options.headers['x-custom']).toBe('yes');
	});

	it('forwards request headers to the native layer', async () => {
		await createYoutubeFetch()('https://www.youtube.com/x', {
			headers: { 'user-agent': 'com.google.android.apps.youtube.vr.oculus/1.65.10' },
		});
		expect(request.mock.calls[0][0].headers['user-agent']).toBe(
			'com.google.android.apps.youtube.vr.oculus/1.65.10'
		);
	});

	it('applies connect and read timeouts', async () => {
		await createYoutubeFetch()('https://www.youtube.com/x');
		const options = request.mock.calls[0][0];
		expect(options.connectTimeout).toBeGreaterThan(0);
		expect(options.readTimeout).toBeGreaterThan(0);
	});

	it('sends no body for a GET', async () => {
		await createYoutubeFetch()('https://www.youtube.com/x');
		expect(request.mock.calls[0][0].data).toBeUndefined();
		expect(request.mock.calls[0][0].headers['Content-Type']).toBeUndefined();
	});
});

describe('Content-Type is added when a body is sent without one', () => {
	// Innertube's /config POST sends a JSON body and no Content-Type. Without
	// this, setRequestBody() drops the body and the request goes out empty.
	it('adds application/json for a body with no content-type', async () => {
		await createYoutubeFetch()('https://www.youtube.com/youtubei/v1/config', {
			method: 'POST',
			body: JSON.stringify({ context: { client: { clientName: 'WEB' } } }),
		});

		const options = request.mock.calls[0][0];
		expect(options.headers['Content-Type']).toBe('application/json');
		expect(options.data).toBe(JSON.stringify({ context: { client: { clientName: 'WEB' } } }));
	});

	it('does not override an existing content-type', async () => {
		await createYoutubeFetch()('https://www.youtube.com/x', {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
			body: 'a=1',
		});
		expect(request.mock.calls[0][0].headers['Content-Type']).toBeUndefined();
		expect(request.mock.calls[0][0].headers['content-type']).toBe('application/x-www-form-urlencoded');
	});

	it('is case-insensitive about an existing Content-Type', async () => {
		await createYoutubeFetch()('https://www.youtube.com/x', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: '{}',
		});
		const options = request.mock.calls[0][0];
		// Exactly one content-type key, and it is the caller's value.
		const keys = Object.keys(options.headers).filter((k) => k.toLowerCase() === 'content-type');
		expect(keys).toHaveLength(1);
		expect(options.headers[keys[0]]).toBe('application/json');
	});
});

describe('JSON replies are re-serialised', () => {
	// readData() ignores responseType and parses JSON, so `data` is an object.
	it('re-serialises an object reply so res.json() still works', async () => {
		request.mockResolvedValue(
			nativeReply({ data: { videoId: 'dQw4w9WgXcQ', streamingData: { formats: [1, 2] } } })
		);

		const res = await createYoutubeFetch()('https://www.youtube.com/youtubei/v1/player');
		const body = await res.json();
		expect(body).toEqual({ videoId: 'dQw4w9WgXcQ', streamingData: { formats: [1, 2] } });
	});

	it('does not produce "[object Object]" for an object reply', async () => {
		request.mockResolvedValue(nativeReply({ data: { a: 1 } }));
		const res = await createYoutubeFetch()('https://www.youtube.com/x');
		expect(await res.text()).toBe('{"a":1}');
	});

	it('passes a string reply through untouched', async () => {
		request.mockResolvedValue(
			nativeReply({ headers: { 'content-type': 'text/html' }, data: '<html>nope</html>' })
		);
		const res = await createYoutubeFetch()('https://www.youtube.com/x');
		expect(await res.text()).toBe('<html>nope</html>');
	});

	it('handles a null reply', async () => {
		request.mockResolvedValue(nativeReply({ data: null }));
		const res = await createYoutubeFetch()('https://www.youtube.com/x');
		expect(await res.text()).toBe('');
	});

	it('handles a JSON null reply', async () => {
		request.mockResolvedValue(nativeReply({ data: 'null' }));
		const res = await createYoutubeFetch()('https://www.youtube.com/x');
		expect(await res.json()).toBeNull();
	});

	it('preserves nested structures used by the player response', async () => {
		const playerResponse = {
			playabilityStatus: { status: 'OK' },
			streamingData: {
				adaptiveFormats: [
					{ itag: 140, mimeType: 'audio/mp4; codecs="mp4a.40.2"', url: 'https://rr5---sn-x.googlevideo.com/videoplayback?x=1&y=2' },
				],
			},
		};
		request.mockResolvedValue(nativeReply({ data: playerResponse }));
		const res = await createYoutubeFetch()('https://www.youtube.com/youtubei/v1/player');
		expect(await res.json()).toEqual(playerResponse);
	});
});

describe('response status and headers reach the caller', () => {
	it('forwards the status code', async () => {
		request.mockResolvedValue(nativeReply({ status: 403, data: { error: 'nope' } }));
		const res = await createYoutubeFetch()('https://www.youtube.com/x');
		expect(res.status).toBe(403);
	});

	it('forwards headers so callers can read content-type', async () => {
		request.mockResolvedValue(nativeReply({ headers: { 'content-type': 'application/json; charset=utf-8' } }));
		const res = await createYoutubeFetch()('https://www.youtube.com/x');
		expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8');
	});

	it('survives a missing headers object', async () => {
		request.mockResolvedValue({ status: 200, data: 'ok' });
		const res = await createYoutubeFetch()('https://www.youtube.com/x');
		expect(res.status).toBe(200);
		expect(await res.text()).toBe('ok');
	});
});

describe('web fallback', () => {
	it('uses the global fetch when not on a native platform', async () => {
		isNativePlatform.mockReturnValue(false);
		const globalFetch = vi.fn().mockResolvedValue(new Response('hi', { status: 200 }));
		vi.stubGlobal('fetch', globalFetch);

		const res = await createYoutubeFetch()('https://www.youtube.com/x');
		expect(globalFetch).toHaveBeenCalledTimes(1);
		expect(request).not.toHaveBeenCalled();
		expect(await res.text()).toBe('hi');
	});
});
