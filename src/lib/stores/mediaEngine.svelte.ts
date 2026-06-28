/**
 * Global media engine — shared now-playing state hub across Music, Podcast,
 * Radio, and the Mixer.
 *
 * The engine does NOT own any <audio> element. Each view drives its own audio
 * element and reports state here via setNowPlaying()/updateTime() and the
 * per-source playing flags. The engine exists so the MiniPlayer, the browser
 * MediaSession, and the native Android MediaControls can observe a single
 * source of truth for what is playing, who owns it, and the transport
 * (play/pause/seek/skip) handlers of the active source.
 *
 * Audio exclusivity is enforced via registerAudioSource()/claimAudio(): each
 * source registers a stop-callback; starting a new source claims audio, which
 * invokes every other source's stop-callback so only one plays at a time.
 */

import { Capacitor } from '@capacitor/core';
import type { MediaItem, MediaSource } from '$lib/models/media';
import { MediaControls } from '$lib/native/media-controls';
import { addToast } from './toastStore.svelte';

// ─────────────────────────────────────────────────────────────────────────────
// Audio exclusivity — only one source (music / podcast / radio / mixer) plays
// at a time. Views register a stop-callback; calling claimAudio pauses the
// others. Radio is special-cased: its stream lives in _streamAudio (below),
// which claimAudio tears down directly for non-radio claims.
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
	/** Derived: true when ANY source is actively playing. Read-only — each source
	 *  owns its own flag (musicPlaying/podcastPlaying/radioPlaying/mixerPlaying)
	 *  so a stale async 'pause'/'error' event from a just-stopped source can never
	 *  clobber another source's playing state (the Android WebView race that
	 *  caused radio/podcast/MP3 to stop immediately after starting). */
	readonly isPlaying: boolean;
	currentTime: number;    // seconds
	duration:    number;    // seconds
	source:      MediaSource | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Reactive state — read anywhere via `import { mediaEngine } from …`
