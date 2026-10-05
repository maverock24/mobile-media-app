/**
 * iTunes search + release-URL resolution — pure helpers lifted out of
 * `src/lib/components/views/PodcastView.svelte`.
 *
 * Every function here is pure: the view constants the originals closed over
 * (`podcastApiBaseUrl`, `useHostedPodcastProxy`) arrive as parameters, and
 * `searchITunes` returns its results instead of writing the view's
 * `searchResults` state. No runes, no stores, no component imports.
 */
import { readPodcastJson } from '$lib/podcast/rss';

/** One iTunes podcast search hit. */
export interface ItunesResult {
	trackId:          number;
	trackName:        string;
	artistName:       string;
	artworkUrl600:    string;
	feedUrl:          string;
	primaryGenreName: string;
	trackCount:       number;
}

/** The view's release/proxy resolution settings. */
export interface ItunesConfig {
	/** Release base URL; empty when nothing is configured and not on native. */
	baseUrl: string;
	/** True when requests should route through the hosted proxy. */
	useHostedProxy: boolean;
}

/** Resolve a relative proxy path against the release base URL. Absolute
 *  `http(s)` URLs and the no-base case pass through unchanged. */
export function resolvePodcastApiUrl(path: string, baseUrl: string): string {
	if (/^https?:\/\//i.test(path)) {
		return path;
	}

	if (!baseUrl) {
		return path;
	}

	return `${baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
}

/** Search iTunes for podcasts. Returns `[]` for a too-short query, a non-ok
 *  response or a malformed body; the caller owns the loading state. */
export async function searchITunes(q: string, config: ItunesConfig): Promise<ItunesResult[]> {
	if (q.length < 2) return [];

	const requestUrl = config.useHostedProxy
		? resolvePodcastApiUrl(`/api/podcast/search?q=${encodeURIComponent(q)}`, config.baseUrl)
		: `https://itunes.apple.com/search?term=${encodeURIComponent(q)}&media=podcast&entity=podcast&limit=20`;

	try {
		const data = await readPodcastJson<{ results?: ItunesResult[] }>(requestUrl);
		return (data.results ?? []) as ItunesResult[];
	} catch {
		return [];
	}
}
