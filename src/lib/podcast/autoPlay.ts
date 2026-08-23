/**
 * Podcast auto-play-next decision.
 *
 * Pure — no DOM/store deps — so the end-of-episode advance contract is
 * unit-testable. Used by PodcastView.onEnded: on a natural episode end we either
 * advance to the next episode (autoPlayNext) or stop and clear the now-playing
 * item so the background-resume watchdog never replays the ended episode.
 */
export function getNextAutoPlayEpisode<T extends { id: string }>(
	episodes: T[],
	currentEpisodeId: string,
	autoPlayNext: boolean,
): T | null {
	if (!autoPlayNext) return null;
	const idx = episodes.findIndex((e) => e.id === currentEpisodeId);
	if (idx >= 0 && idx < episodes.length - 1) return episodes[idx + 1];
	return null;
}
