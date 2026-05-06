import https from 'node:https';
import { json, type RequestHandler } from '@sveltejs/kit';

export const prerender = false;

const RADIO_SERVERS = [
	'https://all.api.radio-browser.info',
	'https://de2.api.radio-browser.info',
];
const DEFAULT_CACHE_CONTROL = 'public, max-age=300';

function radioApiBases(): string[] {
	const startIndex = Math.floor(Math.random() * RADIO_SERVERS.length);
	return RADIO_SERVERS.map((_, index) => `${RADIO_SERVERS[(startIndex + index) % RADIO_SERVERS.length]}/json`);
}

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

function radioJson(body: unknown, init: ResponseInit = {}, cacheControl = DEFAULT_CACHE_CONTROL) {
	return json(body, {
		...init,
		headers: buildHeaders(init.headers, cacheControl),
	});
}

function radioError(status: number, message: string, cacheControl = DEFAULT_CACHE_CONTROL) {
	return radioJson({ error: message }, { status }, cacheControl);
}

function readUpstreamJson(requestUrl: string): Promise<unknown> {
	return new Promise((resolve, reject) => {
		https
			.get(requestUrl, { headers: { accept: 'application/json' } }, (response) => {
				const status = response.statusCode ?? 0;
				let body = '';

				response.setEncoding('utf8');
				response.on('data', (chunk) => {
					body += chunk;
				});
				response.on('end', () => {
					if (status < 200 || status >= 300) {
						reject(new Error(`Radio search failed: HTTP ${status}`));
						return;
					}

					try {
						resolve(JSON.parse(body));
					} catch {
						reject(new Error('Radio search failed: Invalid JSON response'));
					}
				});
			})
			.on('error', (error) => {
				reject(error);
			});
	});
}

export const OPTIONS: RequestHandler = async () => new Response(null, { headers: buildHeaders() });

export const GET: RequestHandler = async ({ url }) => {
	const query = url.searchParams.get('q')?.trim() ?? '';
	if (query.length < 2) {
		return radioJson([]);
	}

	const params = new URLSearchParams({
		name: query,
		limit: '100',
		order: 'votes',
		reverse: 'true',
		hidebroken: 'true',
	});

	let lastError: unknown = null;

	for (const apiBase of radioApiBases()) {
		try {
			const payload = await readUpstreamJson(`${apiBase}/stations/search?${params}`);
			return radioJson(payload);
		} catch (error) {
			lastError = error;
		}
	}

	const message = lastError instanceof Error ? lastError.message : 'Radio search failed.';
	return radioError(502, message);
};