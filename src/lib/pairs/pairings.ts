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
 * `trimPairings`, `derivePairingName`, `upsertPairing`) are unit tested without
 * touching localStorage. `removePairing` is the delete write (S6) and
 * `upsertPairing` is the save one (S9), which the panel applies to the store.
 */
import { persisted } from '$lib/persisted.svelte';
import type { AbPairing, PairingTrackRef } from './types';

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

/** A saved file's name without its extension: `Book One.m4a` -> `Book One`.
 *  Deliberately not `parseFilename`: a pair is named by what the file is called,
 *  not by its `artist - title` split. */
function withoutExtension(name: string): string {
	const dot = name.lastIndexOf('.');
	return dot > 0 ? name.slice(0, dot) : name;
}

/**
 * The auto name for a saved scene (D9): deck A's file name, deck B's file name
 * when there is one, and the date of the save. `toLocaleDateString()` is the
 * same call the row's date line makes, so the two never disagree.
 */
export function derivePairingName(
	a: PairingTrackRef,
	b: PairingTrackRef | null,
	savedAt: number
): string {
	const date = new Date(savedAt).toLocaleDateString();
	const aName = withoutExtension(a.name);
	return b ? `${aName} + ${withoutExtension(b.name)}, ${date}` : `${aName}, ${date}`;
}

/** Everything one Save press knows about the scene. `id` is not here: whether a
 *  row is new or updated is decided by the A and B refs, not by the caller. */
export interface PairingCandidate {
	a: PairingTrackRef;
	b: PairingTrackRef | null;
	positionSec: number;
	durationSec: number;
	bVolume: number;
	bSpeed: number;
	savedAt: number;
}

/** D6's dedupe key: the same audiobook and the same background track (or no
 *  background track on both) is one row. A different B is a different scene. */
function sameSources(
	pair: AbPairing,
	a: PairingTrackRef,
	b: PairingTrackRef | null
): boolean {
	return pair.a.key === a.key && (pair.b?.key ?? null) === (b?.key ?? null);
}

/**
 * The row a save with these two refs can resolve to: the same D6 key
 * `upsertPairing` dedupes on, as a read. The panel needs it after an upsert
 * because a save may have inserted a row whose id it does not know, and the id
 * is what the active-scene marker names (D3). `null` when no row matches, which
 * only a caller that passed refs the upsert did not see can produce.
 */
export function findPairing(
	pairs: readonly AbPairing[],
	a: PairingTrackRef,
	b: PairingTrackRef | null
): AbPairing | null {
	return pairs.find((pair) => sameSources(pair, a, b)) ?? null;
}

/**
 * The next state after one Save press (D6, D9), newest first, capped at
 * `MAX_PAIRINGS`.
 *
 * A pair with the same A ref and the same B ref is updated in place: it keeps
 * its id, takes the candidate's position, duration, volume, speed and date, and
 * moves to the front. Anything else is a new row with `nextId`, prepended, and
 * `nextId` moves on. The cap is applied in memory as well as by `trim` so a
 * 51-row list never disagrees with the 50-row blob that reloads it.
 *
 * Returns a new object and never mutates `state`, which is the live store when
 * the panel calls this: the caller reassigns `pairs` and `nextId` itself.
 */
export function upsertPairing(state: PairingsState, candidate: PairingCandidate): PairingsState {
	const index = state.pairs.findIndex((pair) => sameSources(pair, candidate.a, candidate.b));
	const existing = index >= 0 ? state.pairs[index] : null;
	const entry: AbPairing = {
		id: existing ? existing.id : state.nextId,
		name: derivePairingName(candidate.a, candidate.b, candidate.savedAt),
		savedAt: candidate.savedAt,
		a: candidate.a,
		b: candidate.b,
		bVolume: candidate.bVolume,
		bSpeed: candidate.bSpeed,
		positionSec: candidate.positionSec,
		durationSec: candidate.durationSec,
	};
	const rest = index >= 0 ? state.pairs.filter((_, i) => i !== index) : state.pairs;
	return {
		...state,
		pairs: newestFirst([entry, ...rest]).slice(0, MAX_PAIRINGS),
		nextId: existing ? state.nextId : state.nextId + 1,
	};
}

export const pairings = persisted(PAIRINGS_KEY, emptyPairings(), { trim: trimPairings });

/**
 * Drop one row and persist the shorter list.
 *
 * Reassigns `pairs` instead of splicing it in place: `persisted()` tracks one
 * read per top-level key, so only a reassignment schedules a flush. Clearing
 * `activePairId` when it names the deleted row keeps the position writer (S8)
 * from writing to a scene that no longer exists — a rule the plan puts here
 * rather than in the panel.
 */
export function removePairing(id: number): void {
	pairings.pairs = pairings.pairs.filter((pair) => pair.id !== id);
	if (pairings.activePairId === id) pairings.activePairId = null;
}

/**
 * Mark which scene deck A is playing, or clear it with `null` (D3).
 *
 * This is the switch the position writer (S8) keys off: only the active scene
 * is written, so starting one scene and browsing another never rewrites the
 * position of the one that is not playing. Starting a scene overwrites the id
 * in place, which is also how "another scene started" clears the previous one,
 * and the Pairs view clears it once neither deck is audible any more.
 */
export function setActivePair(id: number | null): void {
	pairings.activePairId = id;
}

// Load-time normalisation, in the style of `appSettings.listTileTone` and the
// `playbackSpeed` migration (`settings.svelte.ts:20`, `:62-68`): enforce
// newest-first and tolerate a corrupt `pairs` (non-array) rather than letting a
// `for`/`map` throw on the first render.
pairings.pairs = newestFirst(Array.isArray(pairings.pairs) ? pairings.pairs : []);
