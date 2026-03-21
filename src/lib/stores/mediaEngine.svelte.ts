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
	_nextHandler: (() => void) | null;
	_prevHandler: (() => void) | null;
	setSkipHandlers(next: (() => void) | null, prev: (() => void) | null): void;
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

	/** Register next/previous track callbacks (e.g. for Android Auto via MediaSession). */
	setSkipHandlers(next: (() => void) | null, prev: (() => void) | null) {
		this._nextHandler = next;
		this._prevHandler = prev;
	}
});

// ─────────────────────────────────────────────────────────────────────────────
// Media Session API integration — kept here so no view owns it.
// Activated once the engine has an active item.
// ─────────────────────────────────────────────────────────────────────────────
if (typeof window !== 'undefined' && 'mediaSession' in navigator) {
	$effect.root(() => {
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

		$effect(() => {
			const next = mediaEngine._nextHandler;
			const prev = mediaEngine._prevHandler;
			navigator.mediaSession.setActionHandler('nexttrack', next ?? null);
			navigator.mediaSession.setActionHandler('previoustrack', prev ?? null);
		});
	});
}
