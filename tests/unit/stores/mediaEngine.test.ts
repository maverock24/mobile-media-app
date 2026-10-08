import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
	mediaEngine, claimAudio, registerAudioSource,
} from '$lib/stores/mediaEngine.svelte';

// The store mutates module-level state (stop callbacks, the live-stream audio
// element) across tests; reset what we can before each.
beforeEach(() => {
	// Re-register every source with a no-op so claimAudio has a clean table.
	registerAudioSource('music', () => {});
	registerAudioSource('podcast', () => {});
	registerAudioSource('radio', () => {});
	registerAudioSource('mixer', () => {});
	mediaEngine.clear();
});

describe('isPlaying derivation', () => {
	it('is false when no source flag is set', () => {
		expect(mediaEngine.isPlaying).toBe(false);
	});

	it('reflects each per-source flag', () => {
		mediaEngine.musicPlayingA = true;
		expect(mediaEngine.isPlaying).toBe(true);
		mediaEngine.musicPlayingA = false;
		mediaEngine.podcastPlaying = true;
		expect(mediaEngine.isPlaying).toBe(true);
		mediaEngine.podcastPlaying = false;
		mediaEngine.radioPlaying = true;
		expect(mediaEngine.isPlaying).toBe(true);
		mediaEngine.radioPlaying = false;
		mediaEngine.mixerPlaying = true;
		expect(mediaEngine.isPlaying).toBe(true);
		mediaEngine.mixerPlaying = false;
		expect(mediaEngine.isPlaying).toBe(false);
	});

	it('a stale flag from a just-stopped source does not block another source', () => {
		// music starts, then a stale async 'pause' sets musicPlaying=false AFTER
		// podcast already started — only music's flag flips, podcast keeps playing.
		mediaEngine.podcastPlaying = true;
		mediaEngine.musicPlayingA = false; // stale pause from the old source
		expect(mediaEngine.isPlaying).toBe(true); // podcast still up
	});
});

describe('setNowPlaying / clear', () => {
	it('setNowPlaying writes metadata without touching playing flags', () => {
		mediaEngine.setNowPlaying({
			id: 'm1', source: 'music', title: 'Song', subtitle: 'Artist',
			audioUrl: '', artworkUrl: undefined,
		}, 'music');
		expect(mediaEngine.item?.title).toBe('Song');
		expect(mediaEngine.source).toBe('music');
		expect(mediaEngine.currentTime).toBe(0);
		expect(mediaEngine.isPlaying).toBe(false);
	});

	it('updateTime advances currentTime and latches duration', () => {
		mediaEngine.updateTime(12, 240);
		expect(mediaEngine.currentTime).toBe(12);
		expect(mediaEngine.duration).toBe(240);
		// duration === 0 must not overwrite a known duration
		mediaEngine.updateTime(15, 0);
		expect(mediaEngine.duration).toBe(240);
	});

	it('clear nulls state and resets every playing flag', () => {
		mediaEngine.setNowPlaying({
			id: 'm1', source: 'music', title: 'Song', subtitle: 'Artist',
			audioUrl: '', artworkUrl: undefined,
		}, 'music');
		mediaEngine.musicPlayingA = true;
		mediaEngine.mixerPlaying = true;
		mediaEngine.clear();
		expect(mediaEngine.item).toBeNull();
		expect(mediaEngine.source).toBeNull();
		expect(mediaEngine.musicPlayingA).toBe(false);
		expect(mediaEngine.mixerPlaying).toBe(false);
		expect(mediaEngine.isPlaying).toBe(false);
	});
});

