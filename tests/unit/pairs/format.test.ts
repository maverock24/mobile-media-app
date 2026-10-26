/**
 * The pairings row's own format (`$lib/pairs/format.ts`, D9). A position is
 * rendered with `formatClock` (`$lib/models/music.ts`), whose hours rule is
 * pinned in `tests/unit/models/music.test.ts:25-32`; the row owns no copy of it,
 * so this file pins only what the row does own.
 */
import { describe, it, expect } from 'vitest';
import { formatVolume } from '$lib/pairs/format';

describe('pairings row formats', () => {
	it('formats the volume as a whole percentage', () => {
		expect(formatVolume(40)).toBe('40%');
		expect(formatVolume(39.6)).toBe('40%');
		expect(formatVolume(0)).toBe('0%');
	});
});
