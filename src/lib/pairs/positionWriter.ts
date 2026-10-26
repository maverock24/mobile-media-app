/**
 * positionWriter.ts — the trickle of the active scene's position (D3, S8).
 *
 * A saved scene has to remember where the listener stopped, which means deck A
 * has to tell the store while it plays, not only when the scene is saved. This
 * module is that teller: one writer per deck (only deck A owns one), ticking
 * every five seconds while the deck is playing, plus a write at each moment the
 * position becomes worth keeping — pause, seek, stop, and the app going to the
 * background.
 *
 * **Why not `timeupdate`.** The player already throttles `state.currentTime` to
 * ~4 Hz (`$lib/audio/player.svelte.ts:141`, `:551-556`), and every write
 * rewrites the whole `ab-pairings` key (`$lib/persisted.svelte.ts:46-49`), so a
 * per-tick writer would serialise the blob four times a second. Five seconds of
 * drift is invisible against a resume, and the named events cover the rest.
 *
 * **Coalescing.** A slider drag fires `seek` on every pixel, so `flush()` writes
 * the first seek immediately and collapses the rest of a burst into a single
 * trailing write on the next tick. `flushNow()` is the unconditional variant,
 * for the moments where the position is about to be lost: a pause, a stop, the
 * app being hidden. A rejected `flush()` is never dropped — it is held in
 * `pending` and written by the next tick, even when the deck has stopped
 * playing by then.
 *
 * **Never a halted zero.** The one number that must never reach the store is the
 * `0` that `haltPlayback()` writes when a queue ends. Every flush point can see
 * it — the cross-source stop seam flushes just before `player.stop()`, which
 * halts too — so `isHalted()` drops a zero at write time and a rewind to the
 * start (a seek, which clears the flag) still persists.
 *
 * **Only the active scene.** The writer never decides which row to write: the
 * injected `isActive` says whether the deck still holds the scene the store has
 * marked active, and a false read makes every entry point a no-op. Nothing here
 * touches the store, so the whole module is unit tested with a fake clock, a
 * fake timer and a fake write (D10).
 */

/** The two numbers a scene stores: where deck A is, and how long its book is. */
export interface DeckPosition {
	positionSec: number;
	durationSec: number;
}

/** Everything the writer needs from the world, injected so it is testable. */
export interface PositionWriterDeps {
	/** Whether the scene the store marks active is still the one this deck holds.
	 *  A false read makes every entry point a no-op, including the tick. */
	isActive: () => boolean;
	/** Whether the deck is producing sound right now. The five-second tick writes
	 *  only while true; a deck that stopped would otherwise persist the `0` that
	 *  `haltPlayback()` leaves behind. */
	isPlaying: () => boolean;
	/** Whether the deck's zero came from a halt rather than a rewind. A queue that
	 *  ends, and every `stop()`/`clear()`, zero the transport
	 *  (`$lib/audio/player.svelte.ts` `haltPlayback()`), and the cross-source stop
	 *  seam flushes right after one of those. Only the deck can tell that zero from
	 *  a deliberate rewind, so it answers here and the writer never guesses: a zero
	 *  read while this is true is dropped, at every entry point. */
	isHalted: () => boolean;
	/** The deck's position and duration, read at write time. */
	read: () => DeckPosition;
	/** Persist the position of the active scene. */
	write: (positionSec: number, durationSec: number) => void;
	/** How often the while-playing write happens. Defaults to 5000 ms. */
	intervalMs?: number;
	/** How close two seek writes have to be to count as one burst. Defaults to 1000 ms. */
	burstMs?: number;
	/** The clock, for the burst window. Defaults to `Date.now`. */
	now?: () => number;
	/** A repeating timer. Returns its own cancel function. Defaults to `setInterval`. */
	ticker?: (tick: () => void, intervalMs: number) => () => void;
	/** Subscribe to "the document is hidden". Returns the unsubscribe. Defaults to
	 *  the browser's `visibilitychange`; a test passes its own. */
	onHidden?: (handler: () => void) => () => void;
}

