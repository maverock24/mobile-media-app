/**
 * The position writer (`$lib/pairs/positionWriter.ts`, D3/S8).
 *
 * The whole module is injected, so these cases drive it with a fake clock, a
 * fake timer and a fake write: no `Player`, no store, no real five seconds. The
 * deck's position is a plain number the harness moves, which is what lets a
 * case pin *which* value reached the store rather than only how many writes
 * happened. The visibility case is the one exception: it uses the real
 * `document` subscription, because that default is the code the APK runs.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
	createPositionWriter,
	POSITION_BURST_MS,
	POSITION_INTERVAL_MS,
	type DeckPosition,
	type PositionWriterDeps
} from '$lib/pairs/positionWriter';

interface Harness {
	state: { positionSec: number; durationSec: number; playing: boolean; active: boolean };
	written: DeckPosition[];
	intervals: number[];
	cancelled: { ticker: number; hidden: number };
	writer: ReturnType<typeof createPositionWriter>;
	/** Move the clock without firing the tick (a seek between two ticks). */
	advanceClock: (ms: number) => void;
	/** Advance the clock a second at a time, firing the tick every five seconds,
	 *  the way a playing deck and a running timer do together. */
	advance: (ms: number) => void;
	fireTick: () => void;
	fireHidden: () => void;
}

function makeHarness(options: { documentHidden?: boolean } = {}): Harness {
	const state = { positionSec: 0, durationSec: 3600, playing: true, active: true };
	const written: DeckPosition[] = [];
	const intervals: number[] = [];
	const cancelled = { ticker: 0, hidden: 0 };
	let clock = 0;
	let tick: (() => void) | null = null;
	let hidden: (() => void) | null = null;

	const deps: PositionWriterDeps = {
		isActive: () => state.active,
		isPlaying: () => state.playing,
		read: () => ({ positionSec: state.positionSec, durationSec: state.durationSec }),
		write: (positionSec, durationSec) => {
			written.push({ positionSec, durationSec });
		},
		now: () => clock,
		ticker: (fn, ms) => {
			intervals.push(ms);
			tick = fn;
			return () => {
				cancelled.ticker += 1;
			};
		}
	};

	// The default `onHidden` is the browser subscription, so a case that wants to
	// exercise it leaves this unset.
	if (!options.documentHidden) {
		deps.onHidden = (handler) => {
			hidden = handler;
			return () => {
				cancelled.hidden += 1;
			};
		};
	}

	const advanceClock = (ms: number) => {
		clock += ms;
	};

	const advance = (ms: number) => {
		for (let elapsed = 0; elapsed < ms; elapsed += 1000) {
			clock += 1000;
			state.positionSec += 1;
			if (clock % POSITION_INTERVAL_MS === 0) tick?.();
		}
	};

	return {
		state,
		written,
		intervals,
		cancelled,
		writer: createPositionWriter(deps),
		advanceClock,
		advance,
		fireTick: () => tick?.(),
		fireHidden: () => hidden?.()
	};
}

/** Pretend the document is hidden (or visible again) by shadowing the jsdom
 *  getter; `afterEach` drops the own property so the prototype takes over. */
function setVisibility(value: 'hidden' | 'visible') {
	Object.defineProperty(document, 'visibilityState', {
		configurable: true,
		get: () => value
	});
}

afterEach(() => {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	delete (document as any).visibilityState;
});

