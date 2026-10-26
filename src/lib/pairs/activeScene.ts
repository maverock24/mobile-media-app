/**
 * activeScene.ts — the two rules the active-scene marker obeys (D3, S8).
 *
 * The store's `activePairId` says which saved scene deck A is playing, and two
 * things depend on it: the position writer only writes that row (S8), and the
 * row is drawn as the active one. Both rules live here, as plain functions over
 * injected deck commands (D10), so they are unit tested without a mounted view
 * and without a `Player`.
 *
 * **When a scene stops being active.** A pause is not the end of a scene: the
 * deck still holds the audiobook, and the whole point of the marker is that the
 * listener can resume where they stopped. So the marker survives a pause, a
 * stop through the cross-source claim, and a deck that merely goes idle. It is
 * cleared only when it cannot mean anything any more:
 *
 *  - a different scene started (the starter overwrites the id, and the new id is
 *    kept below because deck A now holds that scene's audiobook),
 *  - deck A loaded a different track, so the audiobook of this scene is gone,
 *  - both decks are empty or unloaded, so nothing holds the scene at all,
 *  - the row itself is gone (deleted while it played).
 *
 * Previously this rule was an `$effect` inside `PairsView.svelte` keyed on
 * "either deck is audible", which cleared the marker the moment the listener
 * paused and made a paused-then-resumed scene stop tracking its position.
 */
import { getStoredFileKey } from '$lib/models/music';
import type { DeckCommands } from '$lib/stores/deckCommands.svelte';
import { pairings } from './pairings';
import type { AbPairing } from './types';

/** Everything the decision needs, so the caller only reads the store. */
export interface ActiveSceneDeps {
	/** The store's current marker. */
	activePairId: number | null;
	/** The saved rows, to find the marker's scene and its audiobook ref. */
	pairs: readonly AbPairing[];
	/** Deck A's commands, or `null` while that deck is not mounted. */
	deckA: DeckCommands | null;
	/** Deck B's commands, or `null` while that deck is not mounted. */
	deckB: DeckCommands | null;
	/** The store's setter. Called with `null` only when the marker must go. */
	setActivePair: (id: number | null) => void;
}

/**
 * The id the marker should keep, after checking the decks against it.
 *
 * Returns the id when the scene is still held, and `null` (after calling
 * `setActivePair(null)`) when it is not. Reads each deck through its own
 * `capture()`, which reports the loaded queue rather than audible state: that
 * is what makes a paused scene look identical to a playing one here, on
 * purpose.
 */
export function reconcileActiveScene(deps: ActiveSceneDeps): number | null {
	const id = deps.activePairId;
	if (id === null) return null;

	const pair = deps.pairs.find((candidate) => candidate.id === id) ?? null;
	const aFile = deps.deckA?.capture()?.source ?? null;

	if (pair && aFile && getStoredFileKey(aFile) === pair.a.key) return id;

	// Deck A is empty (unloaded, or never loaded): the scene still means
	// something while deck B holds its background track, and nothing at all once
	// both are empty.
	if (pair && !aFile && deps.deckB?.capture()) return id;

	deps.setActivePair(null);
	return null;
}

/**
 * Store `positionSec` and `durationSec` on the active row, and only on it.
 *
 * A no-op when no scene is marked active or the marked row is gone, which is
 * what keeps the writer harmless after a delete. Reassigns `pairs` instead of
 * patching the row in place: `persisted()` tracks one read per top-level key
 * (`$lib/persisted.svelte.ts:79-88`), so only a reassignment schedules a write.
 */
export function setActivePositionSec(positionSec: number, durationSec: number): void {
	const id = pairings.activePairId;
	if (id === null) return;

	const current = pairings.pairs.find((pair) => pair.id === id);
	if (!current) return;
	if (current.positionSec === positionSec && current.durationSec === durationSec) return;

	pairings.pairs = pairings.pairs.map((pair) =>
		pair.id === id ? { ...pair, positionSec, durationSec } : pair
	);
}