/** The handle the deck keeps. Every method is safe to call before `start()` and
 *  after `stop()`; only the flush pair actually writes. */
export interface PositionWriter {
	/** Begin the five-second tick and the visibility subscription. Idempotent. */
	start(): void;
	/** Write a held-back burst value if there is one, then tear both down. */
	stop(): void;
	/** Write now, unless a burst write just happened; then hold one trailing write. */
	flush(): void;
	/** Write now, unconditionally (pause, stop, background). */
	flushNow(): void;
}

/** The while-playing interval. */
export const POSITION_INTERVAL_MS = 5000;

/** Two seeks closer together than this are one write. */
export const POSITION_BURST_MS = 1000;

/** The default `onHidden`: the browser's own visibility signal. Guarded for SSR,
 *  where the deck never mounts but the module still gets imported. */
function documentHiddenSubscription(handler: () => void): () => void {
	if (typeof document === 'undefined') return () => {};
	const listener = () => {
		if (document.visibilityState === 'hidden') handler();
	};
	document.addEventListener('visibilitychange', listener);
	return () => document.removeEventListener('visibilitychange', listener);
}

/**
 * Build one writer. Nothing runs until `start()`, so a deck that never owns a
 * scene (deck B) pays nothing for the import.
 */
export function createPositionWriter(deps: PositionWriterDeps): PositionWriter {
	const intervalMs = deps.intervalMs ?? POSITION_INTERVAL_MS;
	const burstMs = deps.burstMs ?? POSITION_BURST_MS;
	const now = deps.now ?? (() => Date.now());
	const ticker: (tick: () => void, ms: number) => () => void =
		deps.ticker ??
		((tick, ms) => {
			const handle = setInterval(tick, ms);
			return () => clearInterval(handle);
		});
	const onHidden = deps.onHidden ?? documentHiddenSubscription;

	let cancelTick: (() => void) | null = null;
	let cancelHidden: (() => void) | null = null;
	let lastWritten: DeckPosition | null = null;
	let lastBurstAt = Number.NEGATIVE_INFINITY;
	let pending = false;

	/** The one place that calls `write`. Drops an identical pair, so a deck that
	 *  pauses twice (or a tick with nothing to say) does not touch the store. */
	function writeNow(): void {
		pending = false;
		if (!deps.isActive()) return;
		const next = deps.read();
		// A zero the deck reports as halted is not a position: it is the reset a
		// finished queue or a stop left behind. A deliberate rewind to the start is
		// the deck's to distinguish, and it does — `isHalted()` is false there.
		if (next.positionSec <= 0 && deps.isHalted()) return;
		if (
			lastWritten &&
			lastWritten.positionSec === next.positionSec &&
			lastWritten.durationSec === next.durationSec
		) {
			return;
		}
		lastWritten = { positionSec: next.positionSec, durationSec: next.durationSec };
		deps.write(next.positionSec, next.durationSec);
	}

	/** The five-second tick: the while-playing write, plus anything a coalesced
	 *  seek burst left behind. */
	function tick(): void {
		if (!deps.isActive()) {
			pending = false;
			return;
		}
		if (!pending && !deps.isPlaying()) return;
		writeNow();
	}

	function flush(): void {
		if (!deps.isActive()) return;
		const at = now();
		if (at - lastBurstAt < burstMs) {
			pending = true;
			return;
		}
		lastBurstAt = at;
		writeNow();
	}

	return {
		start() {
			if (cancelTick !== null) return;
			cancelTick = ticker(tick, intervalMs);
			cancelHidden = onHidden(writeNow);
		},
		stop() {
			if (pending) writeNow();
			cancelTick?.();
			cancelHidden?.();
			cancelTick = null;
			cancelHidden = null;
		},
		flush,
		flushNow: writeNow
	};
}
