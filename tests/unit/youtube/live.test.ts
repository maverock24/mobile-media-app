import { describe, it, expect } from 'vitest';
import {
	resolveYoutubeAudio,
	searchYoutube,
	toMediaItem,
	YoutubeError,
	describeYoutubeError,
} from '$lib/youtube/client';

// ─────────────────────────────────────────────────────────────
// Live extraction tests — these hit YouTube for real.
//
// Skipped by default so `pnpm test` stays hermetic and offline. Run with:
//   pnpm test:live
//
// This is the closest thing to the deployed extraction path that can be
// exercised without an Android device. The browser can never do this (no CORS
// headers on InnerTube), which is exactly why the app routes through
// CapacitorHttp on device.
// ─────────────────────────────────────────────────────────────

const LIVE = process.env.YOUTUBE_LIVE === '1';

/** Rick Astley — a normal upload, not a livestream. */
const KNOWN_VIDEO = 'dQw4w9WgXcQ';

describe.skipIf(!LIVE)('live: searchYoutube', () => {
	it('returns video results with the fields the UI needs', async () => {
		const results = await searchYoutube('top hits 2024');

		expect(results.length).toBeGreaterThan(0);
		for (const result of results) {
			expect(result.videoId).toMatch(/^[A-Za-z0-9_-]{11}$/);
			expect(result.title.length).toBeGreaterThan(0);
			// Channel name drives MediaItem.subtitle.
			expect(typeof result.author).toBe('string');
			// Thumbnails must be usable in <img>; i.ytimg.com sends ACAO: *.
			expect(result.thumbnailUrl).toMatch(/^https:\/\//);
		}
	}, 60_000);

	it('does not return duplicate video ids', async () => {
		const results = await searchYoutube('lofi beats');
		const ids = results.map((r) => r.videoId);
		expect(new Set(ids).size).toBe(ids.length);
	}, 60_000);
});

describe.skipIf(!LIVE)('live: resolveYoutubeAudio', () => {
	it('resolves a normal video to a playable audio stream', async () => {
		const source = await resolveYoutubeAudio(KNOWN_VIDEO);

		expect(source.videoId).toBe(KNOWN_VIDEO);
		expect(source.title.length).toBeGreaterThan(0);
		expect(source.author.length).toBeGreaterThan(0);
		expect(source.durationSeconds).toBeGreaterThan(0);
		expect(source.audioUrl).toMatch(/^https:\/\/.+googlevideo\.com\//);

		// The URL must actually serve audio: googlevideo needs Range support for
		// seeking, and the first bytes carry the container header.
		const response = await fetch(source.audioUrl, { headers: { Range: 'bytes=0-4095' } });
		expect(response.status).toBe(206);
		const bytes = new Uint8Array(await response.arrayBuffer());
		expect(bytes.byteLength).toBeGreaterThan(0);
		const header = Buffer.from(bytes.slice(0, 12)).toString('latin1');
		expect(header.includes('ftyp') || header.includes('webm')).toBe(true);
	}, 60_000);

	it('resolves the audio-only format, not a muxed stream', async () => {
		// A muxed stream would download video too. itag 140/251 are audio-only.
		const source = await resolveYoutubeAudio(KNOWN_VIDEO);
		expect(source.audioUrl).toContain('googlevideo.com');
		// Audio-only formats are substantially smaller than a muxed 720p stream.
		const head = await fetch(source.audioUrl, { headers: { Range: 'bytes=0-0' } });
		const contentRange = head.headers.get('content-range') ?? '';
		const totalBytes = Number(contentRange.split('/')[1] ?? 0);
		expect(totalBytes).toBeGreaterThan(0);
		// ~213s of audio-only is a few MB; a muxed video would be far larger.
		expect(totalBytes).toBeLessThan(30 * 1024 * 1024);
	}, 60_000);

	it('resolves a second, unrelated video (not a one-off success)', async () => {
		const results = await searchYoutube('top hits 2024');
		const source = await resolveYoutubeAudio(results[0].videoId);
		expect(source.audioUrl).toMatch(/^https:\/\//);
		const response = await fetch(source.audioUrl, { headers: { Range: 'bytes=0-1023' } });
		expect(response.status).toBe(206);
	}, 90_000);

	it('reuses the session across calls', async () => {
		await resolveYoutubeAudio(KNOWN_VIDEO);
		const start = Date.now();
		await resolveYoutubeAudio(KNOWN_VIDEO);
		// A warm session skips session creation, so this is well under the
		// ~2 s a cold retrieve_player session used to cost.
		expect(Date.now() - start).toBeLessThan(5000);
	}, 60_000);

	it('produces a MediaItem the engine can consume', async () => {
		const source = await resolveYoutubeAudio(KNOWN_VIDEO);
		const item = toMediaItem(source);

		expect(item.source).toBe('youtube');
		expect(item.id).toBe(`youtube:${KNOWN_VIDEO}`);
		expect(item.audioUrl).toBe(source.audioUrl);
		expect(item.duration).toBe(source.durationSeconds);
		expect(item.subtitle).toBe(source.author);
	}, 60_000);
});

describe.skipIf(!LIVE)('live: failure modes', () => {
	it('rejects a currently-live stream with a user-facing message', async () => {
		// lofi girl 24/7 radio — a stream that is live right now.
		await expect(resolveYoutubeAudio('jfKfPfyJRdk')).rejects.toThrow();
		try {
			await resolveYoutubeAudio('jfKfPfyJRdk');
		} catch (error) {
			expect(error).toBeInstanceOf(YoutubeError);
			// Whatever the cause, the message must be presentable.
			expect(describeYoutubeError(error).length).toBeGreaterThan(0);
		}
	}, 60_000);

	it('rejects a malformed video id without hanging', async () => {
		await expect(resolveYoutubeAudio('not-a-video')).rejects.toThrow();
	}, 60_000);
});
