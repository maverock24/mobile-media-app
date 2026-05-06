import type { RequestHandler } from '@sveltejs/kit';
import { OPTIONS, podcastError, podcastJson, readUpstreamJson } from '../_shared';

export const prerender = false;
export { OPTIONS };

export const GET: RequestHandler = async ({ url, fetch }) => {
	const podcastId = url.searchParams.get('id')?.trim() ?? '';
	if (!/^\d+$/.test(podcastId)) {
		return podcastError(400, 'A valid podcast id is required.');
	}

	try {
		const payload = await readUpstreamJson(
			fetch,
			`https://itunes.apple.com/lookup?id=${encodeURIComponent(podcastId)}`,
			'iTunes lookup failed'
		);
		return podcastJson(payload, {}, 'public, max-age=3600');
	} catch (error) {
		const message = error instanceof Error ? error.message : 'iTunes lookup failed.';
		return podcastError(502, message);
	}
};