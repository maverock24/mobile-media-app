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
import { addToHistory } from './history.svelte';
import { addToast } from './toastStore.svelte';

// ─────────────────────────────────────────────────────────────────────────────
// Audio exclusivity — only one source (music / podcast) plays at a time.
// Views register a stop-callback; calling claimAudio pauses the others.
// ─────────────────────────────────────────────────────────────────────────────
type AudioSourceId = MediaSource | 'essay';
const _stopFns: Partial<Record<AudioSourceId, () => void>> = {};

export function registerAudioSource(id: AudioSourceId, stopFn: () => void): void {
	_stopFns[id] = stopFn;
}

export function claimAudio(id: AudioSourceId): void {
	for (const other of Object.keys(_stopFns) as AudioSourceId[]) {
		if (other !== id) _stopFns[other]?.();
	}
}

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
	crossfadeDuration: number; // seconds
	eqBands: number[];

	// --- Central Commands ---
	play(item: MediaItem, source: MediaSource): void;
	playFromQueue(index: number): void;
	setQueue(items: MediaItem[], startIndex?: number): void;
	pause(): void;
	resume(): void;
	toggle(): void;
	next(manual?: boolean): void;
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
	crossfadeDuration: 0,
	eqBands: [0, 0, 0, 0, 0, 0],

	_onNext: null,
	_onPrev: null,

	/** Core Playback: starts a new track immediately. */
	async play(item: MediaItem, source: MediaSource) {
		const isFirstPlay = !this.item;
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

		// Orchestrate Slot Switch
		const xf = this.crossfadeDuration;
		const useCrossfade = !isFirstPlay && xf > 0;
		
		const slots = getAudioSlots();
		const oldSlot = slots[_activeSlot];
		_activeSlot = (_activeSlot + 1) % 2;
		const newSlot = slots[_activeSlot];

		newSlot.src = url;
		newSlot.load();
		
		// Ensure AudioContext is ready (required for EQ/Filter chain to work)
		if (_audioCtx?.state === 'suspended') {
			void _audioCtx.resume();
		} else if (!_audioCtx) {
			initGlobalAudioContext();
		}

		newSlot.play().then(() => {
			if (this.item) addToHistory(this.item);
		}).catch(() => {
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
		const slots = getAudioSlots();
		slots.forEach(s => s.pause());
		this.isPlaying = false;
	},

	resume() {
		const slots = getAudioSlots();
		const current = slots[_activeSlot];
		if (current) {
			if (_audioCtx?.state === 'suspended') void _audioCtx.resume();
			current.play().catch(() => {});
			this.isPlaying = true;
		}
	},

	toggle() {
		if (this.isPlaying) this.pause();
		else this.resume();
	},

	next(manual = true) {
		if (manual && this._onNext) {
			this._onNext();
			return;
		}

		if (this.queue.length === 0) return;

		let nextIndex = this.currentIndex;
		if (this.isRepeat && !manual) {
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
		const slots = getAudioSlots();
		const current = slots[_activeSlot];
		if (current) {
			const target = Math.max(0, Math.min(time, this.duration));
			current.currentTime = target;
			this.currentTime = target;
		}
	},

	updateTime(currentTime: number, duration: number) {
		this.currentTime = currentTime;
		if (duration > 0) this.duration = duration;
		
		// Preload next track if near end
		const xf = this.crossfadeDuration;
		if (this.duration > 0 && this.currentTime > this.duration - (xf + 2)) {
			// Preload logic could go here, but since 'play' handles slot swapping,
			// we'll just let the 'ended' event trigger next() and crossfade.
		}
	},

	setPlaying(playing: boolean) {
		this.isPlaying = playing;
	},

	clear() {
		const slots = getAudioSlots();
		slots.forEach(s => { s.pause(); s.src = ''; });
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
// Audio Error Description
// ─────────────────────────────────────────────────────────────────────────────
function describeAudioError(err: MediaError): string {
	switch (err.code) {
		case MediaError.MEDIA_ERR_ABORTED:          return 'Playback was interrupted.';
		case MediaError.MEDIA_ERR_NETWORK:           return 'A network error caused playback to fail. Check your connection.';
		case MediaError.MEDIA_ERR_DECODE:            return 'The audio file could not be decoded.';
		case MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED: return 'This audio format is not supported.';
		default: return err.message || 'Unknown playback error.';
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Audio Slot Management
// ─────────────────────────────────────────────────────────────────────────────
let _audioSlots: [HTMLAudioElement, HTMLAudioElement] | null = null;
let _activeSlot = 0;
let _audioCtx: AudioContext | null = null;
let _filters: BiquadFilterNode[] = [];

const EQ_FREQS = [60, 170, 350, 1000, 3500, 10000];

function getAudioSlots(): [HTMLAudioElement, HTMLAudioElement] {
	if (typeof window === 'undefined') return [] as any;
	if (!_audioSlots) {
		_audioSlots = [new Audio(), new Audio()];
		_audioSlots.forEach((audio, i) => {
			audio.preload = 'metadata';
			audio.addEventListener('play', () => { if (i === _activeSlot) mediaEngine.setPlaying(true); });
			audio.addEventListener('pause', () => { if (i === _activeSlot) mediaEngine.setPlaying(false); });
			audio.addEventListener('ended', () => { if (i === _activeSlot) mediaEngine.next(false); });
			audio.addEventListener('timeupdate', () => {
				if (i === _activeSlot) mediaEngine.updateTime(audio.currentTime, audio.duration);
			});
			audio.addEventListener('loadedmetadata', () => {
				if (i === _activeSlot && audio.duration > 0) mediaEngine.duration = audio.duration;
			});
			audio.addEventListener('error', () => {
				const err = audio.error;
				if (!audio.src || audio.src === 'about:blank') return;
				console.error(`Audio slot ${i} error:`, err?.code, err?.message);
				if (i === _activeSlot) {
					mediaEngine.setPlaying(false);
					const msg = err ? describeAudioError(err) : 'Unknown playback error.';
					addToast({ message: msg, type: 'error' });
				}
			});
		});

		// Sync volume, speed, and EQ reactively
		$effect.root(() => {
			$effect(() => {
				const masterVol = mediaEngine.volume / 100;
				const slots = getAudioSlots();
				// Volume is handled during crossfade, but we sync master baseline here
				// Note: manual volume changes should affect the ACTIVE slot immediately.
				slots[_activeSlot].volume = masterVol;
			});
			$effect(() => {
				const rate = mediaEngine.playbackRate;
				getAudioSlots().forEach(s => s.playbackRate = rate);
			});
			$effect(() => {
				updateGlobalEq(mediaEngine.eqBands);
			});
		});
	}
	return _audioSlots;
}

/** Fade helper for crossfading */
function fadeAudio(audio: HTMLAudioElement, targetVol: number, duration: number, pauseOnEnd = false) {
	const startVol = audio.volume;
	const delta = targetVol - startVol;
	const steps = 20;
	const interval = (duration * 1000) / steps;
	let currentStep = 0;

	const timer = setInterval(() => {
		currentStep++;
		audio.volume = Math.max(0, Math.min(1, startVol + (delta * (currentStep / steps))));
		if (currentStep >= steps) {
			clearInterval(timer);
			if (pauseOnEnd) {
				audio.pause();
				audio.src = '';
			}
		}
	}, interval);
}

export function initGlobalAudioContext() {
	if (!_audioSlots || _audioCtx) return;
	try {
		_audioCtx = new AudioContext();
		
		// Create a shared node chain
		_filters = EQ_FREQS.map((freq, i) => {
			const f = _audioCtx!.createBiquadFilter();
			f.type = (i === 0 ? 'lowshelf' : i === EQ_FREQS.length - 1 ? 'highshelf' : 'peaking') as BiquadFilterType;
			f.frequency.value = freq;
			if (f.type === 'peaking') f.Q.value = 1.4;
			f.gain.value = 0;
			return f;
		});

		// Connect BOTH slots to the entry of the filter chain
		_audioSlots.forEach(audio => {
			const src = _audioCtx!.createMediaElementSource(audio);
			src.connect(_filters[0]);
		});

		// Pipe filters together
		for (let i = 0; i < _filters.length - 1; i++) {
			_filters[i].connect(_filters[i+1]);
		}
		_filters[_filters.length - 1].connect(_audioCtx.destination);
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
				album: item.album || (item.source === 'podcast' ? 'Podcasts' : 'Music'),
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
