import { describe, it, expect, beforeEach, vi } from 'vitest';
import { tick } from 'svelte';

// The background-recovery block only runs on a native Android platform, so the
// whole Capacitor surface has to be faked before the store module is imported.
vi.mock('@capacitor/core', () => ({
	Capacitor: {
		isNativePlatform: () => true,
		getPlatform: () => 'android',
	},
}));

vi.mock('$lib/native/media-controls', () => ({
	MediaControls: {
		addListener: () => Promise.resolve({ remove: () => Promise.resolve() }),
		ensureNotificationPermission: () => Promise.resolve({ granted: true }),
		updateNowPlaying: () => Promise.resolve(),
		updatePlaybackState: () => Promise.resolve(),
		setTransportAvailability: () => Promise.resolve(),
		clear: () => Promise.resolve(),
	},
}));

import { mediaEngine, markUserPaused } from '$lib/stores/mediaEngine.svelte';

const TRACK = {
	id: 'm1', source: 'music' as const, title: 'Song', subtitle: 'Artist',
	audioUrl: '', artworkUrl: undefined,
};

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Start playback and let the "user wants playback" latch settle, then let the
 *  WebView hide and pause the element *before* the document event arrives — the
 *  ordering that screen-off produces (no activity transition animation). */
async function playThenPauseElementBeforeDocumentEvent() {
	mediaEngine.musicPlayingA = true;
	await tick();
	mediaEngine.musicPlayingA = false;
	document.dispatchEvent(new Event('pause'));
}

beforeEach(() => {
	mediaEngine.setPlaybackHandlers(null, null, null);
	mediaEngine.clear();
	// Drop any recovery state left armed by a previous test.
	document.dispatchEvent(new Event('resume'));
});

describe('Android background recovery (intent vs instantaneous state)', () => {
	it('resumes playback when the element pause beats the document pause event', async () => {
		mediaEngine.setNowPlaying(TRACK, 'music');
		const play = vi.fn();
		mediaEngine.setPlaybackHandlers(play, null, null);

		await playThenPauseElementBeforeDocumentEvent();
		await wait(250); // first retry is scheduled at 180ms

		expect(play).toHaveBeenCalled();
	});

	it('resumes playback when the document pause event arrives first', async () => {
		mediaEngine.setNowPlaying(TRACK, 'music');
		const play = vi.fn();
		mediaEngine.setPlaybackHandlers(play, null, null);

		mediaEngine.musicPlayingA = true;
		await tick();
		document.dispatchEvent(new Event('pause'));
		await wait(250); // still playing, so nothing to resume yet
		expect(play).not.toHaveBeenCalled();

		mediaEngine.musicPlayingA = false; // element paused after the event
		// No retry is scheduled once the first check sees "still playing", so the
		// 5s watchdog is what recovers this ordering. Documents the ≤5s gap.
		await wait(5500);

		expect(play).toHaveBeenCalled();
	}, 8000);

	it('stays silent after a deliberate pause', async () => {
		mediaEngine.setNowPlaying(TRACK, 'music');
		const play = vi.fn();
		mediaEngine.setPlaybackHandlers(play, null, null);

		mediaEngine.musicPlayingA = true;
		await tick();
		markUserPaused(); // in-app pause button, sleep timer, lock-screen action
		mediaEngine.musicPlayingA = false;
		document.dispatchEvent(new Event('pause'));

		await wait(2000);

		expect(play).not.toHaveBeenCalled();
	});
});
