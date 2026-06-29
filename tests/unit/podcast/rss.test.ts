import { describe, it, expect } from 'vitest';
import {
	parseDuration, formatDate, getStringField, getEpisodeIdentitySource,
	buildEpisodeId, describePodcastRequestError,
} from '$lib/podcast/rss';

describe('parseDuration', () => {
	it('passes numbers through', () => {
		expect(parseDuration(7200)).toBe(7200);
		expect(parseDuration(0)).toBe(0);
	});
	it('parses HH:MM:SS', () => {
		expect(parseDuration('1:02:03')).toBe(3723);
	});
	it('parses MM:SS', () => {
		expect(parseDuration('05:30')).toBe(330);
	});
	it('parses bare seconds', () => {
		expect(parseDuration('90')).toBe(90);
	});
	it('returns 0 for garbage', () => {
		expect(parseDuration('')).toBe(0);
		expect(parseDuration('NaN:NaN')).toBe(0);
		expect(parseDuration('abc')).toBe(0);
	});
});

describe('formatDate', () => {
	it('formats a valid ISO date', () => {
		const s = formatDate('2026-01-05T00:00:00Z');
		expect(s).toMatch(/Jan.*5.*2026/);
	});
	it('empty string for empty/invalid', () => {
		expect(formatDate('')).toBe('');
		expect(formatDate('not-a-date')).toBe('');
	});
});

describe('getStringField', () => {
	it('trims strings', () => {
		expect(getStringField({ a: '  hi  ' }, 'a')).toBe('hi');
	});
	it('empty for non-strings', () => {
		expect(getStringField({ a: 5 }, 'a')).toBe('');
		expect(getStringField({}, 'missing')).toBe('');
	});
});

describe('getEpisodeIdentitySource', () => {
	it('prefers string guid', () => {
		expect(getEpisodeIdentitySource({ guid: 'g1' }, null)).toBe('g1');
	});
	it('falls back to object guid _', () => {
		expect(getEpisodeIdentitySource({ guid: { _: 'g2' } }, null)).toBe('g2');
	});
	it('falls back to enclosure.link', () => {
		expect(getEpisodeIdentitySource({ title: 't' }, { link: 'https://x/ep.mp3' })).toBe('https://x/ep.mp3');
	});
	it('falls back to title|pubDate', () => {
		expect(getEpisodeIdentitySource({ title: 't', pubDate: 'd' }, null)).toBe('t|d');
	});
});

describe('buildEpisodeId', () => {
	it('prefixes with itunesId and source', () => {
		const id = buildEpisodeId({ itunesId: 999 }, { guid: 'g1' }, 0, null);
		expect(id).toBe('999:g1');
	});
	it('falls back to title|pubDate when no guid/enclosure/link', () => {
		const id = buildEpisodeId({ itunesId: 7 }, { title: 't', pubDate: 'd' }, 3, null);
		expect(id).toBe('7:t|d');
	});
});

describe('describePodcastRequestError', () => {
	it('returns the fallback for network errors', () => {
		expect(describePodcastRequestError(new Error('failed to fetch'), 'fb')).toBe('fb');
		expect(describePodcastRequestError(new Error('fetch failed'), 'fb')).toBe('fb');
	});
	it('returns the error message otherwise', () => {
		expect(describePodcastRequestError(new Error('HTTP 500'), 'fb')).toBe('HTTP 500');
	});
	it('returns fallback for non-Errors', () => {
		expect(describePodcastRequestError('oops', 'fb')).toBe('fb');
		expect(describePodcastRequestError(null, 'fb')).toBe('fb');
	});
});
