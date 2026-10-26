/**
 * The two text formats a pairings row renders (`$lib/pairs/format.ts`, D9).
 * The view calls these directly, so the hours rule and the percentage rounding
 * are pinned here instead of in a component test.
 */
import { describe, it, expect } from 'vitest';
import { formatPosition, formatVolume } from '$lib/pairs/format';

describe('pairings row formats', () => {
	it('formats a position above an hour as h:mm:ss', () => {
		// A long audiobook: 1 h 2 min 5 s.
		expect(formatPosition(3725)).toBe('1:02:05');
		// The hours field only appears once it is non-zero.
		expect(formatPosition(3600)).toBe('1:00:00');
	});

	it('formats a sub-minute position as 0:ss', () => {
		expect(formatPosition(5)).toBe('0:05');
		expect(formatPosition(0)).toBe('0:00');
	});

	it('formats the volume as a whole percentage', () => {
		expect(formatVolume(40)).toBe('40%');
		expect(formatVolume(39.6)).toBe('40%');
		expect(formatVolume(0)).toBe('0%');
	});
});
