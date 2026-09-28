import type { Innertube } from 'youtubei.js';
import type { MediaItem } from '$lib/models/media';
import { createYoutubeFetch } from './native-http';

/**
 * YouTube audio extraction via InnerTube.
 *
 * Two client IDs are in play, and the split is not optional:
 *
 *  - The session runs as `WEB`. `ANDROID_VR` cannot be the session client:
 *    `search()` then throws
 *    `ParsingError: Cannot cast SearchMobileHeader to one of SearchHeader`.
 *  - Playback requests override the client to `VISIONOS` per call. `WEB` and
 *    `ANDROID` no longer return any per-format URL at all — the player response
 *    carries `serverAbrStreamingUrl` and an `attestation` marker instead, so
 *    every format has an undefined `url`, `signatureCipher` and `cipher`.
 *    `VISIONOS` (and `ANDROID_VR`) still return plain, directly playable URLs,
 *    but see PLAYBACK_CLIENT below for why only VISIONOS is usable under an
 *    `<audio>` element.
 *
 * Playback uses `getBasicInfo`, never `getInfo`. `getInfo` also requests
 * `/next`, which youtubei.js 18.1.0 fails to parse
 * (`TypeError: Cannot read properties of null (reading 'as')` in VideoInfo),
 * so it rejects even though the player response arrived intact.
 *
 * Because `VISIONOS` returns plain URLs, no `Platform.shim.eval` interpreter
 * is needed, and therefore no CSP `unsafe-eval`. If YouTube ever starts
 * ciphering these formats the browser evaluator throws a clear
 * "must provide your own JavaScript evaluator" error rather than failing
 * silently.
 */

/**
 * Client used for player requests only. See the note above before changing.
 *
 * VISIONOS rather than ANDROID_VR, and the reason matters: both return plain
 * format URLs, but ANDROID_VR's googlevideo URLs answer a request with no
 * bounded byte range with `403 text/plain`. An `<audio>` element's first probe
 * is exactly that (`Range: bytes=0-`), so Chromium's Opaque Response Blocking
 * drops the text/plain 403 and playback never starts — silently, with no useful
 * console error. VISIONOS serves `200 audio/mp4` with no range and
 * `206 audio/mp4` for `bytes=0-`, so the media element works.
 *
 * Verified across several videos; see tests/e2e/youtube.test.ts, which plays a
 * real stream end to end and would fail on ANDROID_VR.
 */
const PLAYBACK_CLIENT = 'VISIONOS' as const;
const SEARCH_RESULT_LIMIT = 25;

export interface YoutubeSearchResult {
	videoId: string;
	title: string;
	author: string;
	durationSeconds: number;
	durationLabel: string;
	thumbnailUrl: string;
}

export interface YoutubeAudioSource {
	videoId: string;
	audioUrl: string;
	title: string;
	author: string;
	durationSeconds: number;
	thumbnailUrl: string;
}

/** Thrown for conditions the user can act on, so the UI can show the message as-is. */
export class YoutubeError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'YoutubeError';
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Session
// ─────────────────────────────────────────────────────────────────────────────
let _sessionPromise: Promise<Innertube> | null = null;

async function getSession(): Promise<Innertube> {
	if (!_sessionPromise) {
		_sessionPromise = (async () => {
			// Loaded lazily so the ~660 KB library stays out of the startup bundle.
			const { Innertube, Log, ClientType } = await import('youtubei.js');
			Log.setLevel(Log.Level.NONE);
			return Innertube.create({
				client_type: ClientType.WEB,
				fetch: createYoutubeFetch(),
				// The player script is only needed to decipher ciphered URLs.
				// ANDROID_VR returns plain URLs, so skipping it removes a 2.5 MB
				// download per session (89 KB total instead of 3.35 MB) and takes
				// session creation from ~2 s to ~200 ms. It also avoids pushing a
				// multi-megabyte string across the Capacitor bridge, which is the
				// case CapacitorHttp documents as problematic.
				retrieve_player: false,
			});
		})().catch((error: unknown) => {
			// Let the next call retry instead of caching a failed init forever.
			_sessionPromise = null;
			throw error;
		});
	}
	return _sessionPromise;
}

