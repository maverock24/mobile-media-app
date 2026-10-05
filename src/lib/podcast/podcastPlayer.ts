/**
 * Podcast transport — the per-view player factory. Lifted out of
 * `src/lib/components/views/PodcastView.svelte` (PR 6 group 5).
 *
 * Seam: `createPodcastPlayer` is a factory, not a module singleton — one per
 * `PodcastView` instance, the same shape `createPodcastLibrary`, `createFileOps`
 * and the group-3 progress module use. It is a plain `.ts` and holds no runes,
 * so it does not own any `$state`. The reactive state the transport reads and
 * writes (`currentEpisode`, `isPlaying`, `isBuffering`, `currentTime`,
 * `duration`, `selectedPodcast`) stays in the component and arrives through the
 * injected accessor, so the component remains its sole owner and the markup
 * stays reactive. The `<audio>` element is `bind:this`-bound in the template, so
 * it arrives as an injected `getAudioEl()` accessor. Everything the transport
 * keeps internally and the view never reads — the pending `online` reconnect
 * listener, the `_userPaused` flag, and the per-wiring throttle timestamps — is
 * private to the factory.
 *
 * The element listeners are still wired by the component's `$effect`; the effect
 * calls `attachElementListeners(el)` and returns its cleanup, so the nine
 * listeners are added and removed at exactly the same moments they used to be.
 *
 * Behaviour preserved from the view:
 *  - `safePlay` retries `audioEl.play()` on `AbortError` only: up to 6 retries
 *    at 250 ms on native, 3 at 150 ms on web; every other rejection (and the
 *    exhausted-retry case) calls `onFailure`; a synchronous throw from `play()`
 *    is not caught (it propagates);
 *  - the reconnect path: `scheduleReconnectResume` replaces any pending `online`
 *    listener, and on `online` it clears itself, rebuilds `src`, seeks to the
 *    saved position (> 1 s) once `loadedmetadata` fires, claims audio, and
 *    `safePlay`s; `cancelNetworkRetry` removes the `online` listener; `stalled`
 *    only schedules a reconnect while `navigator.onLine` is false and none is
 *    pending; `MEDIA_ERR_NETWORK` (code 2) schedules a reconnect and toasts,
 *    every other error stops playback (and toasts for `MEDIA_ERR_SRC_NOT_SUPPORTED`);
 *  - system-pause auto-resume: on an element `pause` that was not user-requested
 *    and did not reach a natural end, it retries `play()` up to 3 times at
 *    300 ms x (attempt + 1), starting 150 ms later;
 *  - MediaSession: metadata via `mediaEngine.setNowPlaying` when an episode
 *    starts (and on a restart rebuild), time via `mediaEngine.updateTime` on
 *    update and on `loadedmetadata`;
 *  - the per-episode playback-speed reset (`playbackSpeed = 1.0`) and the
 *    `playbackRate` re-apply in `syncEpisodeAudioSource`;
 *  - the audio channel is claimed on play (`mediaEngine.podcastPlaying = true;`
 *    then `claimAudio('podcast')`) and on resume, and pause is a deliberate
 *    pause (`markUserPaused()`) that also cancels a pending reconnect;
 *  - `ended` marks the episode fully played and clears `mediaEngine.item`,
 *    never advancing to the next episode;
 *  - `syncEpisodeAudioSource` applies the stored resume position (> 10 s) once
 *    `loadedmetadata` fires, and a restart rebuild (the view's restore effect)
 *    sets metadata without starting playback;
 *  - `handleSeekSeconds` sets the element time directly, with no suppression
 *    guard.
 */
import { Capacitor } from '@capacitor/core';
import {
	mediaEngine, claimAudio, markUserPaused,
} from '$lib/stores/mediaEngine.svelte';
import { addToast } from '$lib/stores/toastStore.svelte';
import { triggerPlaybackHaptic } from '$lib/native/haptics';
import {
	podcastData, podcastSettings,
	type PersistedEpisode, type PersistedPodcast,
} from '$lib/stores/settings.svelte';
import {
	syncPersistedEpisodeState, markEpisodeFullyPlayed, getEpisodeResumePosition,
	shouldPersistProgress, type ActiveEpisode, type PodcastProgressView,
} from '$lib/podcast/progress';

/**
 * The view-owned state the transport reads and writes. Every field is the
 * component's reactive state, exposed as a getter/setter pair so this rune-free
 * module can read and replace it without owning it.
 */
