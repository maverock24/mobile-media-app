import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { tick } from 'svelte';

// The native bridge effects only run when Capacitor reports a native platform,
// so the Capacitor surface and the MediaControls bridge have to be faked before
// the store module is imported. `vi.hoisted` makes the bridge mock reachable by
// both the factory and the assertions below.
const bridge = vi.hoisted(() => ({
	addListener: vi.fn(() => Promise.resolve({ remove: () => Promise.resolve() })),
	updateNowPlaying: vi.fn(() => Promise.resolve()),
	updatePlaybackState: vi.fn(() => Promise.resolve()),
	updatePosition: vi.fn(() => Promise.resolve()),
	setTransportAvailability: vi.fn(() => Promise.resolve()),
	clear: vi.fn(() => Promise.resolve()),
}));

vi.mock('@capacitor/core', () => ({
	Capacitor: {
		isNativePlatform: () => true,
		getPlatform: () => 'android',
	},
}));

vi.mock('$lib/native/media-controls', () => ({
	MediaControls: bridge,
}));

import { mediaEngine, initMediaEngine } from '$lib/stores/mediaEngine.svelte';

const TRACK = {
	id: 'm1', source: 'music' as const, title: 'Song', subtitle: 'Artist',
	audioUrl: '', artworkUrl: undefined,
};

beforeEach(() => {
	vi.useFakeTimers();
	mediaEngine.setPlaybackHandlers(null, null, null);
	mediaEngine.clear();
	bridge.updatePlaybackState.mockClear();
	bridge.updatePosition.mockClear();
});

afterEach(() => {
	vi.useRealTimers();
});

describe('Android native position re-sync tick', () => {
	it('re-syncs the session position without rebuilding the notification', async () => {
		initMediaEngine();
		mediaEngine.setNowPlaying(TRACK, 'music');
		mediaEngine.musicPlayingA = true;
		await tick();

		// The transition push already fired updatePlaybackState; isolate the
		// interval tick from it so the assertions below cover only the tick.
		bridge.updatePlaybackState.mockClear();
		bridge.updatePosition.mockClear();

		vi.advanceTimersByTime(3000);

		expect(bridge.updatePosition).toHaveBeenCalledTimes(1);
		expect(bridge.updatePosition).toHaveBeenCalledWith({ positionSec: expect.any(Number) });
		expect(bridge.updatePlaybackState).not.toHaveBeenCalled();
	});
});
