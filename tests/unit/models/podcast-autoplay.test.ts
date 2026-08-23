import { describe, it, expect } from 'vitest';
import { getNextAutoPlayEpisode } from '$lib/podcast/autoPlay';

const eps = [
	{ id: 'e1' }, { id: 'e2' }, { id: 'e3' },
];

describe('getNextAutoPlayEpisode — podcast end-of-episode advance contract', () => {
	it('advances to the next episode when autoPlayNext is on', () => {
		expect(getNextAutoPlayEpisode(eps, 'e1', true)?.id).toBe('e2');
	});

	it('returns null (stop, no loop) on the last episode', () => {
		expect(getNextAutoPlayEpisode(eps, 'e3', true)).toBeNull();
	});

	it('returns null (stop) when autoPlayNext is off', () => {
		expect(getNextAutoPlayEpisode(eps, 'e1', false)).toBeNull();
	});

	it('returns null for an unknown episode id', () => {
		expect(getNextAutoPlayEpisode(eps, 'missing', true)).toBeNull();
	});
});
