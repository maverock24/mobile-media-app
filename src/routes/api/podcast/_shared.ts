import { json, type RequestHandler } from '@sveltejs/kit';

const DEFAULT_CACHE_CONTROL = 'public, max-age=300';

function buildHeaders(headers?: HeadersInit, cacheControl = DEFAULT_CACHE_CONTROL): Headers {
	const merged = new Headers(headers);
	merged.set('Access-Control-Allow-Origin', '*');
	merged.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
	merged.set('Access-Control-Allow-Headers', 'Content-Type');
	if (!merged.has('Cache-Control')) {
		merged.set('Cache-Control', cacheControl);
	}
	return merged;
}

export function podcastJson(body: unknown, init: ResponseInit = {}, cacheControl = DEFAULT_CACHE_CONTROL) {
	return json(body, {
		...init,
		headers: buildHeaders(init.headers, cacheControl),
	});
}

export function podcastError(status: number, message: string, cacheControl = DEFAULT_CACHE_CONTROL) {
	return podcastJson({ error: message }, { status }, cacheControl);
}

export function optionsResponse(cacheControl = DEFAULT_CACHE_CONTROL) {
	return new Response(null, { headers: buildHeaders(undefined, cacheControl) });
}

export function parseRequiredHttpUrl(raw: string | null): URL | null {
	if (!raw) return null;
	try {
		const url = new URL(raw);
		if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
		return url;
	} catch {
		return null;
	}
}

export async function readUpstreamJson(fetcher: typeof fetch, requestUrl: string, fallbackMessage: string) {
	const response = await fetcher(requestUrl, {
		headers: { accept: 'application/json' },
	});

	if (!response.ok) {
		throw new Error(`${fallbackMessage}: HTTP ${response.status}`);
	}

	return await response.json() as Record<string, unknown>;
}

export const OPTIONS: RequestHandler = async () => optionsResponse();