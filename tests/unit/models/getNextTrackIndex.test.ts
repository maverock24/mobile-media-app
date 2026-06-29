import { describe, it, expect } from 'vitest';
import { getNextTrackIndex } from '$lib/models/music';

describe('getNextTrackIndex — selection loop', () => {
	it('wraps to 0 at the end when selectionLoop is on', () => {
		// 3 selected tracks queued; playing the last → loops back to the first
		expect(getNextTrackIndex(2, { trackCount: 3, selectionLoop: true })).toBe(0);
	});

	it('advances within the selection', () => {
		expect(getNextTrackIndex(0, { trackCount: 3, selectionLoop: true })).toBe(1);
		expect(getNextTrackIndex(1, { trackCount: 3, selectionLoop: true })).toBe(2);
	});

	it('stops (null) at the end when selectionLoop is OFF', () => {
		expect(getNextTrackIndex(2, { trackCount: 3, selectionLoop: false })).toBeNull();
	});

	it('a single selected track loops to itself', () => {
		expect(getNextTrackIndex(0, { trackCount: 1, selectionLoop: true })).toBe(0);
	});

	it('empty queue → null', () => {
		expect(getNextTrackIndex(0, { trackCount: 0, selectionLoop: true })).toBeNull();
	});

	it('full sequence over the selection wraps correctly', () => {
		// 0 → 1 → 2 → 0 → 1 …
		let i = 0;
		const seq: number[] = [];
		for (let n = 0; n < 6; n++) {
			seq.push(i);
			i = getNextTrackIndex(i, { trackCount: 3, selectionLoop: true })!;
		}
		expect(seq).toEqual([0, 1, 2, 0, 1, 2]);
	});
});

describe('getNextTrackIndex — repeat (single-track repeat)', () => {
	it('wraps at the end when isRepeat is on', () => {
		expect(getNextTrackIndex(2, { trackCount: 3, isRepeat: true })).toBe(0);
	});

	it('isRepeat and selectionLoop are interchangeable for wrap-around', () => {
		expect(getNextTrackIndex(2, { trackCount: 3, isRepeat: true, selectionLoop: false }))
			.toBe(getNextTrackIndex(2, { trackCount: 3, isRepeat: false, selectionLoop: true }));
	});
});

describe('getNextTrackIndex — plain sequential (no loop)', () => {
	it('advances', () => {
		expect(getNextTrackIndex(0, { trackCount: 3 })).toBe(1);
	});
	it('stops at the end', () => {
		expect(getNextTrackIndex(2, { trackCount: 3 })).toBeNull();
	});
});

describe('getNextTrackIndex — shuffle', () => {
	it('returns a different index than current', () => {
		// Deterministic PRNG so the test is stable: always returns index 0.
		const next = getNextTrackIndex(2, { trackCount: 3, isShuffle: true, rand: () => 0 });
		expect(next).toBe(0);
		expect(next).not.toBe(2);
	});

	it('honours a preloaded index when distinct and valid', () => {
		expect(getNextTrackIndex(0, { trackCount: 3, isShuffle: true, preloadedIndex: 2 })).toBe(2);
	});

	it('ignores a preloaded index equal to current', () => {
		// preloadedIndex === currentIndex → must pick a fresh random (here 1)
		expect(getNextTrackIndex(1, { trackCount: 3, isShuffle: true, preloadedIndex: 1, rand: () => 1 / 3 })).toBe(1 % 3 === 1 ? 0 : 1 % 3);
	});
});
