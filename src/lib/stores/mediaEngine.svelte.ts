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
import { createEqFilterChain, applyEqGains } from '$lib/audio/equalizer';
import { addToHistory } from './history.svelte';
import { addToast } from './toastStore.svelte';

// ─────────────────────────────────────────────────────────────────────────────
// Audio exclusivity — only one source (music / podcast) plays at a time.
// Views register a stop-callback; calling claimAudio pauses the others.
// ─────────────────────────────────────────────────────────────────────────────
type AudioSourceId = MediaSource | 'essay' | 'mixer';
const _stopFns: Partial<Record<AudioSourceId, () => void>> = {};

export function registerAudioSource(id: AudioSourceId, stopFn: () => void): void {
	_stopFns[id] = stopFn;
}

export function claimAudio(id: AudioSourceId): void {
	for (const other of Object.keys(_stopFns) as AudioSourceId[]) {
		if (other !== id) _stopFns[other]?.();
	}
	// Stop any active live stream unless this is a radio claim
	if (id !== 'radio') stopStreamAudio();
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
	/** Metadata-only update — sets now-playing info without starting audio playback. */
	setNowPlaying(item: MediaItem, source: MediaSource): void;

	// ─── Live stream methods (radio) ───
	_streamError: ((err: MediaError | null) => void) | null;
	_streamWaiting: (() => void) | null;
	_streamPlaying: (() => void) | null;
	_streamEnded: (() => void) | null;
	playStream(url: string, item: MediaItem): void;
	pauseStream(): void;
	resumeStream(): void;
	stopStream(): void;
	setStreamCallbacks(error: (err: MediaError | null) => void, waiting: () => void, playing: () => void, ended?: () => void): void;

	// --- Callbacks for views to override behavior ---
	_onPlay: (() => void) | null;
	_onPause: (() => void) | null;
	_onSeek: ((time: number) => void) | null;
	_onNext: (() => void) | null;
	_onPrev: (() => void) | null;
	setPlaybackHandlers(play: (() => void) | null, pause: (() => void) | null, seek: ((time: number) => void) | null): void;
	setSkipHandlers(next: (() => void) | null, prev: (() => void) | null): void;
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

	_onPlay: null,
	_onPause: null,
	_onSeek: null,
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
			updateGlobalEq(mediaEngine.eqBands);
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
		// Radio plays through _streamAudio (not an audio slot), so pause it directly.
		if (this.source === 'radio' && _streamAudio) {
			_streamAudio.pause();
			this.isPlaying = false;
			return;
		}
		const slots = getAudioSlots();
		slots.forEach(s => s.pause());
		this.isPlaying = false;
	},

	resume() {
		if (this.source === 'radio' && _streamAudio) {
			if (_audioCtx?.state === 'suspended') void _audioCtx.resume();
			_streamAudio.play().catch(() => {});
			this.isPlaying = true;
			return;
		}
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
		stopStreamAudio();
		this.item = null;
		this.isPlaying = false;
		this.currentTime = 0;
		this.duration = 0;
		this.source = null;
	},

	setPlaybackHandlers(play, pause, seek) {
		this._onPlay = play;
		this._onPause = pause;
		this._onSeek = seek;
	},

	setSkipHandlers(next, prev) {
		this._onNext = next;
		this._onPrev = prev;
	},

	setCallbacks(next, prev) {
		this._onNext = next;
		this._onPrev = prev;
	},

	/** Metadata-only: update now-playing state without triggering audio slot playback. */
	setNowPlaying(item: MediaItem, source: MediaSource) {
		this.item = item;
		this.source = source;
		this.currentTime = 0;
		this.duration = item.duration ?? 0;
	},

	// ─── Live stream playback (radio) ────────────────────────────────────
	_streamError: null as ((err: MediaError | null) => void) | null,
	_streamWaiting: null as (() => void) | null,
	_streamPlaying: null as (() => void) | null,
	_streamEnded: null as (() => void) | null,

	/** Begin playing a live stream URL through the shared audio pipeline. */
	playStream(url: string, item: MediaItem) {
		claimAudio('radio');
		_streamShouldPlay = true;
		// Route MiniPlayer / web mediaSession / native transport controls to the live
		// stream so pause/resume act on _streamAudio instead of the (silent) audio slots.
		this.setPlaybackHandlers(
			() => this.resumeStream(),
			() => this.pauseStream(),
			null,
		);
		stopStreamAudio();
		_streamAudio = new Audio();
		_streamAudio.preload = 'none';

		_streamAudio.addEventListener('play', () => { this.setPlaying(true); this._streamPlaying?.(); });
		_streamAudio.addEventListener('pause', () => { if (this.source === 'radio') this.setPlaying(false); });
		_streamAudio.addEventListener('waiting', () => { this._streamWaiting?.(); });
		_streamAudio.addEventListener('playing', () => { this._streamPlaying?.(); });
		_streamAudio.addEventListener('timeupdate', () => {
			// Heartbeat: keep the stream alive and track buffering state
		});
		_streamAudio.addEventListener('error', () => {
			// Stale pause/error from the previous stream fires during stopStreamAudio()
			// teardown — ignore it once another source has claimed playback, so it can't
			// clobber the new source's isPlaying=true (Android WebView race).
			if (this.source !== 'radio') return;
			this.setPlaying(false);
			this._streamError?.(_streamAudio?.error ?? null);
		});
		_streamAudio.addEventListener('ended', () => {
			// Stream ended unexpectedly (server disconnect / Android resource kill).
			// Only auto-reconnect if the user still wants playback — a deliberate pause
			// can also surface as 'ended' on live streams and must NOT restart audio.
			if (this.source === 'radio') this.setPlaying(false);
			this._streamEnded?.();
			if (_streamShouldPlay) reconnectStream(url, item);
		});

		_streamReconnectUrl = url;
		_streamReconnectItem = item;
		this.item = item;
		this.source = 'radio';
		this.duration = 0;

		// NOTE: Cross-origin streams (radio/podcast) CANNOT be processed by the Web
		// Audio API. The browser outputs SILENCE for tainted cross-origin media unless
		// the server sends CORS headers (which public radio/podcast servers do not).
		// Routing them through createMediaElementSource() mutes them, and setting
		// crossOrigin='anonymous' makes them fail to load. So we play streams DIRECTLY.
		// EQ for radio/podcast requires proxying the stream through our own origin.
		_streamAudio.src = url;
		_streamAudio.play().catch((err) => {
			if (err?.name !== 'AbortError' && this.source === 'radio') this.setPlaying(false);
		});
	},

	/** Pause the live stream without tearing down the audio element. */
	pauseStream() {
		// User intent = paused: cancel any pending reconnect so the stream stays stopped.
		_streamShouldPlay = false;
		cancelStreamReconnect();
		if (_streamAudio) {
			_streamAudio.pause();
			this.setPlaying(false);
		}
	},

	/** Resume the live stream if paused. */
	resumeStream() {
		if (_streamAudio && this.source === 'radio') {
			_streamShouldPlay = true;
			if (_audioCtx?.state === 'suspended') void _audioCtx.resume();
			_streamAudio.play().catch(() => {});
			this.setPlaying(true);
		}
	},

	/** Stop the live stream and tear down its audio element. */
	stopStream() {
		_streamShouldPlay = false;
		cancelStreamReconnect();
		stopStreamAudio();
		if (this.source === 'radio') {
			this.clear();
		}
	},

	setStreamCallbacks(
		error: (err: MediaError | null) => void,
		waiting: () => void,
		playing: () => void,
		ended?: () => void
	) {
		this._streamError = error;
		this._streamWaiting = waiting;
		this._streamPlaying = playing;
		this._streamEnded = ended ?? null;
	},
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
let _streamAudio: HTMLAudioElement | null = null;
/** User intent: true while the listener wants the stream playing. Gates auto-reconnect
 *  so a deliberate pause/stop is never undone by the reconnect-on-drop logic. */
