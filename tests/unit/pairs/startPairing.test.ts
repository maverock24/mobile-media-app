/**
 * Starting a scene (`$lib/pairs/startPairing.ts`, D5/D8).
 *
 * Both decks are fakes (D10): the module only calls `DeckCommands` and the
 * injected setters, so the order of the calls, the arguments each one receives
 * and the toasts raised are all observable without a `Player`, a library or a
 * mounted view. The last call of each kind is what matters; `order` records the
 * sequence the four playback calls happen in.
 */
import { describe, it, expect, vi } from 'vitest';
import { startPairing, type StartPairingDeps } from '$lib/pairs/startPairing';
import type { AbPairing, PairingTrackRef } from '$lib/pairs/types';
import type { DeckApplyStatus, DeckCommands } from '$lib/stores/deckCommands.svelte';

const bookRef: PairingTrackRef = {
	key: 'n:books/Atomic Habits.mp3',
	name: 'Atomic Habits.mp3',
	relativePath: 'books/Atomic Habits.mp3',
	source: 'native',
	path: '/storage/emulated/0/Books/Atomic Habits.mp3',
};

const rainRef: PairingTrackRef = {
	key: 'n:music/Rain.mp3',
	name: 'Rain.mp3',
	relativePath: 'music/Rain.mp3',
	source: 'native',
	path: '/storage/emulated/0/Music/Rain.mp3',
};

/** A scene at 5:00 with Rain at 40% and 0.9x, the shape S6 renders. */
function makePair(overrides: Partial<AbPairing> = {}): AbPairing {
	return {
		id: 7,
		name: 'Atomic Habits + Rain, 4.6.2026',
		savedAt: 1775433600000,
		a: bookRef,
		b: rainRef,
		bVolume: 40,
		bSpeed: 0.9,
		positionSec: 300,
		durationSec: 3600,
		...overrides,
	};
}

/** One fake deck. `order` lets a test pin the sequence across both decks. */
function fakeDeck(kind: 'A' | 'B', status: DeckApplyStatus, order: string[]) {
	return {
		capture: vi.fn(() => null),
		apply: vi.fn(async () => {
			order.push(`${kind}.apply`);
			return status;
		}),
		stop: vi.fn(() => {
			order.push(`${kind}.stop`);
		}),
		setLoop: vi.fn(),
	} satisfies DeckCommands;
}

function harness(
	options: {
		aStatus?: DeckApplyStatus;
		bStatus?: DeckApplyStatus;
		withoutDeckA?: boolean;
		bIsPlaying?: boolean;
	} = {}
) {
	const order: string[] = [];
	const deckA = options.withoutDeckA ? null : fakeDeck('A', options.aStatus ?? 'started', order);
	const deckB = fakeDeck('B', options.bStatus ?? 'started', order);

	const deps = {
		deckA,
		deckB,
		isDeckBPlaying: vi.fn(() => options.bIsPlaying ?? false),
		setDeckBVolume: vi.fn((volume: number) => {
			order.push(`volume:${volume}`);
		}),
		setDeckBSpeed: vi.fn((speed: number) => {
			order.push(`speed:${speed}`);
		}),
		setActivePair: vi.fn(),
		toast: vi.fn()
	} satisfies StartPairingDeps;

	return { deps, deckA, deckB, order };
}

