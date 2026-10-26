/**
 * format.ts — the one text format a pairings row needs that is not already
 * exported (D9).
 *
 * Kept out of the view so the row markup stays thin and the number is unit
 * tested without mounting a component. A position is not here: the row renders
 * `formatClock` (`$lib/models/music.ts:212-219`) directly, the same helper the
 * MiniPlayer and PlayerControls use, so there is no second copy of the hours
 * rule to drift.
 */

/** Deck B's volume as a whole percentage, e.g. `40%`. */
export function formatVolume(volume: number): string {
	return `${Math.round(volume)}%`;
}
