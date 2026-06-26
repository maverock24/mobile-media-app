import type { RequestHandler } from '@sveltejs/kit';
import { OPTIONS, parseRequiredHttpUrl, podcastError, podcastJson } from '../_shared';
import { XMLParser } from 'fast-xml-parser';

export const prerender = false;
export { OPTIONS };

/**
 * Parses an RSS/Atom feed directly (not via rss2json.com) so ALL episodes
 * are returned — follows pagination links to fetch every episode.
 *
 * Supports lazy loading via ?page=N&perPage=M params.
 *
 * Response shape matches rss2json.com for backwards compatibility:
 *   { status: "ok", feed: { title, image, ... }, items: [...], hasMore?: boolean, total?: number }
 */

const MAX_PAGES = 10;

interface RssItem {
	[key: string]: unknown;
	title?: string;
	description?: string;
	'content:encoded'?: string;
	content?: string;
	guid?: string | { '#text': string };
	link?: string;
	pubDate?: string;
	enclosure?: { '@_url'?: string; '@_length'?: string; '@_type'?: string };
	'itunes:duration'?: string;
	'itunes:summary'?: string;
	'itunes:image'?: { '@_href'?: string };
	duration?: string;
}

interface RssChannel {
	title?: string;
	description?: string;
	image?: { url?: string; link?: string; title?: string };
	'itunes:image'?: { '@_href'?: string };
	'atom:link'?: Array<{ '@_rel'?: string; '@_href'?: string }> | { '@_rel'?: string; '@_href'?: string };
	item?: RssItem[] | RssItem;
}

interface RssFeed {
	rss?: { channel?: RssChannel };
	feed?: Record<string, unknown> & { title?: string; entry?: RssItem[] | RssItem };
}

function createParser(): XMLParser {
	return new XMLParser({
		ignoreAttributes: false,
		attributeNamePrefix: '@_',
		textNodeName: '#text',
		isArray: (name) => name === 'item' || name === 'entry' || name === 'atom:link' || name === 'link',
	});
}

function getRssNextPageUrl(channel: RssChannel | undefined): string | null {
	if (!channel) return null;
	const links = channel['atom:link'];
	if (!links) return null;
	const linkArray = Array.isArray(links) ? links : [links];
	const nextLink = linkArray.find(l => l['@_rel'] === 'next');
	return nextLink?.['@_href'] ?? null;
}

function getAtomNextPageUrl(feed: Record<string, unknown> | undefined): string | null {
	if (!feed) return null;
	const links = feed['link'];
	if (!links) return null;
	const linkArray = Array.isArray(links) ? links : [links];
	const nextLink = linkArray.find(
		(l: Record<string, unknown>) => l['@_rel'] === 'next'
	) as Record<string, unknown> | undefined;
	return typeof nextLink?.['@_href'] === 'string' ? nextLink['@_href'] : null;
}

function getText(val: unknown): string {
	if (typeof val === 'string') return val;
	if (val && typeof val === 'object' && '#text' in (val as Record<string, unknown>)) {
		return String((val as Record<string, unknown>)['#text']);
	}
	return '';
}

function normalizeRssItem(raw: Record<string, unknown>): Record<string, unknown> {
	const enclosure = raw.enclosure as Record<string, string> | undefined;
	const itunesImage = raw['itunes:image'] as Record<string, string> | undefined;

	return {
		title: getText(raw.title),
		pubDate: getText(raw.pubDate),
		link: getText(raw.link),
		guid: getText(raw.guid),
		description: getText(raw.description),
		content: getText(raw['content:encoded']) || getText(raw.content),
		itunes_duration: getText(raw['itunes:duration']),
		itunes_summary: getText(raw['itunes:summary']),
		itunes_image: itunesImage?.['@_href'] ?? null,
		enclosure: enclosure?.['@_url']
			? {
					link: enclosure['@_url'],
					length: enclosure['@_length'] ?? null,
					type: enclosure['@_type'] ?? 'audio/mpeg',
				}
			: null,
	};
}

function normalizeAtomEntry(entry: Record<string, unknown>): Record<string, unknown> {
	const links = Array.isArray(entry.link) ? entry.link : entry.link ? [entry.link] : [];
	const enclosureLink = links.find(
		(l: Record<string, unknown>) => typeof l?.rel === 'string' && l.rel === 'enclosure'
	) as Record<string, unknown> | undefined;

	return {
		title: getText(entry.title),
		pubDate: getText(entry.published) || getText(entry.updated),
		link: getText(entry.link),
		guid: getText(entry.id) || getText(entry.guid),
		description: getText(entry.summary) || getText(entry.description),
		content: getText(entry.content),
		enclosure: enclosureLink
			? { link: getText(enclosureLink.href), type: getText(enclosureLink.type) || 'audio/mpeg' }
			: null,
	};
}

