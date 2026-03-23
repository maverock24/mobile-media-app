/**
 * Global media engine — single source of truth for playback state across
 * Music and Podcasts.
 *
 * Existing per-view audio elements remain in place and continue to work.
 * This store acts as a coordination layer on top, exposing unified reactive
 * state that the MiniPlayer and MediaSession integration consume.
 */

import type { MediaItem, MediaSource } from '$lib/models/media';

export interface NowPlayingState {
	item:        MediaItem | null;
	isPlaying:   boolean;
	currentTime: number;    // seconds
	duration:    number;    // seconds
	source:      MediaSource | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Reactive state — read anywhere via `import { mediaEngine } from …`
// ─────────────────────────────────────────────────────────────────────────────
export const mediaEngine = $state<NowPlayingState & {
	setNowPlaying(item: MediaItem, source: MediaSource): void;
	updateTime(currentTime: number, duration: number): void;
	setPlaying(playing: boolean): void;
	clear(): void;
	_nextHandler:  (() => void) | null;
	_prevHandler:  (() => void) | null;
	_playHandler:  (() => void) | null;
	_pauseHandler: (() => void) | null;
	_seekHandler:  ((positionSec: number) => void) | null;
	setSkipHandlers(next: (() => void) | null, prev: (() => void) | null): void;
	setPlaybackHandlers(
		play:  (() => void) | null,
		pause: (() => void) | null,
		seek:  ((positionSec: number) => void) | null
	): void;
}>({
	item:        null as MediaItem | null,
	isPlaying:   false as boolean,
	currentTime: 0,
	duration:    0,
	source:      null as MediaSource | null,

	/** Called by a view when it starts or selects a new track. */
	setNowPlaying(item: MediaItem, source: MediaSource) {
		this.item        = item;
		this.source      = source;
		this.currentTime = 0;
		this.duration    = item.duration ?? 0;
	},

	/** Called each tick from the view's timeupdate handler. */
	updateTime(currentTime: number, duration: number) {
		this.currentTime = currentTime;
		if (duration > 0) this.duration = duration;
	},

	/** Called by the view's play/pause event listeners. */
	setPlaying(playing: boolean) {
		this.isPlaying = playing;
	},

	/** Called when a source stops completely (no track loaded). */
	clear() {
		this.item        = null;
		this.isPlaying   = false;
		this.currentTime = 0;
		this.duration    = 0;
		this.source      = null;
	},

	_nextHandler: null as (() => void) | null,
	_prevHandler: null as (() => void) | null,
	_playHandler: null as (() => void) | null,
	_pauseHandler: null as (() => void) | null,
	_seekHandler: null as ((positionSec: number) => void) | null,

	/** Register next/previous track callbacks (e.g. for Android Auto / lock-screen). */
	setSkipHandlers(next: (() => void) | null, prev: (() => void) | null) {
		this._nextHandler = next;
		this._prevHandler = prev;
	},

	/** Register play/pause/seek callbacks for lock-screen / notification controls. */
	setPlaybackHandlers(
		play: (() => void) | null,
		pause: (() => void) | null,
		seek: ((positionSec: number) => void) | null
	) {
		this._playHandler  = play;
		this._pauseHandler = pause;
		this._seekHandler  = seek;
	}
});

// ─────────────────────────────────────────────────────────────────────────────
// Media Session API integration — kept here so no view owns it.
// Activated once the engine has an active item.
// ─────────────────────────────────────────────────────────────────────────────
if (typeof window !== 'undefined' && 'mediaSession' in navigator) {
	$effect.root(() => {
		// Sync metadata whenever the playing item changes
		$effect(() => {
			const item = mediaEngine.item;
			if (!item) {
				navigator.mediaSession.metadata = null;
				return;
			}
			navigator.mediaSession.metadata = new MediaMetadata({
				title:  item.title,
				artist: item.subtitle,
				album:  item.source === 'podcast' ? 'Podcasts' : 'Music',
				artwork: item.artworkUrl
					? [{ src: item.artworkUrl, sizes: '512x512', type: 'image/jpeg' }]
					: []
			});
		});

		// Sync playback state so the lock screen shows the correct play/pause icon
		$effect(() => {
			navigator.mediaSession.playbackState = mediaEngine.isPlaying ? 'playing' : 'paused';
		});

		// Sync position state for seek bar on lock screen / notification
		// Throttled to once per second — no need to call native API at 60fps
		let _positionStateTimer: ReturnType<typeof setTimeout> | null = null;
		$effect(() => {
			const duration    = mediaEngine.duration;
			const currentTime = mediaEngine.currentTime;
			if (duration <= 0) return;
			if (_positionStateTimer !== null) return; // already scheduled
			_positionStateTimer = setTimeout(() => {
				_positionStateTimer = null;
				if (mediaEngine.duration > 0) {
					navigator.mediaSession.setPositionState({
						duration:     mediaEngine.duration,
						position:     Math.min(mediaEngine.currentTime, mediaEngine.duration),
						playbackRate: 1,
					});
				}
			}, 1000);
			// Ensure cleanup if effect re-runs
			return () => {
				if (_positionStateTimer !== null) { clearTimeout(_positionStateTimer); _positionStateTimer = null; }
			};
		});

		// Register all action handlers whenever the callbacks change
		$effect(() => {
			const { _nextHandler: next, _prevHandler: prev,
			        _playHandler: play, _pauseHandler: pause,
			        _seekHandler: seek } = mediaEngine;

			navigator.mediaSession.setActionHandler('play',          play ?? null);
			navigator.mediaSession.setActionHandler('pause',         pause ?? null);
			navigator.mediaSession.setActionHandler('stop',          pause ?? null);
			navigator.mediaSession.setActionHandler('nexttrack',     next ?? null);
			navigator.mediaSession.setActionHandler('previoustrack', prev ?? null);
			navigator.mediaSession.setActionHandler('seekto', seek
				? (d) => { if (d.seekTime != null) seek(d.seekTime); }
				: null);
			navigator.mediaSession.setActionHandler('seekforward', seek
				? (d) => seek(Math.min(mediaEngine.currentTime + (d.seekOffset ?? 30), mediaEngine.duration))
				: null);
			navigator.mediaSession.setActionHandler('seekbackward', seek
				? (d) => seek(Math.max(mediaEngine.currentTime - (d.seekOffset ?? 10), 0))
				: null);
		});
	});
}