let _streamShouldPlay = false;
let _streamReconnectUrl: string | null = null;
let _streamReconnectItem: MediaItem | null = null;
let _streamReconnectTimer: number | null = null;
let _streamReconnectAttempts = 0;
const STREAM_MAX_RECONNECT_ATTEMPTS = 5;

function cancelStreamReconnect() {
	_streamReconnectAttempts = 0;
	if (_streamReconnectTimer != null) {
		clearTimeout(_streamReconnectTimer);
		_streamReconnectTimer = null;
	}
}

function reconnectStream(url: string, item: MediaItem) {
	cancelStreamReconnect();
	if (_streamReconnectAttempts >= STREAM_MAX_RECONNECT_ATTEMPTS) {
		return;
	}
	_streamReconnectAttempts++;
	const delay = Math.min(1000 * Math.pow(2, _streamReconnectAttempts - 1), 16000);
	_streamReconnectTimer = window.setTimeout(() => {
		if (_streamShouldPlay && mediaEngine.source === 'radio' && !mediaEngine.isPlaying) {
			mediaEngine.playStream(url, item);
		}
	}, delay);
}

function stopStreamAudio() {
	if (_streamAudio) {
		_streamAudio.pause();
		_streamAudio.src = '';
		_streamAudio.load();
		_streamAudio = null;
	}
}