async function fetchRssPage(
	fetchFn: typeof fetch,
	url: string,
	parser: XMLParser
): Promise<{ items: RssItem[]; channel: RssChannel | undefined; nextUrl: string | null }> {
	const res = await fetchFn(url, {
		headers: { accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml' },
	});

	if (!res.ok) {
		throw new Error(`Podcast feed fetch failed: HTTP ${res.status}`);
	}

	const xml = await res.text();
	const parsed = parser.parse(xml) as RssFeed;
	const channel = parsed.rss?.channel;
	const items = (channel?.item ?? []) as RssItem[];
	const nextUrl = getRssNextPageUrl(channel);

	return { items, channel, nextUrl };
}

async function fetchAtomPage(
	fetchFn: typeof fetch,
	url: string,
	parser: XMLParser
): Promise<{ items: RssItem[]; feed: Record<string, unknown> | undefined; nextUrl: string | null }> {
	const res = await fetchFn(url, {
		headers: { accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml' },
	});

	if (!res.ok) {
		throw new Error(`Podcast feed fetch failed: HTTP ${res.status}`);
	}

	const xml = await res.text();
	const parsed = parser.parse(xml) as RssFeed;
	const feed = parsed.feed;
	const entries = feed?.entry;
	const rawEntries = Array.isArray(entries) ? entries : entries ? [entries] : [];
	const items = rawEntries as RssItem[];
	const nextUrl = getAtomNextPageUrl(feed);

	return { items, feed, nextUrl };
}

export const GET: RequestHandler = async ({ url, fetch }) => {
	const feedUrl = parseRequiredHttpUrl(url.searchParams.get('url'));
	if (!feedUrl) {
		return podcastError(400, 'A valid feed URL is required.');
	}

	const requestedPage = parseInt(url.searchParams.get('page') || '', 10) || 0;
	const perPage = Math.min(parseInt(url.searchParams.get('perPage') || '', 10) || 50, 200);
	const maxPages = Math.min(
		parseInt(url.searchParams.get('maxPages') || '', 10) || MAX_PAGES,
		MAX_PAGES
	);

	try {
		const parser = createParser();

		// Fetch first page to determine feed type
		const firstRes = await fetch(feedUrl.toString(), {
			headers: { accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml' },
		});

		if (!firstRes.ok) {
			return podcastError(502, `Podcast feed fetch failed: HTTP ${firstRes.status}`);
		}

		const firstXml = await firstRes.text();
		const firstParsed = parser.parse(firstXml) as RssFeed;

		// ── Atom feed ──
		if (firstParsed.feed) {
			const { items: firstItems, feed: firstFeed } = await fetchAtomPage(fetch, feedUrl.toString(), parser);
			const allNormalized = firstItems.map(normalizeAtomEntry);

			if (requestedPage > 0) {
				const start = (requestedPage - 1) * perPage;
				return podcastJson({
					status: 'ok',
					feed: { title: getText(firstFeed?.title) || '', description: '', image: '' },
					items: allNormalized.slice(start, start + perPage),
					page: requestedPage,
					hasMore: start + perPage < allNormalized.length,
					total: allNormalized.length,
				}, {}, 'public, max-age=600');
			}

			return podcastJson({
				status: 'ok',
				feed: { title: getText(firstFeed?.title) || '', description: '', image: '' },
				items: allNormalized,
			}, {}, 'public, max-age=600');
		}

		// ── RSS feed ──
		const { items: pageOneItems, channel } = await fetchRssPage(fetch, feedUrl.toString(), parser);

		// First, collect ALL items from all pages
		let allItems = pageOneItems;
		let nextUrl = getRssNextPageUrl(channel);
		let pageCount = 1;

		while (nextUrl && pageCount < maxPages) {
			const page = await fetchRssPage(fetch, nextUrl, parser);
			allItems = allItems.concat(page.items);
			nextUrl = page.nextUrl ? new URL(page.nextUrl, nextUrl).toString() : null;
			pageCount++;
		}

		const normalizedAll = allItems.map(normalizeRssItem);

		// Page-based lazy loading: slice from the complete result
		if (requestedPage > 0) {
			const start = (requestedPage - 1) * perPage;
			return podcastJson(
				{
					status: 'ok',
					feed: {
						title: channel?.title ?? '',
						description: channel?.description ?? '',
						image: channel?.image?.url ?? channel?.['itunes:image']?.['@_href'] ?? '',
					},
					items: normalizedAll.slice(start, start + perPage),
					page: requestedPage,
					hasMore: start + perPage < normalizedAll.length,
					total: normalizedAll.length,
				},
				{},
				'public, max-age=600'
			);
		}

		// Full load: return everything
		return podcastJson(
			{
				status: 'ok',
				feed: {
					title: channel?.title ?? '',
					description: channel?.description ?? '',
					image: channel?.image?.url ?? channel?.['itunes:image']?.['@_href'] ?? '',
				},
				items: normalizedAll,
			},
			{},
			'public, max-age=600'
		);
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Podcast feed fetch failed.';
		return podcastError(502, message);
	}
};
