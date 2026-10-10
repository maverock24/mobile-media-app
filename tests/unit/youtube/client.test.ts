import { describe, it, expect } from 'vitest';
import {
	describeYoutubeError,
	extensionForAudioMime,
	toMediaItem,
	youtubeVideoIdFromInput,
} from '$lib/youtube/client';

// ─────────────────────────────────────────────────────────────
// The network paths (search / resolve) need a live YouTube session, so they
// are not covered here. These tests cover the pure logic that the panel and
// the engine integration depend on.
// ─────────────────────────────────────────────────────────────

describe('youtubeVideoIdFromInput', () => {
	it('accepts a bare 11-character video ID', () => {
		expect(youtubeVideoIdFromInput('dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
	});

	it('trims surrounding whitespace', () => {
		expect(youtubeVideoIdFromInput('  dQw4w9WgXcQ  ')).toBe('dQw4w9WgXcQ');
	});

	it('parses a standard watch URL', () => {
		expect(youtubeVideoIdFromInput('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
	});

	it('parses a watch URL with extra params', () => {
		expect(
			youtubeVideoIdFromInput('https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=RDAMVM&t=42s')
		).toBe('dQw4w9WgXcQ');
	});

	it('parses a short youtu.be URL', () => {
		expect(youtubeVideoIdFromInput('https://youtu.be/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
	});

	it('parses a youtu.be URL with a tracking suffix', () => {
		expect(youtubeVideoIdFromInput('https://youtu.be/dQw4w9WgXcQ?si=abc123')).toBe('dQw4w9WgXcQ');
	});

	it('parses a YouTube Music URL', () => {
		expect(youtubeVideoIdFromInput('https://music.youtube.com/watch?v=dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
	});

	it('parses a Shorts URL', () => {
		expect(youtubeVideoIdFromInput('https://www.youtube.com/shorts/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
	});

	it('parses an embed URL', () => {
		expect(youtubeVideoIdFromInput('https://www.youtube.com/embed/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
	});

	it('parses a bare host without a scheme', () => {
		expect(youtubeVideoIdFromInput('youtube.com/watch?v=dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
	});

	it('rejects a non-YouTube host that has a v param', () => {
		expect(youtubeVideoIdFromInput('https://example.com/watch?v=dQw4w9WgXcQ')).toBeNull();
	});

	it('rejects an ID of the wrong length', () => {
		expect(youtubeVideoIdFromInput('https://www.youtube.com/watch?v=tooshort')).toBeNull();
	});

	it('rejects a plain search phrase', () => {
		expect(youtubeVideoIdFromInput('lofi hip hop')).toBeNull();
	});

	it('rejects an empty string', () => {
		expect(youtubeVideoIdFromInput('')).toBeNull();
	});

	it('rejects a YouTube URL with no video ID', () => {
		expect(youtubeVideoIdFromInput('https://www.youtube.com/feed/subscriptions')).toBeNull();
	});
});

describe('extensionForAudioMime', () => {
	it('maps the containers YouTube serves to file extensions', () => {
		expect(extensionForAudioMime('audio/mp4')).toBe('m4a');
		expect(extensionForAudioMime('audio/webm')).toBe('webm');
		expect(extensionForAudioMime('audio/mpeg')).toBe('mp3');
	});

	it('ignores codec parameters and case', () => {
		expect(extensionForAudioMime('audio/mp4; codecs="mp4a.40.2"')).toBe('m4a');
		expect(extensionForAudioMime('AUDIO/WEBM; codecs="opus"')).toBe('webm');
	});

	it('falls back to the container the resolver asks for', () => {
		expect(extensionForAudioMime('audio/unknown')).toBe('m4a');
	});
});

describe('toMediaItem', () => {
	const source = {
		videoId: 'dQw4w9WgXcQ',
		audioUrl: 'https://rr5---sn-x.googlevideo.com/videoplayback?id=1',
		title: 'Never Gonna Give You Up',
		author: 'Rick Astley',
		durationSeconds: 213,
		thumbnailUrl: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg',
	};

	it('namespaces the id so it cannot collide with a local file id', () => {
		expect(toMediaItem(source).id).toBe('youtube:dQw4w9WgXcQ');
	});

	it('tags the source so the engine can attribute playback', () => {
		expect(toMediaItem(source).source).toBe('youtube');
	});

	it('maps title to title and author to subtitle', () => {
		const item = toMediaItem(source);
		expect(item.title).toBe('Never Gonna Give You Up');
		expect(item.subtitle).toBe('Rick Astley');
	});

	it('carries the audio URL and duration through', () => {
		const item = toMediaItem(source);
		expect(item.audioUrl).toBe(source.audioUrl);
		expect(item.duration).toBe(213);
	});

	it('omits artworkUrl when there is no thumbnail', () => {
		expect(toMediaItem({ ...source, thumbnailUrl: '' }).artworkUrl).toBeUndefined();
	});

	it('omits duration when it is unknown', () => {
		expect(toMediaItem({ ...source, durationSeconds: 0 }).duration).toBeUndefined();
	});
});

describe('describeYoutubeError', () => {
	it('turns a network failure into an actionable message', () => {
		expect(describeYoutubeError(new Error('Failed to fetch'))).toContain('connection');
	});

	it('explains a missing audio stream', () => {
		expect(describeYoutubeError(new Error('Streaming data not available'))).toContain('live streams');
	});

	it('explains a sign-in prompt from YouTube', () => {
		expect(
			describeYoutubeError(new Error('Sign in to confirm you are not a bot'))
		).toContain('sign-in');
	});

	it('flags the deciphering failure as needing an app update', () => {
		expect(
			describeYoutubeError(new Error('To decipher URLs, you must provide your own JavaScript evaluator.'))
		).toContain('needs an update');
	});

	it('passes an unrecognised message through', () => {
		expect(describeYoutubeError(new Error('some new YouTube failure'))).toBe('some new YouTube failure');
	});

	it('has a fallback for a blank error', () => {
		expect(describeYoutubeError(new Error(''))).toBe('YouTube request failed.');
	});
});