describe('audio exclusivity (claimAudio)', () => {
	it('invokes every OTHER source\'s stop-callback', () => {
		const musicStop = vi.fn();
		const podcastStop = vi.fn();
		const radioStop = vi.fn();
		registerAudioSource('music', musicStop);
		registerAudioSource('podcast', podcastStop);
		registerAudioSource('radio', radioStop);

		claimAudio('mixer');
		expect(musicStop).toHaveBeenCalledTimes(1);
		expect(podcastStop).toHaveBeenCalledTimes(1);
		expect(radioStop).toHaveBeenCalledTimes(1);
	});

	it('does not invoke the claiming source\'s own stop-callback', () => {
		const musicStop = vi.fn();
		registerAudioSource('music', musicStop);
		claimAudio('music');
		expect(musicStop).not.toHaveBeenCalled();
	});

	it('a source can re-register its stop-callback (latest wins)', () => {
		const first = vi.fn();
		const second = vi.fn();
		registerAudioSource('podcast', first);
		registerAudioSource('podcast', second);
		claimAudio('music');
		expect(first).not.toHaveBeenCalled();
		expect(second).toHaveBeenCalledTimes(1);
	});

	it('Deck B mixes with every source, both ways', () => {
		const stops = {
			musicA: vi.fn(), musicB: vi.fn(), podcast: vi.fn(),
			radio: vi.fn(), youtube: vi.fn(), mixer: vi.fn(),
		};
		registerAudioSource('musicA', stops.musicA);
		registerAudioSource('musicB', stops.musicB);
		registerAudioSource('podcast', stops.podcast);
		registerAudioSource('radio', stops.radio);
		registerAudioSource('youtube', stops.youtube);
		registerAudioSource('mixer', stops.mixer);

		// Starting Deck B stops nothing.
		claimAudio('musicB');
		expect(stops.musicA).not.toHaveBeenCalled();
		expect(stops.podcast).not.toHaveBeenCalled();
		expect(stops.radio).not.toHaveBeenCalled();
		expect(stops.youtube).not.toHaveBeenCalled();
		expect(stops.mixer).not.toHaveBeenCalled();

		// Starting any other source leaves Deck B playing.
		for (const id of ['musicA', 'podcast', 'radio', 'youtube', 'mixer'] as const) {
			stops.musicB.mockClear();
			claimAudio(id);
			expect(stops.musicB, `claimAudio(${id}) must not stop Deck B`).not.toHaveBeenCalled();
		}
	});
});

describe('displayedSource', () => {
	function resetDisplay() {
		mediaEngine.clear();
		mediaEngine.deckAItem = null;
		mediaEngine.deckBItem = null;
		mediaEngine.activeMusicDeck = 'A';
		mediaEngine.activeView = 'music:A';
	}

	it('shows the view source while it plays', () => {
		resetDisplay();
		mediaEngine.musicPlayingA = true;
		expect(mediaEngine.displayedSource).toBe('A');
	});

	it('falls back to a playing non-deck source when the view source is idle', () => {
		resetDisplay();
		mediaEngine.activeView = 'podcasts';
		mediaEngine.source = 'youtube';
		mediaEngine.youtubePlaying = true;
		expect(mediaEngine.displayedSource).toBe('youtube');
	});

	it('keeps the watched deck while a deck owns the primary state', () => {
		resetDisplay();
		mediaEngine.activeView = 'music:A';
		mediaEngine.source = 'music';
		mediaEngine.musicPlayingB = true;
		expect(mediaEngine.displayedSource).toBe('A');
	});

	it('shows B on the B sub-tab while B plays even when YouTube owns the primary state', () => {
		resetDisplay();
		mediaEngine.activeView = 'music:B';
		mediaEngine.activeMusicDeck = 'B';
		mediaEngine.source = 'youtube';
		mediaEngine.youtubePlaying = true;
		mediaEngine.musicPlayingB = true;
		expect(mediaEngine.displayedSource).toBe('B');
	});

	it('shows the view source when nothing is playing', () => {
		resetDisplay();
		mediaEngine.activeView = 'radio';
		expect(mediaEngine.displayedSource).toBe('radio');
	});
});

describe('transport fallbacks', () => {
	it('next/prev delegate to registered _onNext/_onPrev', () => {
		const onNext = vi.fn();
		const onPrev = vi.fn();
		mediaEngine.setSkipHandlers(onNext, onPrev);
		mediaEngine.next();
		mediaEngine.prev();
		expect(onNext).toHaveBeenCalledTimes(1);
		expect(onPrev).toHaveBeenCalledTimes(1);
	});

	it('play/pause/seek delegate to registered handlers', () => {
		const onPlay = vi.fn();
		const onPause = vi.fn();
		const onSeek = vi.fn();
		mediaEngine.setPlaybackHandlers(onPlay, onPause, onSeek);
		mediaEngine._onPlay?.();
		mediaEngine._onPause?.();
		mediaEngine._onSeek?.(42);
		expect(onPlay).toHaveBeenCalledTimes(1);
		expect(onPause).toHaveBeenCalledTimes(1);
		expect(onSeek).toHaveBeenCalledWith(42);
	});
});
