import type { RequestHandler } from '@sveltejs/kit';
import { OPTIONS, parseRequiredHttpUrl, podcastError, podcastJson, readUpstreamJson } from '../_shared';

export const prerender = false;
export { OPTIONS };

export const GET: RequestHandler = async ({ url, fetch }) => {
	const feedUrl = parseRequiredHttpUrl(url.searchParams.get('url'));
	if (!feedUrl) {
		return podcastError(400, 'A valid feed URL is required.');
	}

	try {
		const payload = await readUpstreamJson(
			fetch,
			`https://api.rss2json.com/v1/api.json?rss_url=${encodeURIComponent(feedUrl.toString())}`,
			'Podcast feed fetch failed'
		);
		return podcastJson(payload, {}, 'public, max-age=600');
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Podcast feed fetch failed.';
		return podcastError(502, message);
	}
};