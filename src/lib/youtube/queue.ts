import { formatDuration, getNextTrackIndex, type YoutubeFavoriteTrack } from '$lib/models/music';

/**
 * Queue plumbing for YouTube playback.
 *
 * Kept free of Svelte and network access so the navigation rules can be unit
 * tested. The panel owns the audio element; this module only answers "which
 * index comes next".
 *
 * The queue reuses the music player's loop rules on purpose, so the shuffle and
 * repeat toggles in the music UI behave the same way here:
 *  - `isShuffle`  — global shuffle (musicSettings.isShuffle)
 *  - `isRepeat`   — repeat-one, handled by the caller restarting the track,
 *                   which is exactly how Mp3PlayerView's onEnded treats it
 *  - `queueLoop`  — the panel's own wrap toggle (musicSettings.youtubeQueueLoop),
 *                   matching the music selection-loop semantics
 */

export interface YoutubeQueueItem {
	videoId: string;
	title: string;
	/** Channel name. Named `subtitle` to match MediaItem.subtitle. */
	subtitle: string;
	durationSeconds: number;
	/** YouTube's own label when available, else derived from durationSeconds. */
	durationLabel: string;
	thumbnailUrl: string;
}

export interface YoutubeQueueState {
	/** Index of the track that just finished. */
	currentIndex: number;
	trackCount: number;
	/** Global shuffle setting. */
	isShuffle: boolean;
	/** Wrap to the first item after the last one. */
	queueLoop: boolean;
}

/**
 * Index to play when the current item ends, or null when the queue is done.
 *
 * `isRepeat` is deliberately not forwarded: repeat-one is the caller restarting
 * the same track, mirroring the music player. A one-item queue is kept alive by
 * `getNextTrackIndex` only when a loop flag is set, so a single result still
 * stops at the end unless the user asked for a loop.
 */
export function nextQueueIndex(state: YoutubeQueueState): number | null {
	if (state.trackCount === 0) return null;
	return getNextTrackIndex(state.currentIndex, {
		trackCount: state.trackCount,
		isShuffle: state.isShuffle,
		selectionLoop: state.queueLoop,
	});
}

/** Index for the prev button. Wraps to the end; never null for a non-empty queue. */
export function previousQueueIndex(currentIndex: number, trackCount: number): number | null {
	if (trackCount === 0) return null;
	if (currentIndex <= 0) return trackCount - 1;
	return currentIndex - 1;
}

/** YouTube labels short clips as "0:59" and long ones as "1:02:03"; both are
 *  already fine. Only fall back when the label is missing. */
function durationLabelFor(seconds: number, label?: string): string {
	if (label) return label;
	if (!seconds || seconds < 0 || !isFinite(seconds)) return '';
	return formatDuration(seconds);
}

/** Map a search hit onto a queue item. */
export function queueItemFromSearchResult(result: {
	videoId: string;
	title: string;
	author: string;
	durationSeconds: number;
	durationLabel?: string;
	thumbnailUrl: string;
}): YoutubeQueueItem {
	return {
		videoId: result.videoId,
		title: result.title,
		subtitle: result.author,
		durationSeconds: result.durationSeconds,
		durationLabel: durationLabelFor(result.durationSeconds, result.durationLabel),
		thumbnailUrl: result.thumbnailUrl,
	};
}

/** Map a stored favorite onto a queue item. */
export function queueItemFromFavorite(favorite: YoutubeFavoriteTrack): YoutubeQueueItem {
	const seconds = favorite.durationSeconds ?? 0;
	return {
		videoId: favorite.videoId,
		title: favorite.title,
		subtitle: favorite.artist,
		durationSeconds: seconds,
		durationLabel: durationLabelFor(seconds),
		thumbnailUrl: favorite.thumbnailUrl ?? '',
	};
}

/** Build the persisted favorite record for a queue item. */
export function favoriteFromQueueItem(item: YoutubeQueueItem): YoutubeFavoriteTrack {
	return {
		key: `youtube:${item.videoId}`,
		name: item.title,
		title: item.title,
		artist: item.subtitle,
		source: 'youtube',
		videoId: item.videoId,
		durationSeconds: item.durationSeconds || undefined,
		thumbnailUrl: item.thumbnailUrl || undefined,
	};
}

/** Index of an item in a queue, or -1. Used to keep the queue position in sync
 *  when playback is started from outside the queue (a favorite, or a pasted URL). */
export function indexOfVideo(queue: readonly YoutubeQueueItem[], videoId: string): number {
	return queue.findIndex((item) => item.videoId === videoId);
}
