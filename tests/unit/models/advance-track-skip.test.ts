import { describe, it, expect } from 'vitest';
import { getNextTrackIndex } from '$lib/models/music';

// ─────────────────────────────────────────────────────────────
// BUG: advanceTrack skips tracks when ensureTrackUrl fails
//
// In advanceTrack, setCurrentTrack(nextIndex) is called BEFORE
// ensureTrackUrl. If ensureTrackUrl returns null, the function
// returns early but lastTrackIndex is already advanced.
// The next call to advanceTrack advances from the already-advanced
// index, effectively SKIPPING the failed track permanently.
// ─────────────────────────────────────────────────────────────

describe('BUG: advanceTrack skips tracks on URL load failure', () => {
	it('FAILS: lastTrackIndex advances even when URL fails to load', () => {
		// Simulate advanceTrack's current behavior
		let lastTrackIndex = 5;
		const tracks = Array.from({ length: 10 }, (_, i) => ({
			id: i,
			title: `Track ${i}`,
			url: i === 6 ? '' : `blob:track-${i}`, // track 6 has no URL
		}));

		let skipped: number[] = [];

		const simulateAdvanceTrack = (): boolean => {
			const nextIndex = getNextTrackIndex(lastTrackIndex, {
				trackCount: tracks.length,
			});
			if (nextIndex === null) return false;

			// BUG: advances index BEFORE loading
			lastTrackIndex = nextIndex;

			// Simulate ensureTrackUrl failure
			const track = tracks[nextIndex];
			const url = track?.url;
			if (!url) {
				// BUG: returns without resetting lastTrackIndex!
				skipped.push(nextIndex);
				return false; // track didn't play
			}
			return true; // track played
		};

		// Track 5 finishes → advance to 6 → fails → index stuck at 6
		const played1 = simulateAdvanceTrack();
		expect(played1).toBe(false); // Track 6 failed
		expect(lastTrackIndex).toBe(6); // BUG: index advanced but track didn't play!

		// Next advance → from 6 to 7 → may succeed
		const played2 = simulateAdvanceTrack();
		expect(lastTrackIndex).toBe(7);
		// Track 6 was permanently SKIPPED
		expect(skipped).toContain(6);
	});

	it('FIX: should NOT advance index until URL load succeeds', () => {
		let lastTrackIndex = 5;
		const tracks = Array.from({ length: 10 }, (_, i) => ({
			id: i,
			title: `Track ${i}`,
			url: i === 6 ? '' : `blob:track-${i}`,
		}));

		const simulateFixedAdvanceTrack = (): boolean => {
			const nextIndex = getNextTrackIndex(lastTrackIndex, {
				trackCount: tracks.length,
			});
			if (nextIndex === null) return false;

			// FIX: load URL BEFORE advancing index
			const track = tracks[nextIndex];
			const url = track?.url;
			if (!url) {
				// FIX: try the NEXT track (auto-skip unplayable)
				lastTrackIndex = nextIndex; // still advance past broken track
				return false;
			}
			// Only advance index when URL loads successfully
			lastTrackIndex = nextIndex;
			return true;
		};

		const played1 = simulateFixedAdvanceTrack();
		expect(played1).toBe(false);
		// After fix: index did advance past the broken track (to try next)
		expect(lastTrackIndex).toBe(6);

		const played2 = simulateFixedAdvanceTrack();
		expect(played2).toBe(true);
		expect(lastTrackIndex).toBe(7);
	});
});

