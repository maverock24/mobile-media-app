/**
 * player.ts — the playback core behind a deck.
 *
 * A deep module: a large amount of playback behaviour (the queue, the audio
 * element, advance/preload/retry/loop, error recovery) behind a small Design-C
 * interface. See CONTEXT.md ("player", "deck") and docs/adr/0001-player-module.md.
 *
 * The module owns the HTMLAudioElement and the reactive `state`. URL resolution
 * is injected as a seam so the module never knows about Drive auth, Capacitor,
 * or object-URL creation. Tests inject a fake element and a fake resolver.
 */
import { untrack } from 'svelte';
import {
	getNextTrackIndex,
	parseFilename,
	sortFiles,
	getTrackKey,
	type StoredAudioFile,
} from '$lib/models/music';

export interface PlayerTrack {
	id: number;
	title: string;
	artist: string;
	filename: string;
	url: string;
	duration: number;
	cleanup?: () => void;
	source: StoredAudioFile;
}

export interface PlayerState {
	tracks: PlayerTrack[];
	currentIndex: number;
	isPlaying: boolean;
	isBuffering: boolean;
	currentTime: number;
	duration: number;
	error: string | null;
}

/** Reactive view of the shared settings the player reads/writes. */
export interface PlayerSettings {
	lastTrackIndex: number;
	lastTrackKey: string;
	lastTrackTimestamp: number;
	isRepeat: boolean;
	isShuffle: boolean;
	rewindOnPrev: boolean;
	sortOrder: string;
}

/** Reactive per-deck element controls (volume/speed differ between decks). */
export interface PlayerControls {
	volume: number;     // 0-100
	muted: boolean;
	playbackRate: number;
}

export interface PlayerOptions {
	/** Reactive musicSettings — the module reads/writes the fields it needs. */
	settings: PlayerSettings;
	/** URL seam: resolve a source to a playable URL (injected adapter). */
	resolveUrl: (source: StoredAudioFile, interactiveAuth?: boolean) => Promise<string | null>;
	/** Reactive per-deck element controls (volume, mute, speed). */
	controls?: PlayerControls;
	/** Optional element factory for tests. Defaults to `new Audio()`. */
	createAudio?: () => HTMLAudioElement;
	/** Force native retry/timeout semantics (Capacitor). Defaults to false. */
	native?: boolean;
	/** Apply equalizer gains to a fresh AudioContext for the element. Optional. */
	applyEqualizer?: (audio: HTMLAudioElement) => void;
}

export interface Player {
	state: PlayerState;
	play(tracks: StoredAudioFile[], startIndex?: number, options?: { selectionLoop?: boolean }): Promise<void>;
	pause(): void;
	resume(): void;
	next(): void;
	prev(): void;
	seek(toSec: number): void;
	destroy(): void;
}

const THROTTLE_MS = 250;

