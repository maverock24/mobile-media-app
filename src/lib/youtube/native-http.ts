import { Capacitor, CapacitorHttp, type HttpHeaders } from '@capacitor/core';

/**
 * Fetch implementation for YouTube InnerTube calls.
 *
 * InnerTube (`youtube.com/youtubei/*`) sends no CORS headers, so a WebView
 * fetch from `https://localhost` is blocked before it ever reaches us — probed
 * and confirmed: `POST /youtubei/v1/player` returns 403 with no
 * `access-control-allow-origin`. Everything therefore has to go out through the
 * native HTTP stack.
 *
 * This adapter is passed to `Innertube.create({ fetch })` rather than enabling
 * the global `CapacitorHttp` patch in capacitor.config.ts, so the Drive,
 * podcast and radio fetch paths keep using the plain WebView fetch. Enabling
 * the global patch would repatch `window.fetch` app-wide.
 *
 * youtubei.js calls fetch with three input shapes, all of which are handled
 * here: a `URL`, a plain `string`, and a `Request`.
 */

const CONNECT_TIMEOUT_MS = 15_000;
const READ_TIMEOUT_MS = 20_000;

function isRequest(input: unknown): input is Request {
	return typeof Request !== 'undefined' && input instanceof Request;
}

/** Normalize the three input shapes into url + method + headers + body. */
async function normalize(
	input: RequestInfo | URL,
	init?: RequestInit
): Promise<{ url: string; method: string; headers: Headers; body: BodyInit | null | undefined }> {
	if (isRequest(input)) {
		const headers = new Headers(input.headers);
		if (init?.headers) {
			for (const [key, value] of new Headers(init.headers)) headers.set(key, value);
		}
		// A Request body can only be read once, and youtubei.js hands us a
		// freshly built Request, so reading it here is safe.
		const body = init?.body ?? (input.body ? await input.text() : undefined);
		return { url: input.url, method: init?.method ?? input.method ?? 'GET', headers, body };
	}

	const headers = new Headers(init?.headers);
	return {
		url: typeof input === 'string' ? input : input.href,
		method: init?.method ?? 'GET',
		headers,
		body: init?.body,
	};
}

/** CapacitorHttp wants a plain object; it cannot take a `Headers` instance. */
function toPlainHeaders(headers: Headers): HttpHeaders {
	const plain: HttpHeaders = {};
	headers.forEach((value, key) => {
		plain[key] = value;
	});
	return plain;
}

/** Body must reach the native layer as a string. InnerTube only ever sends JSON. */
async function toRequestBody(body: BodyInit | null | undefined): Promise<string | undefined> {
	if (body == null) return undefined;
	if (typeof body === 'string') return body;
	if (body instanceof URLSearchParams) return body.toString();
	if (typeof Blob !== 'undefined' && body instanceof Blob) return body.text();
	if (typeof ArrayBuffer !== 'undefined' && body instanceof ArrayBuffer) {
		return new TextDecoder().decode(body);
	}
	// Uint8Array and friends.
	if (ArrayBuffer.isView(body)) {
		return new TextDecoder().decode(body as unknown as AllowSharedBufferSource);
	}
	return String(body);
}

/**
 * CapacitorHttp does not honour the requested `responseType` when the reply is
 * JSON: it parses the body natively and returns an object. The shipped Web shim
 * documents the same rule — "If the response content-type is json, force the
 * response to be json". Callers still expect a body they can read as text, so
 * re-serialise. Handing the object straight to `new Response()` would stringify
 * it to `[object Object]` and every downstream `res.json()` would fail.
 */
function toResponseBody(data: unknown): string {
	if (typeof data === 'string') return data;
	if (data === null || data === undefined) return '';
	return JSON.stringify(data);
}

/**
 * Build the fetch used by the YouTube client.
 *
 * On native this routes through CapacitorHttp. On the web (dev server, PWA) it
 * falls back to the global fetch and will hit the CORS wall described above —
 * the feature is Android-only by design, matching the rest of the app's
 * dynamic endpoints.
 */
export function createYoutubeFetch(): typeof fetch {
	if (!Capacitor.isNativePlatform()) {
		return globalThis.fetch.bind(globalThis);
	}

	return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		const { url, method, headers, body } = await normalize(input, init);
		const requestBody = await toRequestBody(body);
		const outgoingHeaders = toPlainHeaders(headers);

		// CapacitorHttpUrlConnection.setRequestBody returns early when no
		// Content-Type is present, which silently sends an empty body. InnerTube's
		// /config POST sends a JSON body without one, so add it. Every body this
		// client sends is JSON.
		if (requestBody !== undefined && !headers.has('content-type')) {
			outgoingHeaders['Content-Type'] = 'application/json';
		}

		const response = await CapacitorHttp.request({
			url,
			method,
			headers: outgoingHeaders,
			data: requestBody,
			// Only affects non-JSON replies — see toResponseBody().
			responseType: 'text',
			connectTimeout: CONNECT_TIMEOUT_MS,
			readTimeout: READ_TIMEOUT_MS,
		});

		return new Response(toResponseBody(response.data), {
			status: response.status,
			headers: response.headers ?? {},
		});
	}) as typeof fetch;
}
