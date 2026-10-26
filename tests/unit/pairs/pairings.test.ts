/**
 * The A/B pairing store (`$lib/pairs/pairings.ts`) — shape, ordering, trim and
 * load-time normalisation. Every case seeds localStorage and then imports the
 * module fresh, because the store is created at import time and `persisted()`
 * reads the key inside its initialiser (`$lib/persisted.svelte.ts:26-34`).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { AbPairing, PairingTrackRef } from '$lib/pairs/types';
import type { PairingCandidate, PairingsState } from '$lib/pairs/pairings';

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

// ── Saving (S9) ───────────────────────────────────────────────────────────────
// `derivePairingName` and `upsertPairing` are pure, so the cases below call them
// directly after the same fresh import the store cases use.

function ref(key: string, name: string): PairingTrackRef {
	return { key, name, relativePath: key, source: 'native', path: `/storage/emulated/0/${key}` };
}

function candidate(
	a: PairingTrackRef,
	b: PairingTrackRef | null,
	savedAt: number,
	positionSec = 10
): PairingCandidate {
	return { a, b, positionSec, durationSec: 600, bVolume: 40, bSpeed: 1.25, savedAt };
}

function state(pairs: AbPairing[], nextId: number): PairingsState {
	return { pairs, nextId, activePairId: null };
}

const BOOK = ref('n:books/Halfway Home.mp3', 'Halfway Home.mp3');
const MUSIC = ref('n:music/Rain Loop.m4a', 'Rain Loop.m4a');
const OTHER_MUSIC = ref('n:music/Tape Hiss.mp3', 'Tape Hiss.mp3');

describe('derivePairingName', () => {
	it('derives a name from both track names and a date', async () => {
		const { derivePairingName } = await loadStore();
		const savedAt = new Date(2026, 2, 4, 12).getTime();

		const name = derivePairingName(BOOK, MUSIC, savedAt);

		expect(name).toBe(`Halfway Home + Rain Loop, ${new Date(savedAt).toLocaleDateString()}`);
		// The extension is dropped, not the whole file name.
		expect(name).not.toContain('.mp3');
		expect(name).not.toContain('.m4a');
	});

	it('derives a name with only an A track', async () => {
		const { derivePairingName } = await loadStore();
		const savedAt = new Date(2026, 2, 4, 12).getTime();

		const name = derivePairingName(BOOK, null, savedAt);

		expect(name).toBe(`Halfway Home, ${new Date(savedAt).toLocaleDateString()}`);
		expect(name).not.toContain('+');
	});
});

describe('upsertPairing', () => {
	it('upserts the same pair, moving it to the front', async () => {
		const { upsertPairing } = await loadStore();
		// Newest first, and the matching row is the older of the two.
		const before = state([makePair(2, 2000), makePair(1, 1000)], 3);
		before.pairs[1].a = BOOK;
		before.pairs[1].b = MUSIC;
		before.pairs[0].a = OTHER_MUSIC;

		const next = upsertPairing(before, candidate(BOOK, MUSIC, 3000, 42));

		expect(next.pairs).toHaveLength(2);
		expect(next.pairs[0].id).toBe(1);
		expect(next.pairs[0]).toMatchObject({
			savedAt: 3000,
			positionSec: 42,
			durationSec: 600,
			bVolume: 40,
			bSpeed: 1.25,
			b: MUSIC,
		});
		expect(next.pairs[0].name).toBe(
			`Halfway Home + Rain Loop, ${new Date(3000).toLocaleDateString()}`
		);
		expect(next.pairs[1].id).toBe(2);
		// An update allocates no id.
		expect(next.nextId).toBe(3);

		// The other half of the rule: the same audiobook with no background track
		// on both sides is also one row.
		const { emptyPairings } = await loadStore();
		const twice = upsertPairing(
			upsertPairing(emptyPairings(), candidate(BOOK, null, 1000)),
			candidate(BOOK, null, 2000, 33)
		);

		expect(twice.pairs).toHaveLength(1);
		expect(twice.pairs[0]).toMatchObject({ id: 0, savedAt: 2000, positionSec: 33, b: null });
		expect(twice.nextId).toBe(1);
	});

	it('keeps two pairs that share the A track but differ in B', async () => {
		const { emptyPairings, upsertPairing } = await loadStore();

		const first = upsertPairing(emptyPairings(), candidate(BOOK, MUSIC, 1000));
		const both = upsertPairing(first, candidate(BOOK, OTHER_MUSIC, 2000));

		expect(both.pairs).toHaveLength(2);
		expect(both.pairs.map((pair) => pair.id)).toEqual([1, 0]);
		expect(both.pairs[0].b).toBe(OTHER_MUSIC);
		expect(both.pairs[1].b).toBe(MUSIC);
		expect(both.nextId).toBe(2);
	});

	it('appends a new pair with the next id', async () => {
		const { emptyPairings, upsertPairing } = await loadStore();

		const first = upsertPairing(emptyPairings(), candidate(BOOK, MUSIC, 1000));
		const second = upsertPairing(first, candidate(OTHER_MUSIC, null, 2000));

		expect(second.pairs.map((pair) => pair.id)).toEqual([1, 0]);
		expect(second.pairs[0]).toMatchObject({ id: 1, a: OTHER_MUSIC, b: null, savedAt: 2000 });
		expect(second.nextId).toBe(2);
	});

	it('caps the list at fifty', async () => {
		const { emptyPairings, upsertPairing, MAX_PAIRINGS } = await loadStore();
		expect(MAX_PAIRINGS).toBe(50);

		// Fifty rows already, newest first: savedAt 50 down to 1.
		const full = state(
			Array.from({ length: MAX_PAIRINGS }, (_, i) => makePair(i + 1, MAX_PAIRINGS - i)),
			MAX_PAIRINGS + 1
		);

		const next = upsertPairing(full, candidate(BOOK, MUSIC, 100_000));

		expect(next.pairs).toHaveLength(MAX_PAIRINGS);
		expect(next.pairs[0].id).toBe(MAX_PAIRINGS + 1);
		expect(next.nextId).toBe(MAX_PAIRINGS + 2);
		// The oldest row is the one that falls off, not the newest.
		expect(next.pairs.some((pair) => pair.savedAt === 1)).toBe(false);
		expect(next.pairs.some((pair) => pair.savedAt === MAX_PAIRINGS)).toBe(true);
		// The cap holds when the candidate updates an existing row too, so a full
		// list plus one save never grows.
		const updated = upsertPairing(next, candidate(BOOK, OTHER_MUSIC, 200_000));
		expect(updated.pairs).toHaveLength(MAX_PAIRINGS);
	});
});