function getAudioSlots(): [HTMLAudioElement, HTMLAudioElement] {
	if (typeof window === 'undefined') return [] as any;
	if (!_audioSlots) {
		_audioSlots = [new Audio(), new Audio()];
		_audioSlots.forEach((audio, i) => {
			audio.preload = 'metadata';
			audio.addEventListener('play', () => { if (i === _activeSlot && mediaEngine.source === 'music') mediaEngine.setPlaying(true); });
			audio.addEventListener('pause', () => { if (i === _activeSlot && mediaEngine.source === 'music') mediaEngine.setPlaying(false); });
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
				// MEDIA_ERR_SRC_NOT_SUPPORTED (4) is often a transient race on slot reuse —
				// don't show a toast for it since the actual playback element is unaffected
				if (err?.code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED) return;
				console.error(`Audio slot ${i} error:`, err?.code, err?.message);
				if (i === _activeSlot && mediaEngine.source === 'music') {
					mediaEngine.setPlaying(false);
					const msg = err ? describeAudioError(err) : 'Unknown playback error.';
					addToast({ message: msg, type: 'error' });
				}
			});
		});

		// Connect newly created slots to existing filter chain (when AudioContext was
		// already initialized, e.g. by an EQ preset change before any playback started)
		if (_audioCtx && _filters.length > 0) {
			_audioSlots.forEach(audio => {
				try {
					const src = _audioCtx!.createMediaElementSource(audio);
					src.connect(_filters[0]);
				} catch { /* already connected or unavailable */ }
			});
		}

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
	if (_audioCtx) return;
	try {
		_audioCtx = new AudioContext();

		// Auto-resume AudioContext when Android suspends it in background
		_audioCtx.addEventListener('statechange', () => {
			if (_audioCtx?.state === 'suspended' && mediaEngine.isPlaying) {
				void _audioCtx.resume().catch(() => {});
			}
		});
		
		// Create a shared filter chain
		_filters = createEqFilterChain(_audioCtx, mediaEngine.eqBands);
		_filters[_filters.length - 1].connect(_audioCtx.destination);

		// Connect audio slots if they exist (created before AudioContext init)
		if (_audioSlots) {
			_audioSlots.forEach(audio => {
				const src = _audioCtx!.createMediaElementSource(audio);
				src.connect(_filters[0]);
			});
		}
	} catch (e) {
		console.error('Failed to init global audio context:', e);
	}
}

export function updateGlobalEq(gains: number[]) {
	if (!_filters.length) initGlobalAudioContext();
	applyEqGains(_filters, gains);
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
			navigator.mediaSession.setActionHandler('play',          () => mediaEngine._onPlay?.() ?? mediaEngine.resume());
			navigator.mediaSession.setActionHandler('pause',         () => mediaEngine._onPause?.() ?? mediaEngine.pause());
			navigator.mediaSession.setActionHandler('stop',          () => mediaEngine._onPause?.() ?? mediaEngine.pause());
			navigator.mediaSession.setActionHandler('nexttrack',     () => mediaEngine._onNext?.() ?? mediaEngine.next());
			navigator.mediaSession.setActionHandler('previoustrack', () => mediaEngine._onPrev?.() ?? mediaEngine.prev());
			navigator.mediaSession.setActionHandler('seekto', (d) => {
				if (d.seekTime == null) return;
				mediaEngine._onSeek?.(d.seekTime) ?? mediaEngine.seek(d.seekTime);
			});
			navigator.mediaSession.setActionHandler('seekforward', (d) => {
				const nextTime = mediaEngine.currentTime + (d.seekOffset ?? 30);
				mediaEngine._onSeek?.(nextTime) ?? mediaEngine.seek(nextTime);
			});
			navigator.mediaSession.setActionHandler('seekbackward', (d) => {
				const nextTime = mediaEngine.currentTime - (d.seekOffset ?? 10);
				mediaEngine._onSeek?.(nextTime) ?? mediaEngine.seek(nextTime);
			});
		});
	});
}