// ─────────────────────────────────────────────────────────────────────────────
export const mediaEngine = $state<NowPlayingState & {
	// --- Per-source playing flags (isPlaying is derived from these) ---
	musicPlaying:   boolean;
	podcastPlaying: boolean;
	radioPlaying:   boolean;
	mixerPlaying:   boolean;

	// --- Transport fallbacks ---
	// Views register handlers via setPlaybackHandlers()/setSkipHandlers() so the
	// MiniPlayer, MediaSession, and native MediaControls can drive the active
	// source. The bare methods below are last-resort fallbacks used only when no
	// handler is registered; for radio they operate on _streamAudio, otherwise
	// they no-op (no engine-owned audio element exists for music/podcast/mixer).
	pause(): void;
	resume(): void;
	next(): void;
	prev(): void;
	seek(time: number): void;

	// --- Internal Hookups (called by view audio listeners) ---
	updateTime(currentTime: number, duration: number): void;
	/** Full reset: null now-playing state, stop the radio stream, clear all
	 *  playing flags. Use for explicit stop / unmount — NOT for source switches,
	 *  where nulling `item` would tear down the foreground MediaSession service
	 *  and immediately rebuild it, churning that dispatches a pause to the
	 *  just-started source (the Android 'stops immediately' bug). For a source
	 *  switch, use stopStream() (radio audio only, state preserved). */
	clear(): void;
	/** Metadata-only update — sets now-playing info without starting audio. */
	setNowPlaying(item: MediaItem, source: MediaSource): void;

	// ─── Live stream playback (radio) ───
	_streamError: ((err: MediaError | null) => void) | null;
	_streamWaiting: (() => void) | null;
	_streamPlaying: (() => void) | null;
	_streamEnded: (() => void) | null;
	playStream(url: string, item: MediaItem): void;
	pauseStream(): void;
	resumeStream(): void;
	stopStream(): void;
	setStreamCallbacks(error: (err: MediaError | null) => void, waiting: () => void, playing: () => void, ended?: () => void): void;

	// --- Callbacks for views to override transport behavior ---
	_onPlay: (() => void) | null;
	_onPause: (() => void) | null;
	_onSeek: ((time: number) => void) | null;
	_onNext: (() => void) | null;
	_onPrev: (() => void) | null;
	setPlaybackHandlers(play: (() => void) | null, pause: (() => void) | null, seek: ((time: number) => void) | null): void;
	setSkipHandlers(next: (() => void) | null, prev: (() => void) | null): void;
}>({
	item:        null,
	musicPlaying:   false,
	podcastPlaying: false,
	radioPlaying:   false,
	mixerPlaying:   false,
	get isPlaying(): boolean {
		// Derived from per-source flags. Exclusivity means at most one is true at a
		// time, but a stale async 'pause' from a just-stopped source may still be in
		// flight — reading it only flips ITS flag, never the active source's.
		return this.musicPlaying || this.podcastPlaying || this.radioPlaying || this.mixerPlaying;
	},
	currentTime: 0,
	duration:    0,
	source:      null,

	_onPlay: null,
	_onPause: null,
	_onSeek: null,
	_onNext: null,
	_onPrev: null,

	/** Last-resort pause fallback. Radio is engine-owned (_streamAudio); other
	 *  sources own their own <audio> element and must register a _onPause handler. */
	pause() {
		if (this.source === 'radio' && _streamAudio) {
			_streamAudio.pause();
			this.radioPlaying = false;
		}
	},

	/** Last-resort resume fallback. Radio only; other sources need _onPlay. */
	resume() {
		if (this.source === 'radio' && _streamAudio) {
			resumeStreamAudio(this);
		}
	},

	/** No engine-owned queue — next/prev delegate entirely to the active source's
	 *  registered _onNext/_onPrev. No-op if unset. */
	next() {
		this._onNext?.();
	},

	prev() {
		this._onPrev?.();
	},

	/** Last-resort seek fallback. Radio has no seek (live); other sources need _onSeek. */
	seek(_time: number) {
		// No engine-owned audio element to seek for non-radio sources.
	},

	updateTime(currentTime: number, duration: number) {
		this.currentTime = currentTime;
		if (duration > 0) this.duration = duration;
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

	/** Metadata-only: update now-playing state without starting audio. */
	setNowPlaying(item: MediaItem, source: MediaSource) {
		this.item = item;
		this.source = source;
		this.currentTime = 0;
		this.duration = item.duration ?? 0;
	},

	clear() {
		cancelStreamReconnect();
		stopStreamAudio();
		this.item = null;
		this.musicPlaying = false;
		this.podcastPlaying = false;
		this.radioPlaying = false;
		this.mixerPlaying = false;
		this.currentTime = 0;
		this.duration = 0;
		this.source = null;
	},

	// ─── Live stream playback (radio) ────────────────────────────────────
	_streamError: null as ((err: MediaError | null) => void) | null,
	_streamWaiting: null as (() => void) | null,
	_streamPlaying: null as (() => void) | null,
	_streamEnded: null as (() => void) | null,

	/** Begin playing a live stream URL through a dedicated audio element. */
	playStream(url: string, item: MediaItem) {
		claimAudio('radio');
		_streamShouldPlay = true;
		// Route MiniPlayer / web mediaSession / native transport controls to the live
		// stream so pause/resume act on _streamAudio instead of a no-op fallback.
		this.setPlaybackHandlers(
			() => this.resumeStream(),
			() => this.pauseStream(),
			null,
		);
		stopStreamAudio();
		_streamAudio = new Audio();
		_streamAudio.preload = 'none';

		_streamAudio.addEventListener('play', () => { this.radioPlaying = true; this._streamPlaying?.(); });
		_streamAudio.addEventListener('pause', () => { this.radioPlaying = false; });
		_streamAudio.addEventListener('waiting', () => { this._streamWaiting?.(); });
		_streamAudio.addEventListener('playing', () => { this._streamPlaying?.(); });
		_streamAudio.addEventListener('error', () => {
			this.radioPlaying = false;
			this._streamError?.(_streamAudio?.error ?? null);
		});
		_streamAudio.addEventListener('ended', () => {
			// Stream ended unexpectedly (server disconnect / Android resource kill).
			// Only auto-reconnect if the user still wants playback — a deliberate pause
			// can also surface as 'ended' on live streams and must NOT restart audio.
			this.radioPlaying = false;
			this._streamEnded?.();
			if (_streamShouldPlay) reconnectStream(url, item);
		});

		_streamReconnectUrl = url;
		_streamReconnectItem = item;
		this.item = item;
		this.source = 'radio';
		this.duration = 0;

		// NOTE: Cross-origin streams (radio) CANNOT be processed by the Web Audio
		// API — the browser outputs SILENCE for tainted cross-origin media unless
		// the server sends CORS headers. So we play streams DIRECTLY (no EQ).
		_streamAudio.src = url;
		_streamAudio.play().catch((err) => {
			if (err?.name !== 'AbortError') this.radioPlaying = false;
		});
	},

	/** Pause the live stream without tearing down the audio element. */
	pauseStream() {
		// User intent = paused: cancel any pending reconnect so the stream stays stopped.
		_streamShouldPlay = false;
		cancelStreamReconnect();
		if (_streamAudio) {
			_streamAudio.pause();
			this.radioPlaying = false;
		}
	},

	/** Resume the live stream if paused. */
	resumeStream() {
		if (_streamAudio && this.source === 'radio') {
			resumeStreamAudio(this);
		}
	},

	/** Stop the live stream's audio without resetting now-playing state.
	 *  Safe to call during a source switch: the radioPlaying flag is cleared by
	 *  the stream's 'pause' event, and `item`/`source` are left untouched so the
	 *  incoming source's setNowPlaying() simply overwrites them — no
	 *  MediaControls.clear() blip, no foreground-service teardown/rebuild. */
	stopStream() {
		_streamShouldPlay = false;
		cancelStreamReconnect();
		stopStreamAudio();
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
// Radio live-stream internals
// ─────────────────────────────────────────────────────────────────────────────
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

/** Shared resume logic for the live stream (used by resume() and resumeStream()). */
function resumeStreamAudio(engine: typeof mediaEngine) {
	_streamShouldPlay = true;
	_streamAudio!.play().catch(() => {});
	engine.radioPlaying = true;
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
			// Transport availability is driven entirely by the active source's
			// registered _onNext/_onPrev handlers (the engine owns no queue).
			void MediaControls.setTransportAvailability({
				hasNext: mediaEngine._onNext !== null,
				hasPrevious: mediaEngine._onPrev !== null,
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