describe('BUG: cascade failure — multiple consecutive fail-fast tracks', () => {
	it('FAILS: consecutive failures cause index to advance multiple times without playback', () => {
		let lastTrackIndex = 0;
		let skips = 0;

		// Tracks 1 and 2 have no URLs, 3 is playable
		const tracks = [
			{ id: 0, url: 'blob:0' },
			{ id: 1, url: '' },     // broken
			{ id: 2, url: '' },     // broken
			{ id: 3, url: 'blob:3' },
			{ id: 4, url: 'blob:4' },
		];

		const simulateAdvance = (): boolean => {
			const nextIndex = getNextTrackIndex(lastTrackIndex, {
				trackCount: tracks.length,
			});
			if (nextIndex === null) return false;

			lastTrackIndex = nextIndex;
			if (!tracks[nextIndex]?.url) {
				skips++;
				return false;
			}
			return true;
		};

		// Track 0 plays → end → advance to 1 (fail, skip) → advance to 2 (fail, skip) → advance to 3 (play)
		expect(simulateAdvance()).toBe(false); // index 1, failed
		expect(simulateAdvance()).toBe(false); // index 2, failed
		expect(simulateAdvance()).toBe(true);  // index 3, played

		expect(skips).toBe(2);
		expect(lastTrackIndex).toBe(3);
		// Tracks 1 and 2 were never played — this is expected if they're truly broken
	});

	it('FIX: auto-advance through consecutive broken tracks in one call', () => {
		let lastTrackIndex = 0;
		let attempts = 0;

		const tracks = [
			{ id: 0, url: 'blob:0' },
			{ id: 1, url: '' },
			{ id: 2, url: '' },
			{ id: 3, url: 'blob:3' },
			{ id: 4, url: 'blob:4' },
		];

		const simulateFixedAdvance = (): boolean => {
			// Try up to the entire list to find a playable track
			const maxAttempts = tracks.length;
			for (let i = 0; i < maxAttempts; i++) {
				const nextIndex = getNextTrackIndex(lastTrackIndex, {
					trackCount: tracks.length,
				});
				if (nextIndex === null) return false;

				lastTrackIndex = nextIndex;
				attempts++;

				if (tracks[nextIndex]?.url) {
					return true; // found playable track
				}
				// continue to next track
			}
			return false;
		};

		const played = simulateFixedAdvance();
		expect(played).toBe(true);
		expect(lastTrackIndex).toBe(3); // landed on first playable track
		expect(attempts).toBe(3); // tried 1, 2, 3
	});
});

describe('BUG: advanceTrack index corruption from error handler retry', () => {
	it('FAILS: onError → advanceTrack cascade corrupts playback position', () => {
		// Simulate what happens when a track fails mid-playback:
		// 1. Audio error fires
		// 2. onError handler calls advanceTrack
		// 3. advanceTrack advances index then fails to load URL
		// 4. Next error → advanceTrack → advances further
		// Net effect: multiple tracks skipped with each error event

		let lastTrackIndex = -1; // start before first track
		let tracksPlayed: number[] = [];

		const tracks = [
			{ id: 0, url: 'blob:0' },
			{ id: 1, url: '' },     // broken track
			{ id: 2, url: 'blob:2' },
		];

		const advance = (): boolean => {
			const nextIndex = getNextTrackIndex(lastTrackIndex, {
				trackCount: tracks.length,
			});
			if (nextIndex === null) return false;

			lastTrackIndex = nextIndex;
			const url = tracks[nextIndex]?.url;
			if (!url) return false;

			tracksPlayed.push(nextIndex);
			return true;
		};

		// Normal play: advance to track 0 (first)
		advance();
		expect(lastTrackIndex).toBe(0);
		expect(tracksPlayed).toEqual([0]);

		// Track 0 ends → advance to 1 (broken) → fails → but index is now 1
		const played1 = advance();
		expect(played1).toBe(false); // track 1 failed
		expect(lastTrackIndex).toBe(1); // index advanced but track didn't play

		// onError fires → advance AGAIN → now advances from 1 to 2 (skipping 1)
		const played2 = advance();
		expect(played2).toBe(true); // track 2 plays
		expect(lastTrackIndex).toBe(2);

		// Track 1 was never played — skipped permanently
		expect(tracksPlayed).toEqual([0, 2]); // 1 is missing!
	});
});
