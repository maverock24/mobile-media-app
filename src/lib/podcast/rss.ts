/**
 * Podcast RSS helpers — pure parsing + feed fetching, extracted from PodcastView.
 *
 * View/store-coupled logic (episode-history merge against the persisted
 * podcastData store, and the release-URL resolver) stays in the view; this
 * module owns only the reusable RSS/HTTP plumbing.
 */

// ── RSS feed cache (in-memory, 30-min TTL) ─────────────────────
export const RSS_CACHE_TTL = 30 * 60 * 1000;
export const PODCAST_REQUEST_TIMEOUT_MS = 20_000;

const rssCache = new Map<string, { data: Record<string, unknown>; ts: number }>();

/** Resolves a relative proxy path (e.g. `/api/podcast/feed?...`) to a full URL,
 *  or returns it unchanged if already absolute. Injected so the view keeps
 *  ownership of the release/native-base-url resolution. */
export type ResolveUrl = (path: string) => string;

export interface RssFetchConfig {
	/** Resolve relative proxy paths to absolute URLs. */
	resolveUrl: ResolveUrl;
	/** True when running on native / a configured release base (route via hosted proxy). */
	useHostedProxy: boolean;
}

/** Fetch JSON with a 20s abort timeout and parent-signal forwarding. */
export async function readPodcastJson<T>(requestUrl: string, signal?: AbortSignal): Promise<T> {
	const controller = new AbortController();
	let timedOut = false;
	const timeoutId = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, PODCAST_REQUEST_TIMEOUT_MS);
	const abortFromParent = () => controller.abort();
	if (signal?.aborted) controller.abort();
	signal?.addEventListener('abort', abortFromParent, { once: true });

	let response: Response;
	try {
		response = await fetch(requestUrl, { signal: controller.signal });
	} catch (error) {
		if (timedOut) {
			throw new Error('Podcast request timed out. Check your connection and try again.');
		}
		throw error;
	} finally {
		clearTimeout(timeoutId);
		signal?.removeEventListener('abort', abortFromParent);
	}
	if (!response.ok) {
		let message = `Podcast request failed: HTTP ${response.status}`;
		try {
			const payload = await response.json() as Record<string, unknown>;
			if (typeof payload.error === 'string') {
				message = payload.error;
			} else if (typeof payload.message === 'string') {
				message = payload.message;
			}
		} catch {
			// Fall back to the status-derived message when the response has no JSON body.
		}
		throw new Error(message);
	}

	return await response.json() as T;
}

export function getStringField(item: Record<string, unknown>, key: string): string {
	const value = item[key];
	return typeof value === 'string' ? value.trim() : '';
}

export function getEpisodeIdentitySource(item: Record<string, unknown>, enclosure: { link?: string } | null): string {
	const guid = item.guid;
	if (typeof guid === 'string' && guid.trim()) return guid.trim();
	if (guid && typeof guid === 'object') {
		const guidRecord = guid as Record<string, unknown>;
		const guidValue = typeof guidRecord._ === 'string' ? guidRecord._.trim() : '';
		if (guidValue) return guidValue;
	}

	return enclosure?.link?.trim()
		|| getStringField(item, 'link')
		|| `${getStringField(item, 'title')}|${getStringField(item, 'pubDate')}`;
}

/** Minimal structural shape buildEpisodeId needs (avoids coupling to the view-local Podcast type). */
interface PodcastRef {
	itunesId: number;
}

export function buildEpisodeId(podcast: PodcastRef, item: Record<string, unknown>, index: number, enclosure: { link?: string } | null): string {
	const source = getEpisodeIdentitySource(item, enclosure) || `episode-${index}`;
	return `${podcast.itunesId}:${source}`;
}

/** Fetch (and 30-min cache) a podcast RSS feed via the `/api/podcast/feed` proxy. */
export async function fetchRss(
	feedUrl: string,
	config: RssFetchConfig,
	signal?: AbortSignal,
	page?: number,
): Promise<Record<string, unknown>> {
	// Validate that the feed URL is a legitimate HTTP(S) address
	try {
		const parsed = new URL(feedUrl);
		if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
			throw new Error('Feed URL must use HTTP or HTTPS.');
		}
	} catch {
		throw new Error('Invalid feed URL.');
	}
	const cacheKey = page ? `${feedUrl}::page${page}` : feedUrl;
	const cached = rssCache.get(cacheKey);
	if (cached && Date.now() - cached.ts < RSS_CACHE_TTL) return cached.data;
	let query = `url=${encodeURIComponent(feedUrl)}`;
	if (page) query += `&page=${page}&perPage=50`;
	const requestUrl = config.useHostedProxy
		? config.resolveUrl(`/api/podcast/feed?${query}`)
		: `/api/podcast/feed?${query}`;
	const data = await readPodcastJson<Record<string, unknown>>(requestUrl, signal);
	if (data.status === 'ok') rssCache.set(cacheKey, { data, ts: Date.now() });
	return data;
}

export function describePodcastRequestError(error: unknown, fallback: string): string {
	if (error instanceof Error) {
		if (/failed to fetch|fetch failed/i.test(error.message)) {
			return fallback;
		}
		return error.message;
	}
	return fallback;
}

/** Drop all cached pages for a feed (used when force-refreshing a podcast). */
export function clearRssCache(feedUrl: string): void {
	for (const key of rssCache.keys()) {
		if (key.startsWith(feedUrl)) rssCache.delete(key);
	}
}

/** Parse an RSS/iTunes duration (`HH:MM:SS`, `MM:SS`, or seconds) into seconds. */
export function parseDuration(dur: string | number): number {
	if (typeof dur === 'number') return dur;
	if (!dur) return 0;
	const parts = String(dur).split(':').map(Number);
	if (parts.some(isNaN)) return 0;
	if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
	if (parts.length === 2) return parts[0] * 60 + parts[1];
	return parts[0] || 0;
}

/** Format an ISO date string as e.g. "Jan 5, 2026"; empty string if unparseable. */
export function formatDate(dateStr: string): string {
	if (!dateStr) return '';
	const d = new Date(dateStr);
	if (isNaN(d.getTime())) return '';
	return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}
