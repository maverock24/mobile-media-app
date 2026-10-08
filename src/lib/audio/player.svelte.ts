/**
 * player.ts — the playback core behind a deck.
 *
 * A deep module: a large amount of playback behaviour (the queue, the audio
 * element, advance/preload/retry/loop, error recovery) behind a small Design-C
 * interface. See CONTEXT.md ("player", "deck") and docs/adr/0001-player-module.md.
 *
 * The module owns the HTMLAudioElement, the queue and the reactive `state`. URL
 * resolution is injected as a seam so the module never knows about Drive auth,
 * Capacitor, or object-URL creation. Tests inject a fake element and a fake
 * resolver. The view keeps the orchestration that is not playback: it builds the
 * file list (scan, Drive, favourites, folder pickers), hands the queue over with
 * `play`/`load`/`append`, and co-ordinates `mediaEngine` (audio exclusivity,
 * MediaSession, deck metadata) around it.
 */
import {
	getNextTrackIndex,
	mergeStoredFiles,
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

/** How a queue is built from a file list. */
export interface PlayerQueueOptions {
	/** Caller-supplied order is authoritative (favourites list, selection loop). */
	preserveOrder?: boolean;
	/** Wrap at the end of the queue instead of stopping (selection loop). */
	selectionLoop?: boolean;
}

export interface PlayerLoadOptions extends PlayerQueueOptions {
	/** Queue position to select. Defaults to 0. */
	startIndex?: number;
	/** Keep the currently selected track selected when the new queue still holds it. */
	keepCurrent?: boolean;
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
	/** Called at the start of an advance, before the next index is computed. The
	 *  view refreshes a changed selection loop here. */
	onBeforeAdvance?: () => void;
	/** Live selection-loop flag. The MiniPlayer toggles the loop store without
	 *  touching the queue, so the module has to read it through this getter.
	 *  Defaults to the `selectionLoop` option of the last `play()`/`load()`. */
	isSelectionLoop?: () => boolean;
}

export interface Player {
	state: PlayerState;
	play(tracks: StoredAudioFile[], startIndex?: number, options?: PlayerQueueOptions): Promise<void>;
	/** Replace the queue without touching the element (no playback side effects). */
	load(tracks: StoredAudioFile[], options?: PlayerLoadOptions): void;
	/** Merge files into the queue, keeping the URLs of files already queued. */
	append(files: StoredAudioFile[]): void;
	/** Stop, unload the element and drop the queue. */
	clear(): void;
	/** Stop and unload the element, keeping the queue (cross-source exclusivity). */
	stop(): void;
	pause(): void;
	resume(): void;
	/** Advance to the next track. Resolves true when it moved to a different track
	 *  and began playback, false when it stopped at the end of the queue, looped
	 *  the same track, or found nothing playable. */
	next(): Promise<boolean>;
	/** Step back. Resolves false when it only rewound the current track in place
	 *  or found nothing playable, true when it changed track and began playback. */
	prev(): Promise<boolean>;
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

	// The element is created on first use: createPlayer also runs during SSR,
	// where `new Audio()` does not exist. Tests inject their own element.
	let audio: HTMLAudioElement | null = null;
	function el(): HTMLAudioElement {
		if (!audio) {
			audio = opts.createAudio ? opts.createAudio() : new Audio();
			// The old view's element was `<audio preload="none">`: nothing is
			// fetched until a src is assigned, which is what WebViews expect.
			audio.preload = 'none';
			wireAudioEvents(audio);
		}
		return audio;
	}

	/** Snapshot of the last queue's loop flag, used when no live getter is given. */
	let selectionLoop = false;
	/** Bumped whenever the queue is replaced wholesale (play/load/clear). A URL
	 *  that resolves after that belongs to a queue nobody is playing, so it must
	 *  not be written into the replacement queue. `append` deliberately does not
	 *  bump it: a streaming folder scan must not cancel an in-flight resolve for a
	 *  slot that is already queued. */
	let queueGeneration = 0;

	/** Live selection-loop flag: the view's getter when supplied (MiniPlayer can
	 *  toggle the loop at any time), the queue's own option otherwise. */
	function isSelectionLoopActive(): boolean {
		return opts.isSelectionLoop ? opts.isSelectionLoop() : selectionLoop;
	}
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
				promise = el().play();
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

	/** Detach the element's source without dropping the queue. */
	function unload() {
		const element = el();
		element.removeAttribute('src');
		element.load();
	}

	/** Stop the element and reset the transport state, keeping queue and src. */
	function haltPlayback() {
		state.isPlaying = false;
		state.isBuffering = false;
		state.currentTime = 0;
		const element = el();
		element.pause();
		element.currentTime = 0;
	}

	async function ensureUrl(index: number, interactiveAuth: boolean): Promise<string | null> {
		const track = state.tracks[index];
		if (!track) return null;
		if (track.url) return track.url;
		const generation = queueGeneration;
		try {
			const url = await opts.resolveUrl(track.source, interactiveAuth);
			// The queue was replaced while the URL was being produced: the source
			// may no longer be queued (or may have moved), so the URL is dropped.
			// The resolver revokes its own object URL when that happens.
			if (generation !== queueGeneration) return null;
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
		if (!track) return;
		if (track.cleanup) { try { track.cleanup(); } catch { /* noop */ } }
		if (track.url || track.cleanup) {
			state.tracks = state.tracks.map((t, i) => (i === index ? { ...t, url: '', cleanup: undefined } : t));
		}
	}

	/** Release every queued URL in a single pass. Mapping per index is O(n^2),
	 *  and the deck hydrates its queue from the whole library at startup (see
	 *  Mp3PlayerView's hydrateTracksFromLibrary), so `play()`/`clear()` on a large
	 *  folder blocked the main thread for minutes. */
	function revokeAll() {
		if (state.tracks.length === 0) return;
		let changed = false;
		const next = state.tracks.map((t) => {
			if (!t.url && !t.cleanup) return t;
			if (t.cleanup) { try { t.cleanup(); } catch { /* noop */ } }
			changed = true;
			return { ...t, url: '', cleanup: undefined };
		});
		if (changed) state.tracks = next;
	}

	// ── queue ─────────────────────────────────────────────────────────────────
	/**
	 * Replace the queue. No element or transport side effects: the caller decides
	 * whether to stop first (`clear`) or to keep the current track playing
	 * (`keepCurrent`).
	 */
	function loadQueue(files: StoredAudioFile[], options: PlayerLoadOptions = {}) {
		queueGeneration += 1;
		const keepKey = options.keepCurrent && state.currentIndex >= 0 && state.tracks[state.currentIndex]
			? getTrackKey(state.tracks[state.currentIndex].source)
			: '';
		const ordered = (options.preserveOrder || options.selectionLoop) ? files : sortFiles(files, settings.sortOrder);

		state.tracks = ordered.map((f, i) => {
			const { title, artist } = parseFilename(f.name);
			return { id: i, title, artist, filename: f.name, url: '', duration: 0, source: f };
		});
		selectionLoop = options.selectionLoop ?? false;
		state.error = null;
		// A queue replacement supersedes any in-flight resume/prev that was showing
		// the "Loading track…" overlay. That continuation drops out on the generation
		// check below instead of clearing the flag (the new queue owns the state
		// now), so the stale buffering flag has to be cleared here or it sticks with
		// isPlaying false.
		state.isBuffering = false;
		errorRetries = 0;
		preloadRequestId += 1;
		preloadedIndex = null;

		if (state.tracks.length === 0) {
			state.currentIndex = -1;
			return;
		}

		let index = Math.max(0, Math.min(options.startIndex ?? 0, state.tracks.length - 1));
		if (keepKey) {
			const match = state.tracks.findIndex((t) => getTrackKey(t.source) === keepKey);
			index = match >= 0 ? match : 0;
		}
		setCurrentTrack(index);
		settings.lastTrackTimestamp = 0;
	}

	/** Resolve the selected track's URL and start it. Returns false when no
	 *  playable URL could be produced; the queue stays loaded either way. */
	async function startCurrent(): Promise<boolean> {
		if (state.tracks.length === 0) return false;
		const index = state.currentIndex >= 0 ? state.currentIndex : 0;
		const url = await ensureUrl(index, true);
		if (!url) { state.error = 'Unable to load this track.'; return false; }
		setCurrentTrack(index);
		settings.lastTrackTimestamp = 0;
		opts.applyEqualizer?.(el());
		el().src = url;
		preloadNextTrack(index);
		state.isBuffering = true;
		safePlay(() => { state.isBuffering = false; state.isPlaying = false; });
		return true;
	}

	// ── queue advance ─────────────────────────────────────────────────────────
	function nextIndex(from: number): number | null {
		return getNextTrackIndex(from, {
			trackCount: state.tracks.length,
			isShuffle: settings.isShuffle,
			isRepeat: settings.isRepeat,
			selectionLoop: isSelectionLoopActive(),
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

	function loadAndPlayAt(index: number, wasPlaying: boolean, interactiveAuth: boolean): Promise<boolean> {
		if (!state.tracks[index]) return Promise.resolve(false);
		const generation = queueGeneration;
		return (async () => {
			const url = await ensureUrl(index, interactiveAuth);
			if (!url) {
				// No playable URL (resolution failed, or the queue was replaced): never
				// leave the caller's "Loading track…" state stuck. Only reset it while
				// this queue is still the current one — a replaced queue owns the state
				// now. isPlaying stays false: nothing was handed to the element.
				if (wasPlaying && generation === queueGeneration) state.isBuffering = false;
				return false;
			}
			opts.applyEqualizer?.(el());
			el().src = url;
			preloadNextTrack(index);
			// A paused deck only loads the src: no play() means no playback start, so
			// the caller must not claim the channel or flag the deck as playing.
			if (!wasPlaying) return false;
			state.isBuffering = true;
			safePlay(() => { state.isBuffering = false; state.isPlaying = false; });
			return true;
		})();
	}

	async function advanceTrack(wasPlaying: boolean): Promise<boolean> {
		if (changingTrack || state.tracks.length === 0 || destroyed) return false;
		changingTrack = true;
		try {
			// The view refreshes a changed selection loop here, before the next
			// index is read from the queue.
			opts.onBeforeAdvance?.();

			const idx = state.currentIndex;
			const next = nextIndex(idx);
			if (next === null) { haltPlayback(); return false; }

			// Same-track loop (single selected track).
			if (next === idx) {
				setCurrentTrack(next);
				state.currentTime = 0;
				settings.lastTrackTimestamp = 0;
				if (el().error) {
					const url = state.tracks[next]?.url;
					if (url) { el().src = ''; el().src = url; }
				} else {
					el().currentTime = 0;
				}
				if (wasPlaying) { state.isBuffering = false; safePlay(() => { state.isPlaying = false; }); }
				return false;
			}

			setCurrentTrack(next);
			settings.lastTrackTimestamp = 0;
			state.currentTime = 0; state.duration = 0;
			if (state.tracks[next]) {
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
				if (!foundUrl) { haltPlayback(); return false; }
				if (attemptIndex !== next) setCurrentTrack(attemptIndex);
				releaseUrl(idx);
				opts.applyEqualizer?.(el());
				el().src = foundUrl;
				preloadNextTrack(attemptIndex);
				// A paused deck only loads the src, like the same-track branch above and
				// the pre-migration view: no play() means no playback start, so this
				// resolves false and the view does not claim the audio channel.
				if (!wasPlaying) return false;
				state.isBuffering = true;
				safePlay(() => { state.isBuffering = false; state.isPlaying = false; });
				return true;
			}
			return false;
		} finally {
			changingTrack = false;
		}
	}

	// ── audio element events ──────────────────────────────────────────────────
	function wireAudioEvents(element: HTMLAudioElement) {
		element.addEventListener('timeupdate', () => {
			if (seeking !== null) return;
			const now = Date.now();
			if (now - lastTimeUpdate < THROTTLE_MS) return;
			lastTimeUpdate = now;
			state.currentTime = element.currentTime;
		});
		element.addEventListener('loadedmetadata', () => {
			const d = isFinite(element.duration) ? element.duration : 0;
			state.duration = d;
			const i = state.currentIndex;
			if (i >= 0 && state.tracks[i]) {
				state.tracks = state.tracks.map((t, idx) => idx === i ? { ...t, duration: Math.round(d) } : t);
			}
		});
		element.addEventListener('play', () => { state.isPlaying = true; state.isBuffering = false; errorRetries = 0; });
		element.addEventListener('pause', () => { state.isPlaying = false; settings.lastTrackTimestamp = 0; });
		element.addEventListener('ended', () => {
			state.isBuffering = false;
			settings.lastTrackTimestamp = 0;
			if (settings.isRepeat && !isSelectionLoopActive()) {
				// repeat-one: rewind the same track.
				element.currentTime = 0;
				safePlay();
			} else {
				void advanceTrack(true);
			}
		});
		element.addEventListener('waiting', () => { state.isBuffering = true; });
		element.addEventListener('playing', () => { state.isBuffering = false; });
		element.addEventListener('error', () => {
			state.isBuffering = false;
			settings.lastTrackTimestamp = 0;
			if (errorRetries < 1 && state.tracks.length > 0) {
				errorRetries += 1;
				const idx = state.currentIndex;
				const url = state.tracks[idx]?.url;
				if (url) {
					element.src = '';
					element.src = url;
					safePlay(() => { errorRetries = 0; state.isPlaying = false; void advanceTrack(true); });
					return;
				}
			}
			errorRetries = 0;
			void advanceTrack(true);
		});
	}

	// Reactive sync of per-deck element controls. Wrapped in $effect.root so it
	// works when createPlayer is called outside a component (e.g. in tests).
	// SSR compiles $effect.root to a no-op, so this stays server-safe.
	let controlsRoot: (() => void) | null = null;
	controlsRoot = $effect.root(() => {
		$effect(() => {
			const controls = opts.controls;
			if (!controls) return;
			const element = el();
			element.volume = controls.volume / 100;
			element.muted = controls.muted;
			element.playbackRate = controls.playbackRate;
		});
	});

	// ── public interface (Design C) ───────────────────────────────────────────
	return {
		state,
		async play(tracks, startIndex = 0, options = {}) {
			haltPlayback();
			unload();
			revokeAll();
			state.duration = 0;
			loadQueue(tracks, { ...options, startIndex });
			await startCurrent();
		},
		load(tracks, options = {}) {
			loadQueue(tracks, options);
		},
		append(files) {
			if (files.length === 0 || destroyed) return;
			const previous = state.tracks;
			const currentKey = state.currentIndex >= 0 && previous[state.currentIndex]
				? getTrackKey(previous[state.currentIndex].source)
				: '';
			const preloadedKey = preloadedIndex !== null && previous[preloadedIndex]
				? getTrackKey(previous[preloadedIndex].source)
				: '';
			const mergedFiles = mergeStoredFiles(previous.map((t) => t.source), files);
			if (mergedFiles.length === previous.length) return;

			const existingByKey = new Map(previous.map((t) => [getTrackKey(t.source), t]));
			state.tracks = sortFiles(mergedFiles, settings.sortOrder).map((file, index) => {
				const existing = existingByKey.get(getTrackKey(file));
				const { title, artist } = parseFilename(file.name);
				return {
					id: index,
					title,
					artist,
					filename: file.name,
					url: existing?.url ?? '',
					duration: existing?.duration ?? 0,
					cleanup: existing?.cleanup,
					source: file,
				};
			});

			if (currentKey) {
				const nextCurrent = state.tracks.findIndex((t) => getTrackKey(t.source) === currentKey);
				if (nextCurrent >= 0) setCurrentTrack(nextCurrent);
			}
			if (preloadedKey) {
				const nextPreloaded = state.tracks.findIndex((t) => getTrackKey(t.source) === preloadedKey);
				preloadedIndex = nextPreloaded >= 0 ? nextPreloaded : null;
			}
		},
		clear() {
			queueGeneration += 1;
			haltPlayback();
			unload();
			revokeAll();
			state.tracks = [];
			state.currentIndex = -1;
			state.duration = 0;
			state.error = null;
		},
		stop() {
			haltPlayback();
			unload();
		},
		pause() { el().pause(); },
		resume() {
			if (destroyed) return;
			const element = el();
			// Nothing loaded (queue loaded without playback, or the element was
			// unloaded by a cross-source stop): start the selected track.
			if (!element.src) {
				if (state.tracks.length === 0) return;
				const index = state.currentIndex >= 0 ? state.currentIndex : 0;
				setCurrentTrack(index);
				state.isBuffering = true;
				// loadAndPlayAt clears isBuffering again when no URL comes back (the
				// resolve failed, or the queue was replaced) and never sets isPlaying.
				void loadAndPlayAt(index, true, true);
				return;
			}
			if (native) {
				// Capacitor's localhost bridge drops its HTTP connection when the
				// element pauses, and play() on the stale connection fails silently
				// or with network errors. Re-setting src re-establishes it without
				// losing the playback position.
				const resumePos = element.currentTime;
				const currentSrc = element.src;
				element.removeAttribute('src');
				element.src = currentSrc;
				if (resumePos > 0.5) element.currentTime = resumePos;
			}
			safePlay(() => {
				// Playback failed after all retries — reset the element and drop the
				// cached URL so the next attempt materializes a fresh one.
				state.isBuffering = false;
				state.isPlaying = false;
				unload();
				if (state.currentIndex >= 0) releaseUrl(state.currentIndex);
			});
		},
		// Advance: resolves true only when it moved to a different track and began
		// playback, so the view claims the channel on exactly that path. A paused
		// deck changes track and loads the src without starting playback, so it
		// resolves false too.
		next() { return advanceTrack(state.isPlaying || state.isBuffering); },
		// Step back: resolves false when it only rewound the current track in place
		// (nothing to claim) or found nothing playable, true when it changed track
		// and began playback. A paused deck only loads the src, so it resolves false
		// too — the view must not flag it as playing.
		prev() {
			if (state.tracks.length === 0) return Promise.resolve(false);
			const element = el();
			if (settings.rewindOnPrev && element.currentTime > 3) {
				element.currentTime = 0;
				safePlay();
				return Promise.resolve(false);
			}
			const oldIndex = state.currentIndex < 0 ? 0 : state.currentIndex;
			const prevIndex = (oldIndex - 1 + state.tracks.length) % state.tracks.length;
			const wasPlaying = state.isPlaying || state.isBuffering;
			setCurrentTrack(prevIndex);
			settings.lastTrackTimestamp = 0;
			state.currentTime = 0; state.duration = 0;
			return loadAndPlayAt(prevIndex, wasPlaying, true);
		},
		seek(toSec) {
			seeking = toSec;
			el().currentTime = toSec;
			state.currentTime = toSec;
			setTimeout(() => { seeking = null; }, 100);
		},
		destroy() {
			destroyed = true;
			controlsRoot?.();
			el().pause();
			unload();
			revokeAll();
		},
	};
}
