import { describe, it, expect } from 'vitest';
import {
	favoriteFromQueueItem,
	indexOfVideo,
	nextQueueIndex,
	previousQueueIndex,
	queueItemFromFavorite,
	queueItemFromSearchResult,
	type YoutubeQueueItem,
} from '$lib/youtube/queue';
import { toMediaItem } from '$lib/youtube/client';
import { getYoutubeFavoriteKey } from '$lib/models/music';

// ─────────────────────────────────────────────────────────────
// Queue navigation rules. These are the rules shared with the music player's
// loop/shuffle toggles, so the expectations here mirror Mp3PlayerView.
// ─────────────────────────────────────────────────────────────

const base = { isShuffle: false, queueLoop: false };

describe('nextQueueIndex — sequential', () => {
	it('advances one step', () => {
		expect(nextQueueIndex({ currentIndex: 0, trackCount: 3, ...base })).toBe(1);
	});

	it('advances mid-queue', () => {
		expect(nextQueueIndex({ currentIndex: 1, trackCount: 3, ...base })).toBe(2);
	});

	it('stops at the end when the queue does not loop', () => {
		expect(nextQueueIndex({ currentIndex: 2, trackCount: 3, ...base })).toBeNull();
	});

	it('wraps to the start when the queue loops', () => {
		expect(nextQueueIndex({ currentIndex: 2, trackCount: 3, ...base, queueLoop: true })).toBe(0);
	});

	it('returns null for an empty queue', () => {
		expect(nextQueueIndex({ currentIndex: 0, trackCount: 0, ...base })).toBeNull();
	});

	it('returns null for an empty queue even when looping', () => {
		expect(nextQueueIndex({ currentIndex: 0, trackCount: 0, ...base, queueLoop: true })).toBeNull();
	});
});

describe('nextQueueIndex — single-item queue', () => {
	// A single search result must stop at the end unless the user asked to loop,
	// matching the music player's single-track rule.
	it('stops with no loop', () => {
		expect(nextQueueIndex({ currentIndex: 0, trackCount: 1, ...base })).toBeNull();
	});

	it('repeats when the queue loops', () => {
		expect(nextQueueIndex({ currentIndex: 0, trackCount: 1, ...base, queueLoop: true })).toBe(0);
	});
});

describe('nextQueueIndex — shuffle', () => {
	it('picks a different index than the current one', () => {
		const next = nextQueueIndex({ currentIndex: 1, trackCount: 3, ...base, isShuffle: true });
		expect(next).not.toBe(1);
		expect(next).toBeGreaterThanOrEqual(0);
		expect(next).toBeLessThan(3);
	});

	it('never returns the current index, for every position', () => {
		// Regression guard: the shuffle pick is O(1) and skips the current index by
		// construction. The retry-until-different form this replaced could spin
		// forever when rand kept returning the same value.
		for (const trackCount of [2, 3, 5, 10]) {
			for (let currentIndex = 0; currentIndex < trackCount; currentIndex++) {
				const next = nextQueueIndex({ currentIndex, trackCount, ...base, isShuffle: true });
				expect(next).not.toBe(currentIndex);
				expect(next).toBeGreaterThanOrEqual(0);
				expect(next).toBeLessThan(trackCount);
			}
		}
	});

	it('shuffle still wraps the queue when looping', () => {
		// Shuffle ignores position, so the loop only has to keep the result valid.
		const next = nextQueueIndex({ currentIndex: 0, trackCount: 2, ...base, isShuffle: true, queueLoop: true });
		expect(next).toBe(1);
	});
});

describe('previousQueueIndex', () => {
	it('returns null for an empty queue', () => {
		expect(previousQueueIndex(0, 0)).toBeNull();
	});

	it('wraps to the last item from the first', () => {
		expect(previousQueueIndex(0, 3)).toBe(2);
	});

	it('steps back one', () => {
		expect(previousQueueIndex(2, 3)).toBe(1);
	});

	it('returns 0 for a single-item queue', () => {
		expect(previousQueueIndex(0, 1)).toBe(0);
	});
});