export interface PodcastPlayerView {
	selectedPodcast: PersistedPodcast | null;
	currentEpisode: ActiveEpisode | null;
	isPlaying: boolean;
	isBuffering: boolean;
	currentTime: number;
	duration: number;
}

export interface PodcastPlayerOptions {
	/** The view-owned state the module reads and writes. */
	view: PodcastPlayerView;
	/** The `bind:this`-bound `<audio>` element. Undefined until the template mounts. */
	getAudioEl(): HTMLAudioElement | undefined;
}

/** Per-view podcast transport: play/pause/resume, seek, episode stepping, the
 *  network-reconnect path and the MediaSession/`mediaEngine` wiring. */
export interface PodcastPlayer {
	safePlay(onFailure?: () => void): void;
	cancelNetworkRetry(): void;
	scheduleReconnectResume(url: string, positionSec: number): void;
	syncEpisodeAudioSource(podcast: PersistedPodcast, episode: PersistedEpisode, resumeAt: number): void;
	playEpisode(podcast: PersistedPodcast, episode: PersistedEpisode): void;
	activateEpisode(podcast: PersistedPodcast, episode: PersistedEpisode): void;
	togglePlay(): void;
	pausePlayback(): void;
	resumePlayback(): void;
	prevEpisode(): void;
	nextEpisode(): void;
	handleSeekSeconds(seconds: number): void;
	claimPodcastControls(): void;
	/** Wire the nine element listeners; returns the cleanup the effect returns. */
	attachElementListeners(el: HTMLAudioElement): () => void;
}

