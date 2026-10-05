/**
 * Podcast resume-progress persistence — lifted out of
 * `src/lib/components/views/PodcastView.svelte` (PR 6 group 3).
 *
 * This module is deliberately coupled to the shared `podcastData` store and
 * imports it directly, the same way `fileOps.ts` imports `musicSettings`. The
 * other two objects these functions write (`selectedPodcast`, `currentEpisode`)
 * are component `$state`, so they arrive through the injected
 * `PodcastProgressView` accessor — the getter/setter shape `createFileOps`
 * already uses for `pendingFileOp`. A plain `.ts` cannot hold runes, so the
 * accessor is what lets this module read and replace the view's reactive state
 * while keeping the component the sole owner.
 *
 * The throttle *decision* stays in the view's timeupdate handler, where the
 * per-element `_lastProgressPersist` closure lives; this module owns only the
 * interval constant and the pure boundary predicate.
 */
import {
	podcastData,
	type PersistedEpisode,
	type PersistedPodcast,
} from '$lib/stores/settings.svelte';

/** The view's active-episode pair: the podcast and episode now loaded. */
export interface ActiveEpisode {
	podcast: PersistedPodcast;
	episode: PersistedEpisode;
}

/**
 * The view-owned state these functions read and write. Every field is the
 * view's reactive state, exposed as a getter/setter pair so this rune-free
 * module can read and replace it without owning it.
 */
export interface PodcastProgressView {
	selectedPodcast: PersistedPodcast | null;
	currentEpisode: ActiveEpisode | null;
}

/**
 * How often (ms) playback progress is flushed to the persisted store during
 * playback. Coarse on purpose. Each flush persists by replacing
 * `podcastData.podcasts`, which serialises the ENTIRE trimmed podcast-data blob
 * (all subscriptions' kept episodes) and re-runs the `subscribedPodcasts` sort
 * derived; 20s balances crash/background resume granularity (~last 20s) against
 * that full-blob main-thread cost on Android. Pause/end/background still flush
 * exactly.
 */
export const PROGRESS_PERSIST_MS = 20000;

/**
 * True when a throttled progress flush is due. The view keeps the decision (and
 * the `_lastProgressPersist` timestamp) in the timeupdate handler; this is the
 * exact `now - _lastProgressPersist >= PROGRESS_PERSIST_MS` boundary, lifted so
 * it can be tested.
 */
export function shouldPersistProgress(
	lastPersistMs: number,
	now: number,
	intervalMs: number = PROGRESS_PERSIST_MS,
): boolean {
	return now - lastPersistMs >= intervalMs;
}

/**
 * Copy the played/progress/position/duration of `episode` onto the matching
 * episode in the persisted store, then mirror the replacement into the view's
 * `selectedPodcast` and `currentEpisode` when they point at the same record.
 * Bails silently when the podcast or the episode is no longer in the store.
 */
export function syncPersistedEpisodeState(
	podcastId: number,
	episode: PersistedEpisode,
	view: PodcastProgressView,
): void {
	const podcastIndex = podcastData.podcasts.findIndex((entry) => entry.id === podcastId);
	if (podcastIndex < 0) return;

	const podcast = podcastData.podcasts[podcastIndex];
	const episodeIndex = podcast.episodes.findIndex((entry) => entry.id === episode.id);
	if (episodeIndex < 0) return;

	const persistedEpisode = {
		...podcast.episodes[episodeIndex],
		played: episode.played,
		progress: episode.progress,
		positionSec: episode.positionSec ?? 0,
		duration: episode.duration,
	};
	const episodes = [...podcast.episodes];
	episodes[episodeIndex] = persistedEpisode;
	const updatedPodcast = { ...podcast, episodes };

	podcastData.podcasts = podcastData.podcasts.map((entry, index) =>
		index === podcastIndex ? updatedPodcast : entry
	);

	if (view.selectedPodcast?.id === podcastId) {
		view.selectedPodcast = updatedPodcast;
	}

	if (view.currentEpisode?.podcast.id === podcastId && view.currentEpisode.episode.id === episode.id) {
		view.currentEpisode = {
			podcast: updatedPodcast,
			episode: persistedEpisode,
		};
	}
}

/**
 * Mark an episode fully played (progress 100, position 0), persist that, and
 * record it as the last-played episode with a zero resume position.
 */
export function markEpisodeFullyPlayed(
	podcastId: number,
	episode: PersistedEpisode,
	view: PodcastProgressView,
): void {
	episode.played = true;
	episode.progress = 100;
	episode.positionSec = 0;
	syncPersistedEpisodeState(podcastId, episode, view);
	podcastData.lastEpisodeId = episode.id;
	podcastData.lastPodcastId = podcastId;
	podcastData.lastPositionSec = 0;
}

/**
 * Merge freshly fetched episodes with the ones already in the store. A new
 * episode that matches a stored one (by id, else audioUrl, else title+date)
 * keeps the stored `played`/`progress`/`positionSec` — saved playback state
 * always wins — and takes every other field from the incoming record. When the
 * matched episode is the last-played one, its stored id is remapped to the new
 * id.
 */
export function mergeEpisodeHistory(podcastId: number, episodes: PersistedEpisode[]): PersistedEpisode[] {
	const existingEpisodes = podcastData.podcasts.find(p => p.id === podcastId)?.episodes ?? [];
	const byId = new Map(existingEpisodes.map(episode => [episode.id, episode]));
	const byAudioUrl = new Map(existingEpisodes.filter(episode => episode.audioUrl).map(episode => [episode.audioUrl, episode]));
	const byTitleDate = new Map(existingEpisodes.map(episode => [`${episode.title}|${episode.publishedAt}`, episode]));

	return episodes.map(episode => {
		const existing = byId.get(episode.id)
			?? byAudioUrl.get(episode.audioUrl)
			?? byTitleDate.get(`${episode.title}|${episode.publishedAt}`);
		if (!existing) return episode;
		if (podcastData.lastPodcastId === podcastId && podcastData.lastEpisodeId === existing.id) {
			podcastData.lastEpisodeId = episode.id;
		}
		return {
			...episode,
			played: existing.played,
			progress: existing.progress,
			positionSec: existing.positionSec
		};
	});
}

/**
 * The resume position for an episode: its saved `positionSec`, and — when it is
 * the last-played episode — the larger of that and the store's
 * `lastPositionSec`. Unknown episodes return their own saved position
 * (0 when unset).
 */
export function getEpisodeResumePosition(episode: PersistedEpisode): number {
	const savedPosition = episode.positionSec ?? 0;
	if (episode.id !== podcastData.lastEpisodeId) {
		return savedPosition;
	}

	return Math.max(savedPosition, podcastData.lastPositionSec);
}