describe('queueItemFromSearchResult', () => {
	it('maps author onto subtitle', () => {
		const item = queueItemFromSearchResult({
			videoId: 'abc12345678',
			title: 'Track',
			author: 'Channel',
			durationSeconds: 213,
			durationLabel: '3:33',
			thumbnailUrl: 'https://i.ytimg.com/vi/abc12345678/hq.jpg',
		});
		expect(item.subtitle).toBe('Channel');
		expect(item.title).toBe('Track');
		expect(item.videoId).toBe('abc12345678');
	});

	it("keeps YouTube's own duration label", () => {
		const item = queueItemFromSearchResult({
			videoId: 'abc12345678',
			title: 'Track',
			author: 'Channel',
			durationSeconds: 213,
			durationLabel: '3:33',
			thumbnailUrl: '',
		});
		expect(item.durationLabel).toBe('3:33');
	});

	it('derives a duration label when YouTube did not supply one', () => {
		const item = queueItemFromSearchResult({
			videoId: 'abc12345678',
			title: 'Track',
			author: 'Channel',
			durationSeconds: 213,
			thumbnailUrl: '',
		});
		expect(item.durationLabel).toBe('3:33');
	});

	it('leaves the label empty when the duration is unknown', () => {
		const item = queueItemFromSearchResult({
			videoId: 'abc12345678',
			title: 'Track',
			author: 'Channel',
			durationSeconds: 0,
			thumbnailUrl: '',
		});
		expect(item.durationLabel).toBe('');
	});
});

describe('favorites round trip', () => {
	const item: YoutubeQueueItem = {
		videoId: 'dQw4w9WgXcQ',
		title: 'Never Gonna Give You Up',
		subtitle: 'Rick Astley',
		durationSeconds: 213,
		durationLabel: '3:33',
		thumbnailUrl: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hq.jpg',
	};

	it('uses the youtube: prefixed key', () => {
		expect(favoriteFromQueueItem(item).key).toBe('youtube:dQw4w9WgXcQ');
	});

	it('tags the favorite as a youtube source', () => {
		expect(favoriteFromQueueItem(item).source).toBe('youtube');
	});

	it('stores the video id so the stream can be re-resolved later', () => {
		expect(favoriteFromQueueItem(item).videoId).toBe('dQw4w9WgXcQ');
	});

	it('stores artist, not subtitle, as the favorite artist', () => {
		expect(favoriteFromQueueItem(item).artist).toBe('Rick Astley');
	});

	it('omits empty optional fields rather than persisting empty strings', () => {
		const favorite = favoriteFromQueueItem({ ...item, thumbnailUrl: '', durationSeconds: 0 });
		expect(favorite.thumbnailUrl).toBeUndefined();
		expect(favorite.durationSeconds).toBeUndefined();
	});

	it('survives a round trip back to a queue item', () => {
		const roundTripped = queueItemFromFavorite(favoriteFromQueueItem(item));
		expect(roundTripped.videoId).toBe(item.videoId);
		expect(roundTripped.title).toBe(item.title);
		expect(roundTripped.subtitle).toBe(item.subtitle);
		expect(roundTripped.thumbnailUrl).toBe(item.thumbnailUrl);
	});

	it('shares one key with the now-playing MediaItem', () => {
		// Mp3PlayerView matches a favorites-list row against the playing YouTube
		// track by comparing these two values directly, so they must agree.
		const mediaItem = toMediaItem({
			videoId: 'dQw4w9WgXcQ',
			audioUrl: 'https://rr5---sn-x.googlevideo.com/videoplayback?id=1',
			title: 'Never Gonna Give You Up',
			author: 'Rick Astley',
			durationSeconds: 213,
			thumbnailUrl: '',
		});
		expect(favoriteFromQueueItem(item).key).toBe(mediaItem.id);
		expect(getYoutubeFavoriteKey(item.videoId)).toBe(mediaItem.id);
	});
});

describe('indexOfVideo', () => {
	function item(videoId: string, title: string): YoutubeQueueItem {
		return { videoId, title, subtitle: '', durationSeconds: 0, durationLabel: '', thumbnailUrl: '' };
	}

	const queue = [item('aaaaaaaaaaa', 'One'), item('bbbbbbbbbbb', 'Two'), item('ccccccccccc', 'Three')];

	it('finds a video by id', () => {
		expect(indexOfVideo(queue, 'bbbbbbbbbbb')).toBe(1);
	});

	it('returns -1 when the video is not in the queue', () => {
		expect(indexOfVideo(queue, 'zzzzzzzzzzz')).toBe(-1);
	});

	it('returns -1 for an empty queue', () => {
		expect(indexOfVideo([], 'aaaaaaaaaaa')).toBe(-1);
	});
});
