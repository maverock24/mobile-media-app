/**
 * format.ts — the two text formats a pairings row needs (D9).
 *
 * Kept out of the view so the row markup stays thin and both numbers are unit
 * tested without mounting a component. `formatPosition` delegates to
 * `formatClock` (`$lib/models/music.ts:212-219`) rather than re-deriving the
 * hours rule: the MiniPlayer and PlayerControls already format a position the
 * same way, and a second copy would drift.
 */
import { formatClock } from '$lib/models/music';

/** A stored position or duration as `m:ss`, or `h:mm:ss` once it passes an hour. */
export function formatPosition(seconds: number): string {
	return formatClock(seconds);
}

/** Deck B's volume as a whole percentage, e.g. `40%`. */
export function formatVolume(volume: number): string {
	return `${Math.round(volume)}%`;
}
