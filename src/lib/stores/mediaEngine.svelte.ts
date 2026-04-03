/**
 * Global media engine — single source of truth for playback state across
 * Music and Podcasts. 
 * 
 * This store owns the singleton HTMLAudioElement and manages all playback
 * events (MediaSession, Capacitor MediaControls, time tracking).
 * 
 * Individual views (Music, Podcasts) connect to this engine to start
 * playback and update their UI state.
 */

import { Capacitor } from '@capacitor/core';
import type { MediaItem, MediaSource } from '$lib/models/media';
import { MediaControls } from '$lib/native/media-controls';

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
	// --- State & Config ---
	queue:       MediaItem[];
	currentIndex: number;
	volume:      number;
	playbackRate: number;
	isShuffle:    boolean;
	isRepeat:     boolean;
	isTransitioning: boolean;

	// --- Central Commands ---
	play(item: MediaItem, source: MediaSource): void;
	playFromQueue(index: number): void;
	setQueue(items: MediaItem[], startIndex?: number): void;
	pause(): void;
	resume(): void;
	toggle(): void;
	next(): void;
	prev(): void;
	seek(time: number): void;

	// --- Internal Hookups (called by audio listeners) ---
	updateTime(currentTime: number, duration: number): void;
	setPlaying(playing: boolean): void;
	clear(): void;

	// --- Callbacks for views to override behavior ---
	_onNext: (() => void) | null;
	_onPrev: (() => void) | null;
	setCallbacks(next: (() => void) | null, prev: (() => void) | null): void;
}>({
	item:        null,
	isPlaying:   false,
	currentTime: 0,
	duration:    0,
	source:      null,

	queue:       [],
	currentIndex: -1,
	volume:      100,
	playbackRate: 1,
	isShuffle:    false,
	isRepeat:     false,
	isTransitioning: false,

	_onNext: null,
	_onPrev: null,

	/** Core Playback: starts a new track immediately. */
	async play(item: MediaItem, source: MediaSource) {
		const audio = getAudioElement();
		if (!audio) return;

		this.item = item;
		this.source = source;
		this.isPlaying = true;

		// Resolve dynamic URL if needed
		let url = item.audioUrl;
		if (item.resolveUrl) {
			this.isTransitioning = true;
			try {
				const resolved = await item.resolveUrl();
				if (resolved) url = resolved;
			} catch (e) {
				console.error('Failed to resolve track URL:', e);
			} finally {
				this.isTransitioning = false;
			}
		}

		if (!url) {
			this.isPlaying = false;
			return;
		}

		this.currentTime = 0;
		this.duration = item.duration ?? 0;

		// Set the actual source only if it's different to avoid re-buffering
		if (audio.src !== url) {
			audio.src = url;
			audio.load();
		}

		audio.play().catch(() => {
			// Browser might block auto-play if no user interaction occurred
			this.isPlaying = false;
		});
	},

	playFromQueue(index: number) {
		if (index < 0 || index >= this.queue.length) return;
		this.currentIndex = index;
		const track = this.queue[index];
		this.play(track, track.source);
	},

	setQueue(items: MediaItem[], startIndex = 0) {
		this.queue = items;
		this.currentIndex = startIndex;
	},

	pause() {
		const audio = getAudioElement();
		if (audio) audio.pause();
		this.isPlaying = false;
	},

	resume() {
		const audio = getAudioElement();
		if (audio) {
			audio.play().catch(() => {});
			this.isPlaying = true;
		}
	},

	toggle() {
		if (this.isPlaying) this.pause();
		else this.resume();
	},

	next() {
		if (this._onNext) {
			this._onNext();
			return;
		}

		if (this.queue.length === 0) return;

		let nextIndex = this.currentIndex;
		if (this.isRepeat) {
			// Stay on current index or go to start if ended
			nextIndex = this.currentIndex;
		} else if (this.isShuffle) {
			nextIndex = Math.floor(Math.random() * this.queue.length);
		} else {
			nextIndex = this.currentIndex + 1;
		}

		if (nextIndex >= 0 && nextIndex < this.queue.length) {
			this.playFromQueue(nextIndex);
		} else {
			this.clear(); // End of queue
		}
	},

	prev() {
		if (this.currentTime > 3) {
			this.seek(0);
			return;
		}
		if (this._onPrev) {
			this._onPrev();
		} else if (this.currentIndex > 0) {
			this.playFromQueue(this.currentIndex - 1);
		}
	},

	seek(time: number) {
		const audio = getAudioElement();
		if (audio) {
			const target = Math.max(0, Math.min(time, this.duration));
			audio.currentTime = target;
			this.currentTime = target;
		}
	},

	updateTime(currentTime: number, duration: number) {
		this.currentTime = currentTime;
		if (duration > 0) this.duration = duration;
	},

	setPlaying(playing: boolean) {
		this.isPlaying = playing;
	},

	clear() {
		const audio = getAudioElement();
		if (audio) { audio.pause(); audio.src = ''; }
		this.item = null;
		this.isPlaying = false;
		this.currentTime = 0;
		this.duration = 0;
		this.source = null;
	},

	setCallbacks(next, prev) {
		this._onNext = next;
		this._onPrev = prev;
	}
});

// ─────────────────────────────────────────────────────────────────────────────
// Audio Element Lifecycle
// ─────────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
// Audio Element Lifecycle
// ─────────────────────────────────────────────────────────────────────────────
let _audio: HTMLAudioElement | null = null;
let _audioCtx: AudioContext | null = null;
let _filters: BiquadFilterNode[] = [];

const EQ_FREQS = [60, 170, 350, 1000, 3500, 10000];