describe('positionWriter', () => {
	it('writes every five seconds while playing', () => {
		const harness = makeHarness();
		harness.writer.start();

		// The tick is five seconds, not the player's 4 Hz timeupdate.
		expect(harness.intervals).toEqual([POSITION_INTERVAL_MS]);
		expect(harness.written).toEqual([]);

		harness.advance(12_000);

		// Two ticks in twelve seconds, each with the position at that moment.
		expect(harness.written).toEqual([
			{ positionSec: 5, durationSec: 3600 },
			{ positionSec: 10, durationSec: 3600 }
		]);
	});

	it('writes immediately on pause', () => {
		const harness = makeHarness();
		harness.writer.start();
		harness.state.positionSec = 42;

		// No tick has fired yet: the write is the pause, not the interval.
		harness.writer.flushNow();
		expect(harness.written).toEqual([{ positionSec: 42, durationSec: 3600 }]);

		// A paused deck that is later stopped has `haltPlayback()` zero its
		// position; the tick must not persist that 0 over the real one.
		harness.state.playing = false;
		harness.state.positionSec = 0;
		harness.fireTick();
		expect(harness.written).toEqual([{ positionSec: 42, durationSec: 3600 }]);
	});

	it('writes immediately on seek and coalesces a burst', () => {
		const harness = makeHarness();
		harness.writer.start();

		harness.state.positionSec = 10;
		harness.writer.flush();
		expect(harness.written).toEqual([{ positionSec: 10, durationSec: 3600 }]);

		// A slider drag: five seeks inside the burst window, none of them written
		// on its own.
		for (const position of [20, 30, 40, 50, 60]) {
			harness.advanceClock(POSITION_BURST_MS / 10);
			harness.state.positionSec = position;
			harness.writer.flush();
		}
		expect(harness.written).toHaveLength(1);

		// The burst leaves one trailing write, and it lands even though the deck
		// has stopped playing in the meantime.
		harness.state.playing = false;
		harness.fireTick();
		expect(harness.written).toEqual([
			{ positionSec: 10, durationSec: 3600 },
			{ positionSec: 60, durationSec: 3600 }
		]);

		// Held back once, written once: the next tick has nothing to add.
		harness.fireTick();
		expect(harness.written).toHaveLength(2);
	});

	it('writes on visibility hidden', () => {
		// No fake subscription: the real `visibilitychange` path is the one under
		// test, which is what an APK going to the background runs.
		const harness = makeHarness({ documentHidden: true });
		harness.writer.start();
		harness.state.positionSec = 30;

		setVisibility('hidden');
		document.dispatchEvent(new Event('visibilitychange'));
		expect(harness.written).toEqual([{ positionSec: 30, durationSec: 3600 }]);

		// Still hidden, same position: nothing more.
		document.dispatchEvent(new Event('visibilitychange'));
		expect(harness.written).toHaveLength(1);

		// Coming back with a new position writes nothing: only hiding does.
		harness.state.positionSec = 35;
		setVisibility('visible');
		document.dispatchEvent(new Event('visibilitychange'));
		expect(harness.written).toHaveLength(1);

		harness.writer.stop();
	});

	it('never writes a non-active scene', () => {
		const harness = makeHarness();
		harness.writer.start();

		// The deck is playing, but the store marks another scene active.
		harness.state.active = false;

		harness.advance(30_000);
		harness.writer.flush();
		harness.writer.flushNow();
		harness.fireHidden();
		harness.fireTick();

		expect(harness.written).toEqual([]);
	});

	it('does nothing without an active scene', () => {
		// A store with no marker at all: the writer must not read the deck, let
		// alone write to the store.
		const write = vi.fn();
		const read = vi.fn(() => {
			throw new Error('a writer with no active scene must not read the deck');
		});
		const writer = createPositionWriter({
			isActive: () => false,
			isPlaying: () => true,
			read,
			write,
			ticker: () => () => {},
			onHidden: () => () => {}
		});

		expect(() => {
			writer.start();
			writer.flush();
			writer.flushNow();
			writer.stop();
		}).not.toThrow();

		expect(read).not.toHaveBeenCalled();
		expect(write).not.toHaveBeenCalled();
	});

	it('stops the tick and the visibility subscription on stop', () => {
		const harness = makeHarness();
		harness.writer.start();

		// A burst is holding a value back; unmounting must not lose it.
		harness.state.positionSec = 70;
		harness.writer.flush();
		harness.state.positionSec = 75;
		harness.writer.flush();
		expect(harness.written).toEqual([{ positionSec: 70, durationSec: 3600 }]);

		harness.writer.stop();

		// Both teardowns ran (the cancel functions the deps handed back), and the
		// held-back value was written on the way out.
		expect(harness.cancelled).toEqual({ ticker: 1, hidden: 1 });
		expect(harness.written).toEqual([
			{ positionSec: 70, durationSec: 3600 },
			{ positionSec: 75, durationSec: 3600 }
		]);
	});
});
