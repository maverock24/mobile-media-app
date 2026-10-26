/**
 * The active-scene marker (`$lib/pairs/activeScene.ts`, D3/S8).
 *
 * Two rules, both plain functions: which scene the marker may keep, decided
 * against fake deck commands, and the write that stores a position on the active
 * row. The store cases seed localStorage and re-import the module exactly like
 * `tests/unit/pairs/pairings.test.ts`, because `persisted()` reads the key while
 * the module is evaluated.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { reconcileActiveScene } from '$lib/pairs/activeScene';
import { toTrackRef } from '$lib/pairs/resolve';
import type { AbPairing } from '$lib/pairs/types';
import type { DeckCommands } from '$lib/stores/deckCommands.svelte';
import type { StoredAudioFile } from '$lib/models/music';

const BOOK: StoredAudioFile = {
	source: 'native',
	name: 'Halfway Home.mp3',
	relativePath: 'books/Halfway Home.mp3',
	path: '/storage/emulated/0/Books/Halfway Home.mp3'
};

/** A different audiobook on deck A: what "deck A loaded a different track" means. */
const OTHER_BOOK: StoredAudioFile = {
	source: 'native',
	name: 'Tape Hiss.mp3',
	relativePath: 'books/Tape Hiss.mp3',
	path: '/storage/emulated/0/Books/Tape Hiss.mp3'
};

const RAIN: StoredAudioFile = {
	source: 'native',
	name: 'Rain.mp3',
	relativePath: 'music/Rain.mp3',
	path: '/storage/emulated/0/Music/Rain.mp3'
};

/** A fake deck holding `source`, or an unloaded one when `source` is null.
 *  `capture()` reports the loaded queue, not audible state: that is what makes a
 *  paused deck look like a playing one to the rule. */
function fakeDeck(source: StoredAudioFile | null): DeckCommands {
	return {
		capture: () => (source ? { source, positionSec: 12, durationSec: 3600 } : null),
		apply: async () => 'started',
		stop: () => {},
		setLoop: () => {}
	};
}

function makePair(id: number, book: StoredAudioFile, savedAt = id * 1000): AbPairing {
	return {
		id,
		name: `Book ${id}`,
		savedAt,
		a: toTrackRef(book),
		b: toTrackRef(RAIN),
		bVolume: 40,
		bSpeed: 1,
		positionSec: 12,
		durationSec: 3600
	};
}

const pair7 = makePair(7, BOOK);
const pair8 = makePair(8, OTHER_BOOK);

describe('reconcileActiveScene', () => {
	it('a pause keeps the scene active', () => {
		const setActivePair = vi.fn();

		// Deck A paused: the queue is still loaded, so `capture()` still names the
		// scene's audiobook. Nothing in this rule reads `isPlaying`, so a pause is
		// invisible to it and the marker survives to be resumed.
		const kept = reconcileActiveScene({
			activePairId: 7,
			pairs: [pair8, pair7],
			deckA: fakeDeck(BOOK),
			deckB: fakeDeck(RAIN),
			setActivePair
		});

		expect(kept).toBe(7);
		expect(setActivePair).not.toHaveBeenCalled();
	});

	it('loading a different track clears the active scene', () => {
		const setActivePair = vi.fn();

		const kept = reconcileActiveScene({
			activePairId: 7,
			pairs: [pair8, pair7],
			deckA: fakeDeck(OTHER_BOOK),
			deckB: fakeDeck(RAIN),
			setActivePair
		});

		expect(kept).toBeNull();
		expect(setActivePair).toHaveBeenCalledWith(null);
	});

	it('keeps the id of the scene that just started', () => {
		// "A different scene starts" is a new id written by the starter, and the
		// rule then finds the matching audiobook on deck A and keeps it.
		const setActivePair = vi.fn();

		const kept = reconcileActiveScene({
			activePairId: 8,
			pairs: [pair8, pair7],
			deckA: fakeDeck(OTHER_BOOK),
			deckB: fakeDeck(RAIN),
			setActivePair
		});

		expect(kept).toBe(8);
		expect(setActivePair).not.toHaveBeenCalled();
	});

	it('clears only once both decks are empty', () => {
		const emptied = vi.fn();

		// Deck A unloaded but B still looping the scene's background track: the
		// scene is still held by a deck.
		expect(
			reconcileActiveScene({
				activePairId: 7,
				pairs: [pair7],
				deckA: fakeDeck(null),
				deckB: fakeDeck(RAIN),
				setActivePair: emptied
			})
		).toBe(7);
		expect(emptied).not.toHaveBeenCalled();

		expect(
			reconcileActiveScene({
				activePairId: 7,
				pairs: [pair7],
				deckA: fakeDeck(null),
				deckB: fakeDeck(null),
				setActivePair: emptied
			})
		).toBeNull();
		expect(emptied).toHaveBeenCalledWith(null);
	});

	it('clears a marker whose row is gone', () => {
		const setActivePair = vi.fn();

		expect(
			reconcileActiveScene({
				activePairId: 99,
				pairs: [pair7],
				deckA: fakeDeck(BOOK),
				deckB: fakeDeck(RAIN),
				setActivePair
			})
		).toBeNull();
		expect(setActivePair).toHaveBeenCalledWith(null);
	});

	it('does nothing when no scene is marked active', () => {
		const setActivePair = vi.fn();

		expect(
			reconcileActiveScene({
				activePairId: null,
				pairs: [pair7],
				deckA: fakeDeck(BOOK),
				deckB: fakeDeck(RAIN),
				setActivePair
			})
		).toBeNull();
		expect(setActivePair).not.toHaveBeenCalled();
	});
});

// ── the write itself ────────────────────────────────────────────────────────
// The writer's `write` dependency is `setActivePositionSec`, so these cases pin
// that it touches the marked row and nothing else.

function seedStore(activePairId: number | null, pairs: AbPairing[]) {
	localStorage.setItem('ab-pairings', JSON.stringify({ pairs, nextId: 9, activePairId }));
}

/** Import the module graph after the seed, the way the store tests do. */
async function loadModules() {
	const scene = await import('$lib/pairs/activeScene');
	const store = await import('$lib/pairs/pairings');
	return { ...scene, pairings: store.pairings };
}

describe('setActivePositionSec', () => {
	beforeEach(() => {
		localStorage.clear();
		vi.resetModules();
	});

	it('writes the active row only', async () => {
		seedStore(7, [pair8, pair7]);
		const { pairings, setActivePositionSec } = await loadModules();

		setActivePositionSec(125, 3600);

		const active = pairings.pairs.find((pair) => pair.id === 7);
		const other = pairings.pairs.find((pair) => pair.id === 8);
		expect(active).toMatchObject({ positionSec: 125, durationSec: 3600 });
		// The scene that is not playing keeps the position it was saved with.
		expect(other).toMatchObject({ positionSec: 12, durationSec: 3600 });
	});

	it('is a no-op when no pair is active', async () => {
		seedStore(null, [pair7]);
		const { pairings, setActivePositionSec } = await loadModules();

		expect(() => setActivePositionSec(125, 3600)).not.toThrow();
		expect(pairings.pairs[0]).toMatchObject({ positionSec: 12, durationSec: 3600 });
	});
});
