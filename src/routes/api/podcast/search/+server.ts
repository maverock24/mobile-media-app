import type { RequestHandler } from '@sveltejs/kit';
import { OPTIONS, podcastError, podcastJson, readUpstreamJson } from '../_shared';

export const prerender = false;
export { OPTIONS };

export const GET: RequestHandler = async ({ url, fetch }) => {
	const query = url.searchParams.get('q')?.trim() ?? '';
	if (query.length < 2) {
		return podcastJson({ resultCount: 0, results: [] });
	}

	try {
		const payload = await readUpstreamJson(
			fetch,
			`https://itunes.apple.com/search?term=${encodeURIComponent(query)}&media=podcast&entity=podcast&limit=20`,
			'iTunes search failed'
		);
		return podcastJson(payload);
	} catch (error) {
		const message = error instanceof Error ? error.message : 'iTunes search failed.';
		return podcastError(502, message);
	}
};