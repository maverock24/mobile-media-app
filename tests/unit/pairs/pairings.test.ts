/**
 * The A/B pairing store (`$lib/pairs/pairings.ts`) — shape, ordering, trim and
 * load-time normalisation. Every case seeds localStorage and then imports the
 * module fresh, because the store is created at import time and `persisted()`
 * reads the key inside its initialiser (`$lib/persisted.svelte.ts:26-34`).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { AbPairing } from '$lib/pairs/types';

const KEY = 'ab-pairings';

function makePair(id: number, savedAt: number): AbPairing {
	return {
		id,
		name: `Pair ${id}`,
		savedAt,
		a: {
			key: `n:books/Book ${id}.mp3`,
			name: `Book ${id}.mp3`,
			relativePath: `books/Book ${id}.mp3`,
			source: 'native',
			path: `/storage/emulated/0/Books/Book ${id}.mp3`,
		},
		b: null,
		bVolume: 50,
		bSpeed: 1,
		positionSec: 0,
		durationSec: 0,
	};
}

/** Import the store after the caller has seeded localStorage. */
async function loadStore() {
	return await import('$lib/pairs/pairings');
}

beforeEach(() => {
	localStorage.clear();
	vi.resetModules();
});

describe('pairings store', () => {
	it('keeps the newest first', async () => {
		localStorage.setItem(
			KEY,
			JSON.stringify({
				pairs: [makePair(1, 1000), makePair(2, 3000), makePair(3, 2000)],
				nextId: 4,
				activePairId: null,
			})
		);

		const { pairings } = await loadStore();

		expect(pairings.pairs.map((pair) => pair.savedAt)).toEqual([3000, 2000, 1000]);
	});

	it('trims to fifty rows', async () => {
		const { MAX_PAIRINGS, pairings } = await loadStore();
		expect(MAX_PAIRINGS).toBe(50);

		// Oldest first in memory, so a plain `slice(0, 50)` would keep the wrong
		// half: only a newest-first trim drops savedAt 1 and keeps 51.
		pairings.pairs = Array.from({ length: MAX_PAIRINGS + 1 }, (_, i) => makePair(i + 1, i + 1));

		// persisted() flushes at the end of the microtask (persisted.svelte.ts:69-79).
		await new Promise((resolve) => setTimeout(resolve, 10));

		const stored = JSON.parse(localStorage.getItem(KEY)!);
		expect(stored.pairs).toHaveLength(MAX_PAIRINGS);
		expect(stored.pairs[0].savedAt).toBe(51);
		expect(stored.pairs.some((pair: AbPairing) => pair.savedAt === 1)).toBe(false);
	});

	it('survives a legacy payload with no pairs key', async () => {
		localStorage.setItem(KEY, JSON.stringify({ nextId: 4 }));

		const { pairings } = await loadStore();

		expect(pairings.pairs).toEqual([]);
		expect(pairings.nextId).toBe(4);
		expect(pairings.activePairId).toBeNull();
	});

	it('removes one row and shrinks the stored payload', async () => {
		localStorage.setItem(
			KEY,
			JSON.stringify({
				pairs: [makePair(1, 1000), makePair(2, 3000)],
				nextId: 3,
				activePairId: null,
			})
		);

		const { pairings, removePairing } = await loadStore();
		expect(pairings.pairs).toHaveLength(2);

		removePairing(2);

		expect(pairings.pairs.map((pair) => pair.id)).toEqual([1]);

		await new Promise((resolve) => setTimeout(resolve, 10));

		const stored = JSON.parse(localStorage.getItem(KEY)!);
		expect(stored.pairs).toHaveLength(1);
		expect(stored.pairs.some((pair: AbPairing) => pair.id === 2)).toBe(false);
	});

	it('clears the active pointer when the active row is deleted', async () => {
		localStorage.setItem(
			KEY,
			JSON.stringify({
				pairs: [makePair(1, 1000), makePair(2, 3000)],
				nextId: 3,
				activePairId: 2,
			})
		);

		const { pairings, removePairing } = await loadStore();

		// Without this, S8's position writer keeps writing to a row that is gone.
		removePairing(2);

		expect(pairings.activePairId).toBeNull();
	});
});
