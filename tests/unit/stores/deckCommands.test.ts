/**
 * The per-deck command registry (`$lib/stores/deckCommands.svelte.ts`).
 *
 * Two fake decks stand in for the mounted views (D10): the registry only moves
 * closures around, so the real `Player` and the real library are not needed to
 * pin its routing. Deck-side resolution (`apply` calling `resolvePairingTrack`)
 * is exercised through these fakes; the resolver itself is covered by
 * `tests/unit/pairs/resolve.test.ts`.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { StoredAudioFile } from '$lib/models/music';
import type { PairingTrackRef } from '$lib/pairs/types';
import {
	getDeckCommands,
	registerDeckCommands,
	type DeckCapture,
	type DeckCommands,
	type DeckId,
} from '$lib/stores/deckCommands.svelte';

const source = (name: string): StoredAudioFile => ({
	source: 'web',
	name,
	relativePath: `books/${name}`,
	file: new File([], name),
});

const ref: PairingTrackRef = {
	key: 'n:books/Atomic Habits.mp3',
	name: 'Atomic Habits.mp3',
	relativePath: 'books/Atomic Habits.mp3',
	source: 'native',
	path: '/storage/emulated/0/Books/Atomic Habits.mp3',
};

/** One fake deck. Every member is a spy so a test can see which deck answered. */
function fakeDeck(name: string) {
	return {
		capture: vi.fn((): DeckCapture | null => ({ source: source(name), positionSec: 12, durationSec: 300 })),
		apply: vi.fn(async () => 'started' as const),
		stop: vi.fn(),
		setLoop: vi.fn(),
	} satisfies DeckCommands;
}

// Registrations outlive a test unless they are torn down, and the slots are
// module state. Every cleanup is idempotent, so running them twice is harmless.
const cleanups: Array<() => void> = [];

function register(deck: DeckId, impl: DeckCommands): () => void {
	const unregister = registerDeckCommands(deck, impl);
	cleanups.push(unregister);
	return unregister;
}

afterEach(() => {
	while (cleanups.length > 0) cleanups.pop()!();
});

describe('deckCommands registry', () => {
	it('registers and unregisters by deck', async () => {
		const a = fakeDeck('a.mp3');
		const b = fakeDeck('b.mp3');
		const unregisterA = register('A', a);
		register('B', b);

		expect(getDeckCommands('A')).toBe(a);
		expect(getDeckCommands('B')).toBe(b);

		// A command reaches the deck it names and no other.
		await expect(getDeckCommands('B')!.apply(ref, 5, { loop: 'one' })).resolves.toBe('started');
		expect(b.apply).toHaveBeenCalledWith(ref, 5, { loop: 'one' });
		expect(a.apply).not.toHaveBeenCalled();

		// Unmounting A leaves B mounted: two views, two slots.
		unregisterA();
		expect(getDeckCommands('A')).toBeNull();
		expect(getDeckCommands('B')).toBe(b);
	});

	it('the last registered deck wins for the same id', async () => {
		const first = fakeDeck('first.mp3');
		const second = fakeDeck('second.mp3');
		register('A', first);
		register('A', second);

		expect(getDeckCommands('A')).toBe(second);

		await expect(getDeckCommands('A')!.apply(ref, 30)).resolves.toBe('started');
		expect(second.apply).toHaveBeenCalledWith(ref, 30);
		expect(first.apply).not.toHaveBeenCalled();
	});

	it('a consumer sees no commands for an unregistered deck', () => {
		// The panel's read path: one derived per deck, so "Save is disabled while
		// deck A has no track" (D6) has a defined value before the decks mount.
		const consumer = (deck: DeckId) => getDeckCommands(deck)?.capture() ?? null;

		expect(consumer('A')).toBeNull();
		expect(consumer('B')).toBeNull();

		const a = fakeDeck('a.mp3');
		register('A', a);
		expect(consumer('A')).toEqual({ source: source('a.mp3'), positionSec: 12, durationSec: 300 });
		expect(consumer('B')).toBeNull();

		// A captured deck that has nothing loaded reports null rather than a
		// half-filled capture, which is what the consumer keys Save off.
		a.capture.mockReturnValueOnce(null);
		expect(consumer('A')).toBeNull();
	});

	it('a stale unregister does not evict a remounted deck', () => {
		const first = fakeDeck('first.mp3');
		const second = fakeDeck('second.mp3');
		const unregisterFirst = register('A', first);
		register('A', second);

		// Svelte can run the previous mount's cleanup after the next mount's
		// registration; clearing the slot blindly would leave the deck dead.
		unregisterFirst();
		expect(getDeckCommands('A')).toBe(second);
	});
});
