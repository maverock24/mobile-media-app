/**
 * Podcast episode display helpers — pure formatting/predicate logic lifted out
 * of `src/lib/components/views/PodcastView.svelte`.
 *
 * Every function here is pure: the view state the originals closed over
 * (`currentEpisode`, `currentTime`, `duration`) and the component constant
 * (`NEW_EPISODE_WINDOW_MS`) arrive as parameters or live in this module. No
 * runes, no stores, no component imports.
 */
import { formatDuration } from '$lib/models/music';

/** Unplayed episodes newer than this window are flagged as "new". */
export const NEW_EPISODE_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

/** Structural slice of a podcast episode that the display helpers read. */
export interface EpisodeDisplay {
	id: string;
	duration: number;
	progress?: number | null;
	positionSec?: number | null;
	publishedAt?: string | null;
	played?: boolean | null;
}

/** Structural slice of the view's active-episode pair; only the id is read. */
export interface ActiveEpisode {
	episode: { id: string };
}

/** Structural slice of a podcast; only the id seeds the gradient placeholder. */
export interface PodcastArtwork {
	id: number;
}

const ARTWORK_FALLBACK_GRADIENTS = [
	'from-indigo-500 to-purple-600',
	'from-cyan-500 to-blue-600',
	'from-emerald-500 to-teal-600',
	'from-orange-500 to-pink-600',
] as const;

export function isActiveEpisode(
	episode: EpisodeDisplay,
	currentEpisode: ActiveEpisode | null | undefined,
): boolean {
	return currentEpisode?.episode.id === episode.id;
}

export function getEpisodeProgressPercent(
	episode: EpisodeDisplay,
	currentEpisode: ActiveEpisode | null | undefined,
	currentTime: number,
	duration: number,
): number {
	const savedProgress = episode.progress ?? 0;

	if (!isActiveEpisode(episode, currentEpisode)) {
		return savedProgress;
	}

	const liveDuration = duration > 0 ? duration : episode.duration;
	if (liveDuration <= 0 || currentTime <= 0) {
		return savedProgress;
	}

	return Math.min(100, Number(((currentTime / liveDuration) * 100).toFixed(1)));
}

export function getEpisodeProgressLabel(
	episode: EpisodeDisplay,
	currentEpisode: ActiveEpisode | null | undefined,
	currentTime: number,
	duration: number,
): string {
	if (!isActiveEpisode(episode, currentEpisode)) {
		return '';
	}

	const progressPosition = currentTime > 0 ? currentTime : (episode.positionSec ?? 0);
	if (progressPosition <= 0) {
		return '';
	}

	const liveDuration = duration > 0 ? duration : episode.duration;
	if (liveDuration <= 0) {
		return `Playing ${formatDuration(progressPosition)}`;
	}

	return `${formatDuration(progressPosition)} of ${formatDuration(liveDuration)}`;
}

export function artworkFallback(podcast: PodcastArtwork): string {
	return ARTWORK_FALLBACK_GRADIENTS[podcast.id % ARTWORK_FALLBACK_GRADIENTS.length];
}

/** `now` is injectable so callers/tests can pin the window boundary. */
export function isNewEpisode(episode: EpisodeDisplay, now: number = Date.now()): boolean {
	if (episode.played || (episode.progress ?? 0) > 0 || (episode.positionSec ?? 0) > 0) return false;
	if (!episode.publishedAt) return true;
	const publishedTime = new Date(episode.publishedAt).getTime();
	if (!Number.isFinite(publishedTime)) return true;
	return now - publishedTime <= NEW_EPISODE_WINDOW_MS;
}