export function createPodcastPlayer(opts: PodcastPlayerOptions): PodcastPlayer {
	const { view, getAudioEl } = opts;

	// The progress module reads and replaces the same two objects through its
	// own accessor shape; the transport builds it from its view accessor.
	const progressView: PodcastProgressView = {
		get selectedPodcast() { return view.selectedPodcast; },
		set selectedPodcast(v) { view.selectedPodcast = v; },
		get currentEpisode() { return view.currentEpisode; },
		set currentEpisode(v) { view.currentEpisode = v; },
	};

	// The pending `online` reconnect listener, replaced on each
	// `scheduleReconnectResume` and removed by `cancelNetworkRetry`. Private.
	let reconnectListener: (() => void) | null = null;
	// True between `playEpisode`/`pausePlayback`/`resumePlayback` setting the
	// intent and the element's `pause` event consuming it — the guard that stops
	// the system-pause auto-resume from fighting a deliberate pause. Private.
	let userPaused = false;

	function claimPodcastControls(): void {
		if (typeof mediaEngine.setPlaybackHandlers === 'function') {
			mediaEngine.setPlaybackHandlers(
				() => { resumePlayback(); },
				() => { pausePlayback(); },
				(pos) => { handleSeekSeconds(pos); }
			);
		}

		if (typeof mediaEngine.setSkipHandlers === 'function') {
			mediaEngine.setSkipHandlers(
				() => { nextEpisode(); },
				() => { prevEpisode(); }
			);
		}
	}

	/** Retry audioEl.play() on AbortError — remote URLs can abort on Android
	 *  WebView when the source isn't ready yet after setting src. Uses up to 6
	 *  retries on native (3 on web) with longer backoff for cold Capacitor starts. */
	function safePlay(onFailure?: () => void): void {
		const maxRetries = Capacitor.isNativePlatform() ? 6 : 3;
		const retryDelayMs = Capacitor.isNativePlatform() ? 250 : 150;
		const tryPlay = (attempt: number) => {
			getAudioEl()!.play().catch((err: Error) => {
				if (err?.name === 'AbortError' && attempt < maxRetries) {
					setTimeout(() => tryPlay(attempt + 1), retryDelayMs);
				} else {
					onFailure?.();
				}
			});
		};
		tryPlay(0);
	}

	function cancelNetworkRetry(): void {
		if (reconnectListener) {
			window.removeEventListener('online', reconnectListener);
			reconnectListener = null;
		}
	}

	function scheduleReconnectResume(url: string, positionSec: number): void {
		cancelNetworkRetry(); // replace any previous pending retry
		reconnectListener = () => {
			cancelNetworkRetry();
			const el = getAudioEl();
			if (!view.currentEpisode || !el) return;
			el.src = url;
			if (positionSec > 1) {
				el.addEventListener('loadedmetadata', () => {
					if (el.currentTime < positionSec) el.currentTime = positionSec;
				}, { once: true });
			}
			mediaEngine.podcastPlaying = true;
			claimAudio('podcast');
			view.isBuffering = true;
			safePlay(() => {
				view.isBuffering = false;
				mediaEngine.podcastPlaying = false;
				addToast({ message: 'Reconnected but failed to resume. Tap play to retry.', type: 'warning', autoDismissMs: 5000 });
			});
		};
		window.addEventListener('online', reconnectListener);
	}

	// ── Audio element event wiring ───────────────────────────────
	// The component's `$effect` calls this (and returns its cleanup), so the
	// nine listeners are added and removed at exactly the moments they used to be.
	function attachElementListeners(el: HTMLAudioElement): () => void {
		// Throttle timeupdate to ~4Hz — smooth for seek bar, 15× less CPU than 60fps
		let _lastTimeUpdate = 0;
		let _lastProgressPersist = 0; // last time we flushed progress to the persisted store
		const onTimeUpdate = () => {
			const now = Date.now();
			if (now - _lastTimeUpdate < 250) return;
			_lastTimeUpdate = now;
			view.currentTime = el.currentTime;
			if (mediaEngine.source === 'podcast') {
				mediaEngine.updateTime(el.currentTime, el.duration);
			}
			const playbackDuration =
				(isFinite(el.duration) && el.duration > 0)
					? el.duration
					: view.currentEpisode?.episode.duration ?? view.duration;
			if (view.currentEpisode && playbackDuration > 0) {
				const updatedEpisode = {
					...view.currentEpisode.episode,
					progress: Math.min(100, Number(((el.currentTime / playbackDuration) * 100).toFixed(1))),
					positionSec: el.currentTime,
					duration: playbackDuration,
				};
				// Keep the in-memory position current for the UI every tick, but only
				// commit to the persisted store on a coarse cadence. Persisting on
				// every 250ms tick re-serialises the WHOLE podcast-data blob (all
				// subscriptions' episodes) 4x/second — that main-thread + storage churn
				// is a major source of jank and of localStorage quota pressure on
				// Android, and a single over-quota write permanently kills that store.
				view.currentEpisode = { ...view.currentEpisode, episode: updatedEpisode };
				if (shouldPersistProgress(_lastProgressPersist, now)) {
					_lastProgressPersist = now;
					syncPersistedEpisodeState(view.currentEpisode.podcast.id, updatedEpisode, progressView);
				}
			}
		};
		const onLoadedMetadata = () => {
			view.duration = isFinite(el.duration) ? el.duration : 0;
			if (view.currentEpisode && view.duration > 0) {
				syncPersistedEpisodeState(view.currentEpisode.podcast.id, {
					...view.currentEpisode.episode,
					duration: view.duration,
				}, progressView);
			}
			if (mediaEngine.source === 'podcast') {
				mediaEngine.updateTime(el.currentTime, el.duration);
			}
		};
		const onPlay  = () => { view.isPlaying = true;  view.isBuffering = false; mediaEngine.podcastPlaying = true;  };
		const onPause = () => {
			const wasUserPaused = userPaused;
			userPaused = false;
			view.isPlaying = false;
			mediaEngine.podcastPlaying = false;
			// Pause is a natural checkpoint — flush the current position to the
			// persisted store so a kill/background right after pausing still has an
			// exact resume point (timeupdate persistence is throttled to ~5s).
			if (view.currentEpisode) {
				_lastProgressPersist = Date.now();
				const positionSec = el.currentTime ?? view.currentEpisode.episode.positionSec ?? 0;
				const playbackDuration =
					(isFinite(el.duration) && el.duration > 0)
						? el.duration
						: (view.currentEpisode.episode.duration ?? view.duration ?? 0);
				const progress = playbackDuration > 0
					? Math.min(100, Number(((positionSec / playbackDuration) * 100).toFixed(1)))
					: view.currentEpisode.episode.progress ?? 0;
				const updatedEpisode = {
					...view.currentEpisode.episode,
					positionSec,
					progress,
					duration: playbackDuration || view.currentEpisode.episode.duration,
				};
				syncPersistedEpisodeState(view.currentEpisode.podcast.id, updatedEpisode, progressView);
				podcastData.lastPositionSec = positionSec;
			}
			// System paused us (Android Doze, audio-focus churn) — try to resume.
			// Retry up to 3 times with backoff, same pattern as MP3 safePlay.
			// Do NOT resume when the audio reached its natural end (ended fires
			// before pause, so audioEl.ended is already true by here).
			if (!wasUserPaused && view.currentEpisode && !el.ended) {
				const tryResume = (attempt: number) => {
					el.play().catch(() => {
						if (attempt < 3) setTimeout(() => tryResume(attempt + 1), 300 * (attempt + 1));
					});
				};
				setTimeout(() => tryResume(0), 150);
			}
		};
		const onWaiting  = () => { view.isBuffering = true; };
		const onPlaying  = () => { view.isBuffering = false; };
		const onEnded = () => {
			view.isPlaying = false;
			view.isBuffering = false;
			mediaEngine.podcastPlaying = false;
			if (view.currentEpisode) {
				markEpisodeFullyPlayed(view.currentEpisode.podcast.id, view.currentEpisode.episode, progressView);
			}
			// Stop — do NOT auto-play the next episode. Clear the now-playing item
			// so the background-resume watchdog doesn't replay the ended episode.
			mediaEngine.item = null;
		};
		const onError = () => {
			const err = el.error;
			view.isBuffering = false;
			if (err?.code === 2 && view.currentEpisode) {
				scheduleReconnectResume(el.src, el.currentTime);
				addToast({ message: 'Connection lost — will resume when reconnected.', type: 'warning', autoDismissMs: 6000 });
			} else {
				view.isPlaying = false;
				mediaEngine.podcastPlaying = false;
				if (err?.code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED) {
					addToast({ message: 'This audio format is not supported.', type: 'error', autoDismissMs: 4000 });
				}
			}
		};
		// stalled = browser requested audio data but received nothing (common on network drop).
		// Only treat it as a connectivity loss when the device reports it is offline.
		const onStalled = () => {
			if (!navigator.onLine && view.currentEpisode && !reconnectListener) {
				scheduleReconnectResume(el.src, el.currentTime);
				addToast({ message: 'Connection lost — will resume when reconnected.', type: 'warning', autoDismissMs: 6000 });
			}
		};
		el.addEventListener('timeupdate',     onTimeUpdate);
		el.addEventListener('loadedmetadata', onLoadedMetadata);
		el.addEventListener('play',    onPlay);
		el.addEventListener('pause',   onPause);
		el.addEventListener('ended',   onEnded);
		el.addEventListener('error',   onError);
		el.addEventListener('waiting', onWaiting);
		el.addEventListener('playing', onPlaying);
		el.addEventListener('stalled', onStalled);
		return () => {
			el.removeEventListener('timeupdate',     onTimeUpdate);
			el.removeEventListener('loadedmetadata', onLoadedMetadata);
			el.removeEventListener('play',    onPlay);
			el.removeEventListener('pause',   onPause);
			el.removeEventListener('ended',   onEnded);
			el.removeEventListener('error',   onError);
			el.removeEventListener('waiting', onWaiting);
			el.removeEventListener('playing', onPlaying);
			el.removeEventListener('stalled', onStalled);
			cancelNetworkRetry();
		};
	}

	// ── Playback ─────────────────────────────────────────────────
	function syncEpisodeAudioSource(podcast: PersistedPodcast, episode: PersistedEpisode, resumeAt: number): void {
		const el = getAudioEl()!;
		el.playbackRate = podcastSettings.playbackSpeed;
		if (el.src !== episode.audioUrl) {
			el.src = episode.audioUrl;
			if (resumeAt > 10) {
				el.addEventListener('loadedmetadata', () => {
					if (view.currentEpisode?.episode.id !== episode.id) return;
					el.currentTime = resumeAt;
					view.currentTime = resumeAt;
				}, { once: true });
			}
		}

		mediaEngine.setNowPlaying({
			id:         episode.id,
			source:     'podcast',
			title:      episode.title,
			subtitle:   podcast.title,
			audioUrl:   episode.audioUrl,
			artworkUrl: podcast.artworkUrl,
			duration:   episode.duration
		}, 'podcast');
		claimPodcastControls();
	}

	function playEpisode(podcast: PersistedPodcast, episode: PersistedEpisode): void {
		if (!episode.audioUrl) {
			addToast({ message: 'This episode has no playable audio URL.', type: 'error' });
			return;
		}
		cancelNetworkRetry(); // clear any pending retry for the previous episode
		podcastSettings.playbackSpeed = 1.0; // reset speed for each new episode so the 1.5x button is off by default
		void triggerPlaybackHaptic(true);

		// If another episode is currently playing, pause it explicitly before
		// claiming audio. This makes the audio element's 'pause' event fire while
		// currentEpisode still points to the OLD episode, so its position is saved
		// correctly and the auto-resume logic is skipped. Without this,
		// claimAudio() fires the stop callback after currentEpisode has already
		// been swapped, causing stale position data to be written to the new
		// episode and triggering a spurious auto-resume.
		const el = getAudioEl();
		if (el && view.isPlaying && view.currentEpisode && view.currentEpisode.episode.id !== episode.id) {
			userPaused = true;
			el.pause();
		}

		// Set playing flag BEFORE claimAudio so isPlaying never transiently
		// drops to false — prevents rapid focus abandon→request on Android.
		mediaEngine.podcastPlaying = true;
		claimAudio('podcast');

		view.currentEpisode = { podcast, episode };
		// Calculate resume position BEFORE updating lastEpisodeId, otherwise
		// getEpisodeResumePosition() thinks the new episode is the last-played
		// one and applies lastPositionSec from the previous episode.
		const resumeAt = getEpisodeResumePosition(episode);
		// Record this as the last-played episode and seed lastPositionSec with
		// the resume point so a pause/background later saves to the right episode.
		podcastData.lastEpisodeId = episode.id;
		podcastData.lastPodcastId = podcast.id;
		podcastData.lastPositionSec = resumeAt;

		view.duration = episode.duration;
		view.currentTime = resumeAt > 10 ? resumeAt : 0;
		syncEpisodeAudioSource(podcast, episode, resumeAt);
		view.isBuffering = true;
		safePlay(() => {
			view.isBuffering = false;
			mediaEngine.podcastPlaying = false;
			console.error('[Podcast] play() failed:', 'url:', episode.audioUrl);
			addToast({ message: `Playback failed.`, type: 'error' });
		});
	}

	function activateEpisode(podcast: PersistedPodcast, episode: PersistedEpisode): void {
		if (view.currentEpisode?.episode.id === episode.id) {
			togglePlay();
			return;
		}

		playEpisode(podcast, episode);
	}

	function togglePlay(): void {
		if (view.isPlaying) {
			pausePlayback();
		} else {
			resumePlayback();
		}
	}

	function pausePlayback(): void {
		if (!getAudioEl() || !view.currentEpisode || !view.isPlaying) return;
		userPaused = true;
		// Deliberate pause: tell the engine too, so the Android background recovery
		// does not restart the episode when the phone is later locked.
		markUserPaused();
		void triggerPlaybackHaptic(false);
		cancelNetworkRetry();
		getAudioEl()!.pause();
	}

	function resumePlayback(): void {
		if (!getAudioEl() || !view.currentEpisode || view.isPlaying) return;
		userPaused = false;
		void triggerPlaybackHaptic(true);
		mediaEngine.podcastPlaying = true;
		claimAudio('podcast');
		syncEpisodeAudioSource(
			view.currentEpisode.podcast,
			view.currentEpisode.episode,
			getEpisodeResumePosition(view.currentEpisode.episode)
		);
		safePlay(() => {
			mediaEngine.podcastPlaying = false;
			console.error('[Podcast] resumePlayback() failed');
		});
	}

	function prevEpisode(): void {
		if (!view.currentEpisode) return;
		const podcast = podcastData.podcasts.find(p => p.id === view.currentEpisode!.podcast.id);
		if (!podcast) return;
		const eps = podcast.episodes;
		const idx = eps.findIndex(e => e.id === view.currentEpisode!.episode.id);
		if (idx > 0) playEpisode(podcast, eps[idx - 1]);
	}

	function nextEpisode(): void {
		if (!view.currentEpisode) return;
		const podcast = podcastData.podcasts.find(p => p.id === view.currentEpisode!.podcast.id);
		if (!podcast) return;
		const eps = podcast.episodes;
		const idx = eps.findIndex(e => e.id === view.currentEpisode!.episode.id);
		if (idx >= 0 && idx < eps.length - 1) playEpisode(podcast, eps[idx + 1]);
	}

	function handleSeekSeconds(seconds: number): void {
		view.currentTime = seconds;
		const el = getAudioEl();
		if (el) el.currentTime = seconds;
	}

	return {
		safePlay,
		cancelNetworkRetry,
		scheduleReconnectResume,
		syncEpisodeAudioSource,
		playEpisode,
		activateEpisode,
		togglePlay,
		pausePlayback,
		resumePlayback,
		prevEpisode,
		nextEpisode,
		handleSeekSeconds,
		claimPodcastControls,
		attachElementListeners,
	};
}