// ─────────────────────────────────────────────────────────────────────────────
// WakeLock — keep CPU/WebView alive during background playback (Android)
// ─────────────────────────────────────────────────────────────────────────────
let _wakeLock: WakeLockSentinel | null = null;
let _wakelockReleaseTimer: number | null = null;

async function acquireWakeLock() {
	if (!('wakeLock' in navigator)) return;
	try {
		_wakeLock = await navigator.wakeLock.request('screen');
		_wakeLock.addEventListener('release', () => {
			// Re-acquire if still playing
			if (mediaEngine.isPlaying && _wakelockReleaseTimer == null) {
				_wakelockReleaseTimer = window.setTimeout(() => {
					_wakelockReleaseTimer = null;
					void acquireWakeLock();
				}, 200);
			}
		});
	} catch {
		// WakeLock may be denied by browser policy
	}
}

async function releaseWakeLock() {
	if (_wakelockReleaseTimer != null) {
		clearTimeout(_wakelockReleaseTimer);
		_wakelockReleaseTimer = null;
	}
	if (_wakeLock) {
		try { await _wakeLock.release(); } catch { /* already released */ }
		_wakeLock = null;
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Capacitor Native Media Controls Integration
// ─────────────────────────────────────────────────────────────────────────────
if (typeof window !== 'undefined' && Capacitor.isNativePlatform()) {
	$effect.root(() => {
		let mediaActionHandle: Promise<{ remove: () => Promise<void> }> | null = null;
		let backgroundResumeTimer: number | null = null;
		let backgroundResumeArmed = false;
		let backgroundResumeAttempts = 0;

		const clearBackgroundResume = () => {
			backgroundResumeArmed = false;
			backgroundResumeAttempts = 0;
			if (backgroundResumeTimer != null) {
				window.clearTimeout(backgroundResumeTimer);
				backgroundResumeTimer = null;
			}
		};

		const tryResumeAfterBackgroundPause = () => {
			backgroundResumeTimer = null;
			if (!backgroundResumeArmed || mediaEngine.item == null) return;
			if (mediaEngine.isPlaying) {
				clearBackgroundResume();
				return;
			}

			mediaEngine._onPlay?.() ?? mediaEngine.resume();
			backgroundResumeAttempts += 1;
			if (backgroundResumeAttempts < 4) {
				backgroundResumeTimer = window.setTimeout(tryResumeAfterBackgroundPause, 250);
			}
		};

		const handleDocumentPause = () => {
			if (Capacitor.getPlatform() !== 'android') return;
			if (!mediaEngine.isPlaying || mediaEngine.item == null) {
				clearBackgroundResume();
				return;
			}

			backgroundResumeArmed = true;
			backgroundResumeAttempts = 0;
			if (backgroundResumeTimer != null) {
				window.clearTimeout(backgroundResumeTimer);
			}
			backgroundResumeTimer = window.setTimeout(tryResumeAfterBackgroundPause, 180);
		};

		const handleDocumentResume = () => {
			if (backgroundResumeArmed && mediaEngine.item != null && !mediaEngine.isPlaying) {
				mediaEngine._onPlay?.() ?? mediaEngine.resume();
			}
			clearBackgroundResume();
		};

		document.addEventListener('pause', handleDocumentPause);
		document.addEventListener('resume', handleDocumentResume);

		$effect(() => {
			mediaActionHandle = MediaControls.addListener('mediaAction', (event) => {
				switch (event.action) {
					case 'play':          mediaEngine._onPlay?.() ?? mediaEngine.resume(); break;
					case 'pause':         mediaEngine._onPause?.() ?? mediaEngine.pause();  break;
					case 'nexttrack':     mediaEngine._onNext?.() ?? mediaEngine.next();    break;
					case 'previoustrack': mediaEngine._onPrev?.() ?? mediaEngine.prev();    break;
					case 'seekto':
						if (event.positionSec != null) {
							mediaEngine._onSeek?.(event.positionSec) ?? mediaEngine.seek(event.positionSec);
						}
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

		// WakeLock: acquire when playing, release when paused
		$effect(() => {
			if (mediaEngine.isPlaying) {
				void acquireWakeLock();
			} else {
				void releaseWakeLock();
			}
		});

		return () => {
			clearBackgroundResume();
			cancelStreamReconnect();
			void releaseWakeLock();
			document.removeEventListener('pause', handleDocumentPause);
			document.removeEventListener('resume', handleDocumentResume);
		};
	});
}