export function createPlayer(opts: PlayerOptions): Player {
	const native = opts.native ?? false;
	const settings = opts.settings;

	const state = $state<PlayerState>({
		tracks: [],
		currentIndex: -1,
		isPlaying: false,
		isBuffering: false,
		currentTime: 0,
		duration: 0,
		error: null,
	});

	const audio: HTMLAudioElement = opts.createAudio ? opts.createAudio() : new Audio();

	let selectionLoop = false;
	let preloadedIndex: number | null = null;
	let preloadRequestId = 0;
	let errorRetries = 0;
	let seeking: number | null = null;
	let lastTimeUpdate = 0;
	let changingTrack = false;
	let destroyed = false;

	// ── safePlay: retry play() on AbortError / timeout / sync throw, and on
	//    native force-reload the src after retries are exhausted. ──────────────
	function safePlay(onFailure?: () => void, onSuccess?: () => void) {
		const maxRetries = native ? 8 : 3;
		const retryDelayMs = native ? 300 : 150;
		const playTimeoutMs = native ? 4000 : 0;

		const tryPlay = (attempt: number) => {
			if (destroyed) return;
			let promise: Promise<void>;
			try {
				promise = audio.play();
			} catch {
				if (attempt < maxRetries) setTimeout(() => tryPlay(attempt + 1), retryDelayMs);
				else onFailure?.();
				return;
			}
			const timeoutPromise = playTimeoutMs > 0
				? new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), playTimeoutMs))
				: null;
			const race = timeoutPromise
				? Promise.race([promise.then(() => 'ok' as const), timeoutPromise])
				: promise.then(() => 'ok' as const);
			race.then((result) => {
				if (destroyed) return;
				if (result === 'ok') { onSuccess?.(); return; }
				if (attempt < maxRetries) setTimeout(() => tryPlay(attempt + 1), retryDelayMs);
				else onFailure?.();
			}).catch((err: Error) => {
				if (destroyed) return;
				const shouldRetry = native
					? attempt < maxRetries
					: err?.name === 'AbortError' && attempt < maxRetries;
				if (shouldRetry) setTimeout(() => tryPlay(attempt + 1), retryDelayMs);
				else onFailure?.();
			});
		};
		tryPlay(0);
	}

	function setCurrentTrack(index: number) {
		state.currentIndex = index;
		settings.lastTrackIndex = index;
		settings.lastTrackKey = state.tracks[index] ? getTrackKey(state.tracks[index].source) : '';
	}

	async function ensureUrl(index: number, interactiveAuth: boolean): Promise<string | null> {
		const track = state.tracks[index];
		if (!track) return null;
		if (track.url) return track.url;
		try {
			const url = await opts.resolveUrl(track.source, interactiveAuth);
			if (url && !destroyed) {
				state.tracks = state.tracks.map((t, i) => (i === index ? { ...t, url } : t));
			}
			return url;
		} catch (err) {
			state.error = err instanceof Error ? err.message : 'Failed to load track.';
			return null;
		}
	}

	function releaseUrl(index: number) {
		const track = state.tracks[index];
		if (track?.cleanup) { try { track.cleanup(); } catch { /* noop */ } }
		if (track) {
			state.tracks = state.tracks.map((t, i) => (i === index ? { ...t, url: '', cleanup: undefined } : t));
		}
	}

	function revokeAll() {
		for (let i = 0; i < state.tracks.length; i++) releaseUrl(i);
	}

	// ── queue advance ─────────────────────────────────────────────────────────
	function nextIndex(from: number): number | null {
		return getNextTrackIndex(from, {
			trackCount: state.tracks.length,
			isShuffle: settings.isShuffle,
			isRepeat: settings.isRepeat,
			selectionLoop,
			preloadedIndex,
		});
	}

	function preloadNextTrack(from: number) {
		const next = nextIndex(from);
		const requestId = ++preloadRequestId;
		if (next === null || !state.tracks[next] || next === from) {
			preloadedIndex = null;
			return;
		}
		preloadedIndex = next;
		if (state.tracks[next].url) return;
		void ensureUrl(next, false).then(() => {
			if (requestId !== preloadRequestId) return;
			if (!state.tracks[next]?.url) preloadedIndex = null;
		});
	}

	function loadAndPlayAt(index: number, wasPlaying: boolean, interactiveAuth: boolean) {
		if (!audio || !state.tracks[index]) return;
		void (async () => {
			const url = await ensureUrl(index, interactiveAuth);
			if (!url) return;
			opts.applyEqualizer?.(audio);
			audio.src = url;
			preloadNextTrack(index);
			if (wasPlaying) {
				state.isBuffering = true;
				safePlay(() => { state.isBuffering = false; state.isPlaying = false; });
			}
		})();
	}

	async function advanceTrack(wasPlaying: boolean) {
		if (changingTrack || state.tracks.length === 0 || destroyed) return;
		changingTrack = true;
		try {
			const idx = state.currentIndex;
			const next = nextIndex(idx);
			if (next === null) { stop(); return; }

			// Same-track loop (single selected track).
			if (next === idx) {
				setCurrentTrack(next);
				state.currentTime = 0;
				settings.lastTrackTimestamp = 0;
				if (audio.error) {
					const url = state.tracks[next]?.url;
					if (url) { audio.src = ''; audio.src = url; }
				} else {
					audio.currentTime = 0;
				}
				if (wasPlaying) { state.isBuffering = false; safePlay(() => { state.isPlaying = false; }); }
				return;
			}

			setCurrentTrack(next);
			settings.lastTrackTimestamp = 0;
			state.currentTime = 0; state.duration = 0;
			if (audio && state.tracks[next]) {
				// Auto-skip broken tracks until a playable one is found.
				let attemptIndex = next;
				let attemptCount = 0;
				const maxAttempts = state.tracks.length;
				let foundUrl: string | null = null;
				while (attemptCount < maxAttempts) {
					const url = await ensureUrl(attemptIndex, false);
					if (url) { foundUrl = url; break; }
					const nextAttempt = nextIndex(attemptIndex);
					if (nextAttempt === null || nextAttempt === next) break;
					attemptIndex = nextAttempt;
					attemptCount++;
				}
				if (!foundUrl) { stop(); return; }
				if (attemptIndex !== next) setCurrentTrack(attemptIndex);
				releaseUrl(idx);
				opts.applyEqualizer?.(audio);
				audio.src = foundUrl;
				preloadNextTrack(attemptIndex);
				state.isBuffering = true;
				safePlay(() => { state.isBuffering = false; state.isPlaying = false; });
			}
		} finally {
			changingTrack = false;
		}
	}

	function stop() {
		state.isPlaying = false;
		state.isBuffering = false;
		state.currentTime = 0;
		audio.pause();
		audio.currentTime = 0;
	}

	// ── audio element events ──────────────────────────────────────────────────
	audio.addEventListener('timeupdate', () => {
		if (seeking !== null) return;
		const now = Date.now();
		if (now - lastTimeUpdate < THROTTLE_MS) return;
		lastTimeUpdate = now;
		state.currentTime = audio.currentTime;
	});
	audio.addEventListener('loadedmetadata', () => {
		const d = isFinite(audio.duration) ? audio.duration : 0;
		state.duration = d;
		const i = state.currentIndex;
		if (i >= 0 && state.tracks[i]) {
			state.tracks = state.tracks.map((t, idx) => idx === i ? { ...t, duration: Math.round(d) } : t);
		}
	});
	audio.addEventListener('play', () => { state.isPlaying = true; state.isBuffering = false; errorRetries = 0; });
	audio.addEventListener('pause', () => { state.isPlaying = false; settings.lastTrackTimestamp = 0; });
	audio.addEventListener('ended', () => {
		state.isBuffering = false;
		settings.lastTrackTimestamp = 0;
		if (settings.isRepeat && !selectionLoop) {
			// repeat-one: rewind the same track.
			audio.currentTime = 0;
			safePlay();
		} else {
			void advanceTrack(true);
		}
	});
	audio.addEventListener('waiting', () => { state.isBuffering = true; });
	audio.addEventListener('playing', () => { state.isBuffering = false; });
	audio.addEventListener('error', () => {
		state.isBuffering = false;
		settings.lastTrackTimestamp = 0;
		if (errorRetries < 1 && state.tracks.length > 0) {
			errorRetries += 1;
			const idx = state.currentIndex;
			const url = state.tracks[idx]?.url;
			if (audio && url) {
				audio.src = '';
				audio.src = url;
				safePlay(() => { errorRetries = 0; state.isPlaying = false; void advanceTrack(true); });
				return;
			}
		}
		errorRetries = 0;
		void advanceTrack(true);
	});

	// Reactive sync of per-deck element controls. Wrapped in $effect.root so it
	// works when createPlayer is called outside a component (e.g. in tests).
	let controlsRoot: (() => void) | null = null;
	controlsRoot = $effect.root(() => {
		$effect(() => {
			const controls = opts.controls;
			if (!controls) return;
			untrack(() => {
				audio.volume = controls.volume / 100;
				audio.muted = controls.muted;
				audio.playbackRate = controls.playbackRate;
			});
		});
	});

	// ── public interface (Design C) ───────────────────────────────────────────
	return {
		state,
		async play(tracks, startIndex = 0, options = {}) {
			audio.pause(); audio.src = '';
			revokeAll();
			preloadRequestId += 1;
			const sorted = options.selectionLoop ? tracks : sortFiles(tracks, settings.sortOrder);
			state.tracks = sorted.map((f, i) => {
				const { title, artist } = parseFilename(f.name);
				return { id: i, title, artist, filename: f.name, url: '', duration: 0, source: f };
			});
			selectionLoop = options.selectionLoop ?? false;
			state.currentIndex = -1;
			state.currentTime = 0; state.duration = 0; state.isPlaying = false; state.isBuffering = false;
			state.error = null;
			errorRetries = 0;
			preloadedIndex = null;

			if (state.tracks.length === 0) return;
			const index = Math.max(0, Math.min(startIndex, state.tracks.length - 1));
			const url = await ensureUrl(index, true);
			if (!url) { state.error = 'Unable to load this track.'; return; }
			setCurrentTrack(index);
			settings.lastTrackTimestamp = 0;
			opts.applyEqualizer?.(audio);
			audio.src = url;
			preloadNextTrack(index);
			state.isBuffering = true;
			safePlay(() => { state.isBuffering = false; state.isPlaying = false; });
		},
		pause() { audio.pause(); },
		resume() { safePlay(); },
		next() { void advanceTrack(state.isPlaying || state.isBuffering); },
		prev() {
			if (state.tracks.length === 0) return;
			if (settings.rewindOnPrev && audio.currentTime > 3) {
				audio.currentTime = 0;
				safePlay();
				return;
			}
			const oldIndex = state.currentIndex < 0 ? 0 : state.currentIndex;
			const prevIndex = (oldIndex - 1 + state.tracks.length) % state.tracks.length;
			const wasPlaying = state.isPlaying || state.isBuffering;
			setCurrentTrack(prevIndex);
			settings.lastTrackTimestamp = 0;
			state.currentTime = 0; state.duration = 0;
			loadAndPlayAt(prevIndex, wasPlaying, true);
		},
		seek(toSec) {
			seeking = toSec;
			audio.currentTime = toSec;
			state.currentTime = toSec;
			setTimeout(() => { seeking = null; }, 100);
		},
		destroy() {
			destroyed = true;
			controlsRoot?.();
			audio.pause();
			audio.removeAttribute('src');
			audio.load();
			revokeAll();
		},
	};
}
