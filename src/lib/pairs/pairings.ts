/**
 * pairings.ts — the persisted A/B pairing list (D4).
 *
 * Shape: `persisted('ab-pairings', { pairs, nextId, activePairId })`, the same
 * house pattern as `podcastData` (`$lib/stores/settings.svelte.ts:110-141`):
 * one `trim` that bounds only the serialised copy, and an in-place patch at
 * module load for the values the last build could have written differently
 * (Q22 — no version field, no deletion, the init merge fills missing keys from
 * the defaults, `persisted.svelte.ts:26-31`).
 *
 * Two rules this module owns, and nothing else yet:
 *
 *  - **Newest first.** `pairs` is ordered by `savedAt` descending. S9's merge
 *    helper places a saved row at index 0, and this module normalises a stored
 *    payload into the same order on load, so a row list is never sorted
 *    differently from how it was saved.
 *  - **A 50-row bound on the stored blob.** `trim` keeps the newest
 *    `MAX_PAIRINGS`. The bound is deliberately serialisation-only: the
 *    in-memory cap is the merge helper's job in S9, exactly as `podcastData`
 *    drops episode bodies from the blob but keeps them in memory.
 *
 * Every write must reassign a top-level key (`pairings.pairs = [...]`), never
 * mutate the array in place: `persisted()` tracks one read per top-level
 * property (`persisted.svelte.ts:81-88`, Q20), so a `push`/`splice` schedules
 * no flush and the change would be lost on restart.
 *
 * Rune-free and factory-free on purpose (D10): the store object is injected
 * into every helper as a plain value, so the pure parts (`newestFirst`,
 * `trimPairings`) are unit tested without touching localStorage. This phase
 * adds no save/delete/upsert semantics; a later phase owns those.
 */
import { persisted } from '$lib/persisted.svelte';
import type { AbPairing } from './types';

/** The localStorage key. Nothing else asserts this string, so the store test pins it. */
export const PAIRINGS_KEY = 'ab-pairings';

/** How many pairs the serialised blob may hold. Newest win. */
export const MAX_PAIRINGS = 50;

/** The persisted shape. `activePairId` marks the scene deck A is writing to (D3). */
export interface PairingsState {
	pairs: AbPairing[];
	nextId: number;
	activePairId: number | null;
}

/** The default payload, as a function so each call site gets its own arrays. */
export function emptyPairings(): PairingsState {
	return { pairs: [], nextId: 0, activePairId: null };
}

/**
 * A copy of `pairs` ordered by `savedAt` descending. `Array.prototype.sort` is
 * stable, so rows saved in the same millisecond keep their stored order.
 */
export function newestFirst(pairs: readonly AbPairing[]): AbPairing[] {
	return [...pairs].sort((x, y) => y.savedAt - x.savedAt);
}

/**
 * The `trim` for the persisted store: a size-bounded snapshot holding the
 * newest `MAX_PAIRINGS` rows. It returns a new state object, never mutating the
 * live one — `trim` is called with the whole store before serialisation and its
 * result must not leak back into memory.
 */
export function trimPairings(state: PairingsState): PairingsState {
	return { ...state, pairs: newestFirst(state.pairs).slice(0, MAX_PAIRINGS) };
}

export const pairings = persisted(PAIRINGS_KEY, emptyPairings(), { trim: trimPairings });

// Load-time normalisation, in the style of `appSettings.listTileTone` and the
// `playbackSpeed` migration (`settings.svelte.ts:20`, `:62-68`): enforce
// newest-first and tolerate a corrupt `pairs` (non-array) rather than letting a
// `for`/`map` throw on the first render.
pairings.pairs = newestFirst(Array.isArray(pairings.pairs) ? pairings.pairs : []);
