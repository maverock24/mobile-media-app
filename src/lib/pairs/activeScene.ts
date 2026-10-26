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

/** Deck A's loaded track, or `null` when it has none. */
function aFileOf(deckA: DeckCommands | null) {
	return deckA?.capture()?.source ?? null;
}

/** Whether deck A's loaded track is this scene's audiobook. The one check two
 *  rules share: the marker survives only while it holds, and the position writer
 *  writes only while it holds. */
function deckAHolds(pair: AbPairing | null, deckA: DeckCommands | null): boolean {
	const aFile = aFileOf(deckA);
	return Boolean(pair && aFile && getStoredFileKey(aFile) === pair.a.key);
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

	if (deckAHolds(pair, deps.deckA)) return id;

	// Deck A is empty (unloaded, or never loaded): the scene still means
	// something while deck B holds its background track, and nothing at all once
	// both are empty.
	if (pair && !aFileOf(deps.deckA) && deps.deckB?.capture()) return id;

	deps.setActivePair(null);
	return null;
}

/** Everything the writer's activity check reads. */
export interface ActiveSceneHeldDeps {
	/** The store's current marker. */
	activePairId: number | null;
	/** The saved rows, to find the marker's scene and its audiobook ref. */
	pairs: readonly AbPairing[];
	/** Deck A's commands, or `null` while that deck is not mounted. */
	deckA: DeckCommands | null;
}

/**
 * Whether the marked scene is the one deck A holds — the position writer's
 * `isActive` (S8).
 *
 * The marker alone is not enough: it also says "this row is marked", and a
 * marker can outlive the audiobook deck A holds for a tick (a deck that loaded
 * another track between the reconcile effect and a write, a deck that unmounted).
 * `capture()` is the deck's own truth, so a write never lands on a row whose
 * audiobook is not loaded here. This is `reconcileActiveScene`'s first rule
 * without its write: an `isActive` read must not mutate the store to decide.
 */
export function activeSceneHeldByDeckA(deps: ActiveSceneHeldDeps): boolean {
	const id = deps.activePairId;
	if (id === null) return false;
	const pair = deps.pairs.find((candidate) => candidate.id === id) ?? null;
	return deckAHolds(pair, deps.deckA);
}

/** Everything the save-time marker rule reads. */
export interface SavedSceneDeps {
	/** The row the upsert wrote, or `null` when no row can be named — a save must
	 *  not mark a scene it cannot point at. */
	savedPair: AbPairing | null;
	/** Deck A's commands, or `null` while that deck is not mounted. */
	deckA: DeckCommands | null;
	/** The store's setter. Called with the row's id when deck A holds it. */
	setActivePair: (id: number | null) => void;
}

/**
 * Mark the row a save just wrote as the active scene, when it is the scene deck A
 * holds. Returns the new marker, or `null` when the row is not deck A's.
 *
 * Without this a scene saved while it played was never active: `save()` writes
 * the row but no marker, and the reconcile rule clears a marker whose audiobook
 * deck A does not hold — so the writer's `isActive` stayed false and the row's
 * position never followed playback until the human tapped the row.
 *
 * The check is the reconcile rule's, not the caller's word for it: the caller
 * knows the save resolved deck A's track a moment ago, but "a moment ago" is not
 * "now", and a marker written for a track the deck no longer holds is cleared on
 * the next reconcile anyway.
 */
export function activateSavedScene(deps: SavedSceneDeps): number | null {
	if (!deps.savedPair || !deckAHolds(deps.savedPair, deps.deckA)) return null;
	deps.setActivePair(deps.savedPair.id);
	return deps.savedPair.id;
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
