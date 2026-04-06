/**
 * Shared Audio Service — single <audio> element for the entire app.
 *
 * All views delegate playback to this service instead of managing their own
 * <audio> elements. This automatically enforces audio exclusivity (only one
 * source plays at a time) and provides a single reactive state surface for
 * the MiniPlayer, MediaSession, and lock-screen controls.
 *
 * Usage:
 *   import { audioService } from '$lib/stores/audioService.svelte';
 *   audioService.load(item, 'podcast', 30);   // load + seek to 30s
 *   audioService.play();
 *   audioService.pause();
 */

import type { MediaItem, MediaSource } from '$lib/models/media';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface AudioError {
	code: number;
	message: string;
}

export interface OnEndedCallback {
	(): void;
}

// ─────────────────────────────────────────────────────────────────────────────
// Blob URL tracker — revokes previous URLs to prevent memory leaks
// ─────────────────────────────────────────────────────────────────────────────

const trackedUrls = new Set<string>();

function trackUrl(url: string): void {
	if (url.startsWith('blob:')) trackedUrls.add(url);
}

function revokeUrl(url: string): void {
	if (trackedUrls.has(url)) {
		URL.revokeObjectURL(url);
		trackedUrls.delete(url);
	}
}

function revokeAllUrls(): void {
	for (const url of trackedUrls) {
		URL.revokeObjectURL(url);
	}
	trackedUrls.clear();
}

// ─────────────────────────────────────────────────────────────────────────────
// Error code → human-readable message mapping
// ─────────────────────────────────────────────────────────────────────────────