/** Drop the cached session and player. Used when YouTube changes break the client. */
export function resetYoutubeSession(): void {
	_sessionPromise = null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure helpers
// ─────────────────────────────────────────────────────────────────────────────
const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;

/**
 * Accepts a bare video ID or any common YouTube URL shape and returns the
 * 11-character video ID, or null when the input isn't one.
 */
export function youtubeVideoIdFromInput(input: string): string | null {
	const trimmed = input.trim();
	if (VIDEO_ID_PATTERN.test(trimmed)) return trimmed;

	let url: URL;
	try {
		url = new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`);
	} catch {
		return null;
	}

	const host = url.hostname.replace(/^www\.|^m\./, '').toLowerCase();
	if (host !== 'youtube.com' && host !== 'youtu.be' && host !== 'music.youtube.com') return null;

	if (host === 'youtu.be') {
		const id = url.pathname.slice(1).split('/')[0];
		return VIDEO_ID_PATTERN.test(id) ? id : null;
	}

	const v = url.searchParams.get('v');
	if (v && VIDEO_ID_PATTERN.test(v)) return v;

	// /shorts/ID, /embed/ID, /live/ID
	const segments = url.pathname.split('/').filter(Boolean);
	if (segments.length >= 2 && ['shorts', 'embed', 'live', 'v'].includes(segments[0])) {
		const id = segments[1];
		return VIDEO_ID_PATTERN.test(id) ? id : null;
	}

	return null;
}

/** Map a resolved YouTube source onto the shared media item model. */
export function toMediaItem(source: YoutubeAudioSource): MediaItem {
	return {
		id: `youtube:${source.videoId}`,
		source: 'youtube',
		title: source.title,
		subtitle: source.author,
		audioUrl: source.audioUrl,
		artworkUrl: source.thumbnailUrl || undefined,
		duration: source.durationSeconds || undefined,
	};
}

/** Turn a library-thrown error into something worth showing the user. */
export function describeYoutubeError(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);

	if (/no internet|network|failed to fetch|unable to resolve host|timeout/i.test(message)) {
		return 'Could not reach YouTube. Check your connection.';
	}
	if (/Streaming data not available|not available/i.test(message)) {
		return 'This video has no playable audio stream (live streams are not supported).';
	}
	if (/LOGIN_REQUIRED|Sign in to confirm/i.test(message)) {
		return 'YouTube is asking for sign-in for this video.';
	}
	if (/JavaScript evaluator/i.test(message)) {
		return 'YouTube changed its URL encoding. The app needs an update.';
	}
	return message || 'YouTube request failed.';
}

// ─────────────────────────────────────────────────────────────────────────────
// Network
// ─────────────────────────────────────────────────────────────────────────────
/** Search YouTube. Returns up to SEARCH_RESULT_LIMIT video results. */
export async function searchYoutube(query: string): Promise<YoutubeSearchResult[]> {
	const session = await getSession();
	const results = await session.search(query, { type: 'video' });
	// `Search.videos` is a union of every video-shaped node, but only `Video`
	// carries `duration` / `best_thumbnail`. Narrow before mapping.
	const { YTNodes } = await import('youtubei.js');
	const videos = results.videos
		.filter((video) => video.is(YTNodes.Video))
		// Currently-live streams carry no per-format URL, so they can never play.
		// Dropping them here keeps dead entries out of the queue; anything that
		// still fails to resolve is skipped by the panel's advance logic.
		.filter((video) => !video.is_live)
		.slice(0, SEARCH_RESULT_LIMIT);

	return videos
		.filter((video) => Boolean(video.video_id))
		.map((video) => ({
			videoId: video.video_id,
			title: video.title?.text ?? '',
			author: video.author?.name ?? '',
			durationSeconds: video.duration?.seconds ?? 0,
			durationLabel: video.duration?.text ?? '',
			thumbnailUrl: video.best_thumbnail?.url ?? video.thumbnails?.at(-1)?.url ?? '',
		}));
}

/**
 * Resolve the best audio-only stream for a video.
 *
 * The returned URL is bound to the requesting IP, which is why this has to run
 * on the device rather than behind the Netlify proxy.
 */
export async function resolveYoutubeAudio(videoId: string): Promise<YoutubeAudioSource> {
	const session = await getSession();
	const basic = await session.getBasicInfo(videoId, { client: PLAYBACK_CLIENT });
	const info = basic.basic_info;

	if (info.is_live) {
		throw new YoutubeError('Live streams are not supported yet.');
	}

	let audioUrl: string;
	try {
		const format = basic.chooseFormat({ type: 'audio', quality: 'best' });
		if (!format.url) {
			// Only happens if YouTube stops returning plain URLs for this client.
			throw new YoutubeError('YouTube did not return a playable audio stream for this video.');
		}
		audioUrl = format.url;
	} catch (error) {
		if (error instanceof YoutubeError) throw error;
		throw new YoutubeError(describeYoutubeError(error));
	}

	return {
		videoId,
		audioUrl,
		title: info.title ?? '',
		author: info.author ?? '',
		durationSeconds: info.duration ?? 0,
		thumbnailUrl: info.thumbnail?.at(-1)?.url ?? '',
	};
}