describe('startPairing', () => {
	it('starts A at the stored position', async () => {
		const pair = makePair();
		const { deps, deckA } = harness();

		await expect(startPairing(pair, deps)).resolves.toBe('started');

		// The position comes from the row, and nothing else is passed: A keeps the
		// queue's own loop behaviour rather than borrowing B's (D2).
		expect(deckA!.apply).toHaveBeenCalledWith(bookRef, 300);
		expect(deckA!.apply.mock.calls[0]).toHaveLength(2);

		// The scene is now the write target for the position writer, and a clean
		// start says nothing to the human.
		expect(deps.setActivePair).toHaveBeenCalledWith(7);
		expect(deps.toast).not.toHaveBeenCalled();
	});

	it('starts B looping at the stored volume and speed', async () => {
		const pair = makePair();
		const { deps, deckB, order } = harness();

		await expect(startPairing(pair, deps)).resolves.toBe('started');

		expect(deps.setDeckBVolume).toHaveBeenCalledWith(40);
		expect(deps.setDeckBSpeed).toHaveBeenCalledWith(0.9);

		// B is a background loop from the top of its own track (D2): position 0,
		// `loop: 'one'`, and nothing about A's position leaks into it.
		expect(deckB.apply).toHaveBeenCalledWith(rainRef, 0, { loop: 'one' });

		// Volume and speed land after A has started and before B loads a src, so
		// B's first frame is already at 40% and 0.9x rather than at the last
		// track's levels.
		expect(order).toEqual(['A.apply', 'volume:40', 'speed:0.9', 'B.apply']);
	});

	it('toasts and starts nothing when A is missing', async () => {
		const pair = makePair();
		const { deps, deckB } = harness({ aStatus: 'missing' });

		await expect(startPairing(pair, deps)).resolves.toBe('aMissing');

		// D5: the audiobook is the scene, so its absence starts nothing else —
		// not B, not the volume and speed writes, not an active scene.
		expect(deckB.apply).not.toHaveBeenCalled();
		expect(deps.setDeckBVolume).not.toHaveBeenCalled();
		expect(deps.setDeckBSpeed).not.toHaveBeenCalled();
		expect(deps.setActivePair).not.toHaveBeenCalled();

		expect(deps.toast).toHaveBeenCalledTimes(1);
		expect(deps.toast).toHaveBeenCalledWith({
			message: 'That audiobook is missing, so nothing started.',
			type: 'error'
		});
	});

	it('starts A alone when B is missing', async () => {
		const pair = makePair();
		const { deps, deckB } = harness({ bStatus: 'missing' });

		await expect(startPairing(pair, deps)).resolves.toBe('bMissing');

		// A found its file and is playing; B's failure does not undo that.
		expect(deckB.apply).toHaveBeenCalledWith(rainRef, 0, { loop: 'one' });
		expect(deps.setActivePair).toHaveBeenCalledWith(7);

		// Exactly one warning, and it blames the background track only.
		expect(deps.toast).toHaveBeenCalledTimes(1);
		expect(deps.toast).toHaveBeenCalledWith({
			message: 'The background track is missing. The audiobook started alone.',
			type: 'warning'
		});
	});

	it('stops B when the pair has no background track', async () => {
		const pair = makePair({ b: null });

		// B is audible: the scene has no music, so B is stopped through its own
		// commands and A plays alone.
		const playing = harness({ bIsPlaying: true });
		await expect(startPairing(pair, playing.deps)).resolves.toBe('started');

		expect(playing.deckB.stop).toHaveBeenCalledTimes(1);
		expect(playing.deckB.apply).not.toHaveBeenCalled();
		expect(playing.deps.setActivePair).toHaveBeenCalledWith(7);
		expect(playing.deps.setDeckBVolume).not.toHaveBeenCalled();
		expect(playing.deps.setDeckBSpeed).not.toHaveBeenCalled();
		expect(playing.deps.toast).not.toHaveBeenCalled();

		// B is paused but has a queue: it is left exactly as it was.
		const paused = harness({ bIsPlaying: false });
		await expect(startPairing(pair, paused.deps)).resolves.toBe('started');

		expect(paused.deckB.stop).not.toHaveBeenCalled();
		expect(paused.deckB.apply).not.toHaveBeenCalled();
		expect(paused.deps.setActivePair).toHaveBeenCalledWith(7);
	});

	it('returns idle when deck A has not registered', async () => {
		const pair = makePair();
		const { deps, deckB } = harness({ withoutDeckA: true });

		await expect(startPairing(pair, deps)).resolves.toBe('idle');

		expect(deckB.apply).not.toHaveBeenCalled();
		expect(deps.setActivePair).not.toHaveBeenCalled();
		expect(deps.toast).toHaveBeenCalledWith({
			message: 'Deck A is not ready yet.',
			type: 'error'
		});
	});
});