function describeAudioError(el: HTMLAudioElement): AudioError {
	const err = el.error;
	if (!err) return { code: 0, message: 'Unknown playback error.' };
	switch (err.code) {
		case MediaError.MEDIA_ERR_ABORTED:
			return { code: err.code, message: 'Playback was interrupted.' };
		case MediaError.MEDIA_ERR_NETWORK:
			return { code: err.code, message: 'A network error caused playback to fail. Check your connection.' };
		case MediaError.MEDIA_ERR_DECODE:
			return { code: err.code, message: 'The audio file could not be decoded.' };
		case MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED:
			return { code: err.code, message: 'This audio format is not supported.' };
		default:
			return { code: err.code, message: err.message || 'Unknown playback error.' };
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// The Service
// ─────────────────────────────────────────────────────────────────────────────

function createAudioService() {
	// ── Internal element ─────────────────────────────────────────
	let audioEl: HTMLAudioElement | null = null;
	let previousBlobUrl: string | null = null;
	let pendingSeek: number | null = null;
	let metadataLoaded = false;

	// ── Reactive state ───────────────────────────────────────────
	let isPlaying   = $state(false);
	let isBuffering = $state(false);
	let currentTime = $state(0);
	let duration    = $state(0);
	let error       = $state<AudioError | null>(null);
	let source      = $state<MediaSource | null>(null);
	let currentItem = $state<MediaItem | null>(null);

	// ── Callbacks that views can register ────────────────────────
	let _onEnded: OnEndedCallback | null = null;
	let _onTimeUpdate: ((time: number, dur: number) => void) | null = null;
	let _onError: ((err: AudioError) => void) | null = null;

	// Throttle timeupdate to ~4 Hz
	let _lastTimeUpdate = 0;

	// ── Audio element lifecycle ──────────────────────────────────
	function ensureAudioElement(): HTMLAudioElement {
		if (audioEl) return audioEl;
		audioEl = new Audio();
		audioEl.preload = 'metadata';

		audioEl.addEventListener('loadedmetadata', handleLoadedMetadata);
		audioEl.addEventListener('timeupdate', handleTimeUpdate);
		audioEl.addEventListener('play', handlePlay);
		audioEl.addEventListener('pause', handlePause);
		audioEl.addEventListener('ended', handleEnded);
		audioEl.addEventListener('error', handleError);
		audioEl.addEventListener('waiting', handleWaiting);
		audioEl.addEventListener('playing', handlePlaying);

		return audioEl;
	}

	// ── Event handlers ───────────────────────────────────────────
	function handleLoadedMetadata(): void {
		if (!audioEl) return;
		metadataLoaded = true;
		duration = isFinite(audioEl.duration) ? audioEl.duration : 0;
		error = null;

		// Execute pending seek that was requested before metadata loaded
		if (pendingSeek !== null && pendingSeek > 0) {
			audioEl.currentTime = pendingSeek;
			currentTime = pendingSeek;
			pendingSeek = null;
		}
	}

	function handleTimeUpdate(): void {
		if (!audioEl) return;
		const now = Date.now();
		if (now - _lastTimeUpdate < 250) return;
		_lastTimeUpdate = now;
		currentTime = audioEl.currentTime;
		duration = isFinite(audioEl.duration) ? audioEl.duration : duration;
		_onTimeUpdate?.(audioEl.currentTime, audioEl.duration);
	}

	function handlePlay(): void {
		isPlaying = true;
		isBuffering = false;
		error = null;
	}

	function handlePause(): void {
		isPlaying = false;
	}

	function handleEnded(): void {
		isPlaying = false;
		isBuffering = false;
		_onEnded?.();
	}

	function handleError(): void {
		if (!audioEl) return;
		const audioError = describeAudioError(audioEl);
		// Ignore errors when src is empty (happens during cleanup)
		if (!audioEl.src || audioEl.src === 'about:blank' || audioEl.src === window.location.href) return;
		error = audioError;
		isBuffering = false;
		isPlaying = false;
		_onError?.(audioError);
	}

	function handleWaiting(): void {
		isBuffering = true;
	}

	function handlePlaying(): void {
		isBuffering = false;
	}

	// ── Cleanup previous source ──────────────────────────────────
	function cleanupPreviousSource(): void {
		if (previousBlobUrl) {
			revokeUrl(previousBlobUrl);
			previousBlobUrl = null;
		}
	}

	// ── Public API ───────────────────────────────────────────────
	return {
		// Reactive getters
		get isPlaying()   { return isPlaying; },
		get isBuffering() { return isBuffering; },
		get currentTime() { return currentTime; },
		get duration()    { return duration; },
		get error()       { return error; },
		get source()      { return source; },
		get currentItem() { return currentItem; },

		/**
		 * Load a new media item. Stops any currently playing source.
		 * If `startAt` is provided, seeks to that position once metadata is loaded.
		 * The `audioUrl` on the item is set on the audio element's src.
		 * For blob URLs, pass them as `item.audioUrl` — the service will track them
		 * for revocation on the next `load()` or `stop()`.
		 */
		async load(item: MediaItem, src: MediaSource, startAt?: number): Promise<void> {
			const el = ensureAudioElement();

			// Stop current playback cleanly
			el.pause();
			cleanupPreviousSource();

			// Reset state
			isPlaying = false;
			isBuffering = true;
			currentTime = startAt ?? 0;
			duration = item.duration ?? 0;
			error = null;
			source = src;
			currentItem = item;
			metadataLoaded = false;
			pendingSeek = startAt ?? null;

			// Track blob URL for cleanup
			if (item.audioUrl.startsWith('blob:')) {
				trackUrl(item.audioUrl);
				previousBlobUrl = item.audioUrl;
			} else {
				previousBlobUrl = null;
			}

			// Set source
			el.src = item.audioUrl;
			el.load();
		},

		async play(): Promise<void> {
			const el = ensureAudioElement();
			if (!el.src || el.src === 'about:blank') return;
			try {
				await el.play();
			} catch (e: unknown) {
				// AbortError is expected when play() is interrupted by a new load/pause call
				if (e instanceof DOMException && e.name === 'AbortError') return;
				const msg = e instanceof Error ? e.message : 'Playback failed.';
				error = { code: -1, message: msg };
				_onError?.(error);
			}
		},

		pause(): void {
			audioEl?.pause();
		},

		seek(seconds: number): void {
			if (!audioEl) return;
			const clamped = Math.max(0, Math.min(seconds, audioEl.duration || Infinity));
			if (metadataLoaded) {
				audioEl.currentTime = clamped;
				currentTime = clamped;
			} else {
				// Queue seek for after metadata loads
				pendingSeek = clamped;
				currentTime = clamped;
			}
		},

		stop(): void {
			if (!audioEl) return;
			audioEl.pause();
			audioEl.removeAttribute('src');
			audioEl.load(); // resets the element
			cleanupPreviousSource();

			isPlaying = false;
			isBuffering = false;
			currentTime = 0;
			duration = 0;
			error = null;
			source = null;
			currentItem = null;
			metadataLoaded = false;
			pendingSeek = null;
		},

		setPlaybackRate(rate: number): void {
			if (audioEl) audioEl.playbackRate = rate;
		},

		/**
		 * Access the underlying <audio> element for advanced use cases
		 * like AudioContext / EQ binding. Do NOT set .src directly.
		 */
		getAudioElement(): HTMLAudioElement {
			return ensureAudioElement();
		},

		/**
		 * Register a callback for when the current track ends.
		 * Returns an unsubscribe function.
		 */
		onEnded(callback: OnEndedCallback): () => void {
			_onEnded = callback;
			return () => { if (_onEnded === callback) _onEnded = null; };
		},

		/**
		 * Register a callback for time updates (~4Hz throttled).
		 * Returns an unsubscribe function.
		 */
		onTimeUpdate(callback: (time: number, dur: number) => void): () => void {
			_onTimeUpdate = callback;
			return () => { if (_onTimeUpdate === callback) _onTimeUpdate = null; };
		},

		/**
		 * Register a callback for audio errors.
		 * Returns an unsubscribe function.
		 */
		onError(callback: (err: AudioError) => void): () => void {
			_onError = callback;
			return () => { if (_onError === callback) _onError = null; };
		},

		/**
		 * Clean up everything. Call on app shutdown.
		 */
		destroy(): void {
			if (audioEl) {
				audioEl.pause();
				audioEl.removeAttribute('src');
				audioEl.removeEventListener('loadedmetadata', handleLoadedMetadata);
				audioEl.removeEventListener('timeupdate', handleTimeUpdate);
				audioEl.removeEventListener('play', handlePlay);
				audioEl.removeEventListener('pause', handlePause);
				audioEl.removeEventListener('ended', handleEnded);
				audioEl.removeEventListener('error', handleError);
				audioEl.removeEventListener('waiting', handleWaiting);
				audioEl.removeEventListener('playing', handlePlaying);
				audioEl = null;
			}
			revokeAllUrls();
			isPlaying = false;
			isBuffering = false;
			currentTime = 0;
			duration = 0;
			error = null;
			source = null;
			currentItem = null;
			_onEnded = null;
			_onTimeUpdate = null;
			_onError = null;
		}
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// Singleton export — use everywhere via audioService.*
// ─────────────────────────────────────────────────────────────────────────────
export const audioService = createAudioService();