function getAudioElement(): HTMLAudioElement | null {
	if (typeof window === 'undefined') return null;
	if (!_audio) {
		_audio = new Audio();
		_audio.preload = 'metadata';

		_audio.addEventListener('play', () => { mediaEngine.setPlaying(true); });
		_audio.addEventListener('pause', () => { mediaEngine.setPlaying(false); });
		_audio.addEventListener('ended', () => { mediaEngine.next(); });
		_audio.addEventListener('timeupdate', () => {
			mediaEngine.updateTime(_audio!.currentTime, _audio!.duration);
		});
		_audio.addEventListener('loadedmetadata', () => {
			if (_audio!.duration > 0) mediaEngine.duration = _audio!.duration;
		});
		_audio.addEventListener('error', (e) => {
			console.error('Audio playback error:', e);
			mediaEngine.setPlaying(false);
		});

		// Sync volume and speed reactively
		$effect.root(() => {
			$effect(() => { if (_audio) _audio.volume = mediaEngine.volume / 100; });
			$effect(() => { if (_audio) _audio.playbackRate = mediaEngine.playbackRate; });
		});
	}
	return _audio;
}

export function initGlobalAudioContext() {
	if (!_audio || _audioCtx) return;
	try {
		_audioCtx = new AudioContext();
		const src = _audioCtx.createMediaElementSource(_audio);
		_filters = EQ_FREQS.map((freq, i) => {
			const f = _audioCtx!.createBiquadFilter();
			f.type = (i === 0 ? 'lowshelf' : i === EQ_FREQS.length - 1 ? 'highshelf' : 'peaking') as BiquadFilterType;
			f.frequency.value = freq;
			if (f.type === 'peaking') f.Q.value = 1.4;
			f.gain.value = 0;
			return f;
		});
		let node: AudioNode = src;
		for (const b of _filters) { node.connect(b); node = b; }
		node.connect(_audioCtx.destination);
	} catch (e) {
		console.error('Failed to init global audio context:', e);
	}
}

export function updateGlobalEq(gains: number[]) {
	if (!_filters.length) initGlobalAudioContext();
	_filters.forEach((f, i) => {
		if (gains[i] !== undefined) f.gain.value = gains[i];
	});
}


// ─────────────────────────────────────────────────────────────────────────────
// Browser Media Session Integration
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
			navigator.mediaSession.playbackState = mediaEngine.isPlaying ? 'playing' : 'paused';
		});

		$effect(() => {
			const duration    = mediaEngine.duration;
			const currentTime = mediaEngine.currentTime;
			if (duration > 0 && isFinite(currentTime)) {
				navigator.mediaSession.setPositionState({
					duration:     duration,
					position:     Math.min(currentTime, duration),
					playbackRate: 1,
				});
			}
		});

		$effect(() => {
			navigator.mediaSession.setActionHandler('play',          () => mediaEngine.resume());
			navigator.mediaSession.setActionHandler('pause',         () => mediaEngine.pause());
			navigator.mediaSession.setActionHandler('stop',          () => mediaEngine.pause());
			navigator.mediaSession.setActionHandler('nexttrack',     () => mediaEngine.next());
			navigator.mediaSession.setActionHandler('previoustrack', () => mediaEngine.prev());
			navigator.mediaSession.setActionHandler('seekto', (d) => {
				if (d.seekTime != null) mediaEngine.seek(d.seekTime);
			});
			navigator.mediaSession.setActionHandler('seekforward', (d) => {
				mediaEngine.seek(mediaEngine.currentTime + (d.seekOffset ?? 30));
			});
			navigator.mediaSession.setActionHandler('seekbackward', (d) => {
				mediaEngine.seek(mediaEngine.currentTime - (d.seekOffset ?? 10));
			});
		});
	});
}

// ─────────────────────────────────────────────────────────────────────────────
// Capacitor Native Media Controls Integration
// ─────────────────────────────────────────────────────────────────────────────
if (typeof window !== 'undefined' && Capacitor.isNativePlatform()) {
	$effect.root(() => {
		let mediaActionHandle: Promise<{ remove: () => Promise<void> }> | null = null;

		$effect(() => {
			mediaActionHandle = MediaControls.addListener('mediaAction', (event) => {
				switch (event.action) {
					case 'play':          mediaEngine.resume(); break;
					case 'pause':         mediaEngine.pause();  break;
					case 'nexttrack':     mediaEngine.next();   break;
					case 'previoustrack': mediaEngine.prev();   break;
					case 'seekto':
						if (event.positionSec != null) mediaEngine.seek(event.positionSec);
						break;
				}
			});
			return () => {
				if (mediaActionHandle) {
					void mediaActionHandle.then((h) => h.remove());
				}
			};
		});

		$effect(() => {
			const item = mediaEngine.item;
			if (!item) {
				void MediaControls.clear().catch(() => {});
				return;
			}
			void MediaControls.updateNowPlaying({
				title: item.title,
				artist: item.subtitle,
				durationSec: item.duration ?? 0,
			}).catch(() => {});
		});

		$effect(() => {
			void MediaControls.setTransportAvailability({
				hasNext: mediaEngine.currentIndex < mediaEngine.queue.length - 1 || mediaEngine._onNext !== null,
				hasPrevious: mediaEngine.currentIndex > 0 || mediaEngine._onPrev !== null,
			}).catch(() => {});
		});

		$effect(() => {
			void MediaControls.updatePlaybackState({
				isPlaying: mediaEngine.isPlaying,
				positionSec: mediaEngine.currentTime,
				durationSec: mediaEngine.duration,
			}).catch(() => {});
		});
	});
}
