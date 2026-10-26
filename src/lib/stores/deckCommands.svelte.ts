/**
 * deckCommands.svelte.ts — the command seam the Pairs tab drives both decks
 * through (D1).
 *
 * Each `Mp3PlayerView` owns a `Player` that nothing outside the component can
 * reach (Q1/Q2): the transport is only exposed through `mediaEngine`'s
 * single-owner handler slots, which are gated on `displayedSource` and so cannot
 * address a hidden deck (Q5, D1). This registry is the missing half: on mount a
 * deck registers a small object — `capture()` reads the deck's own current track
 * and position, `apply()` starts a stored ref through the deck's normal playback
 * path, `stop()` silences the deck, `setLoop()` changes the loop of the queue it
 * already loaded — and the panel calls it by deck id.
 *
 * Deliberately no `Player` (and no view state) crosses this boundary: the
 * registry holds closures and the caller learns only a status. Modelled on the
 * both-decks registry in `musicView.svelte.ts:10-30`, with two differences:
 *
 *  - **Keyed, not a list.** A deck's slot is its id, so the panel names the deck
 *    it means. The last implementation registered for an id wins, which is what
 *    a remount needs.
 *  - **Reactive, unlike `musicView`'s `Set`.** The panel derives state (Save is
 *    disabled while deck A has nothing to capture, D6), so registration has to
 *    be observable. The slots are `$state.raw` rather than `$state`: a deep
 *    proxy would wrap the registered object, and `getDeckCommands('A')` would
 *    stop being identical to the implementation the deck registered — which both
 *    the "last registration wins" rule and the stale-cleanup guard compare by
 *    identity.
 *
 *  - **Registration writes without reading.** One `$state.raw` per deck, not one
 *    record holding both, because the view registers from an `$effect`: with a
 *    record, `registerDeckCommands` had to read the record to spread it, and
 *    Svelte re-runs an effect that writes state it read — at boot that was an
 *    endless loop (`effect_update_depth_exceeded`, after which the whole app
 *    stopped reacting). `untrack` around that read is not enough: Svelte tracks
 *    writes too and still re-runs the writing effect, so the read has to be
 *    absent altogether. Per-deck slots make the write path read-free; the only
 *    read is `getDeckCommands`, which is what consumers want to depend on.
 */
import { untrack } from 'svelte';
import type { PlayerLoopMode } from '$lib/audio/player.svelte';
import type { StoredAudioFile } from '$lib/models/music';
import type { PairingTrackRef } from '$lib/pairs/types';

/** The two music decks. Same ids the view receives as its `deck` prop. */
export type DeckId = 'A' | 'B';

/** What a deck is playing right now: the file, where it is, and how long it is.
 *  `durationSec` is the element's duration, so it is `0` until metadata lands. */
export interface DeckCapture {
	source: StoredAudioFile;
	positionSec: number;
	durationSec: number;
}

/** Per-start options. Absent means the deck's normal behaviour: the global loop
 *  settings and the queue's own start position. */
export interface DeckApplyOptions {
	loop?: PlayerLoopMode;
}

/** `started` covers "playback began"; `missing` also covers "the file resolved
 *  but would not play", because the panel's response to both is the same toast
 *  (D5) and a deck cannot tell the human which of the two it was. */
export type DeckApplyStatus = 'started' | 'missing';

/** One deck's commands, implemented by the mounted view. */
export interface DeckCommands {
	/** The deck's current track and position, or `null` when it has none. */
	capture(): DeckCapture | null;
	/** Resolve a stored ref against this deck's library and start it at
	 *  `positionSec`, through the same path a user tap takes. */
	apply(ref: PairingTrackRef, positionSec: number, options?: DeckApplyOptions): Promise<DeckApplyStatus>;
	/** Stop this deck through its own stop path: the element is released and
	 *  `isPlaying` goes false, while the queue stays loaded. Callers gate on the
	 *  deck being audible first, because stopping a paused deck would throw away
	 *  its paused position (`startPairing`'s "no background track" rule). */
	stop(): void;
	/** Change the loop of the queue already loaded. `null` restores the global
	 *  behaviour (repeat setting and live selection loop). */
	setLoop(mode: PlayerLoopMode | null): void;
}

/** Raw so the registered object keeps its identity; reassigned whole so a
 *  reader of `getDeckCommands` re-runs when a deck mounts or unmounts. One per
 *  deck so a registration touches only its own slot. */
let slotA = $state.raw<DeckCommands | null>(null);
let slotB = $state.raw<DeckCommands | null>(null);

/** The write half of a slot, kept separate from the read half so registration
 *  never reads the state it writes (see the header). */
function writeSlot(deck: DeckId, impl: DeckCommands | null): void {
	if (deck === 'A') slotA = impl;
	else slotB = impl;
}

/** The read half. Reactive: reading it inside a `$derived`/`$effect` subscribes
 *  the reader to that deck mounting or unmounting. */
function readSlot(deck: DeckId): DeckCommands | null {
	return deck === 'A' ? slotA : slotB;
}

/**
 * Claim a deck's slot. Returns the unregister function to hand to an `$effect`
 * cleanup. A later registration for the same id replaces this one, and the
 * older cleanup then clears nothing — otherwise a remount's cleanup (or a
 * cleanup that fires after the next mount, which is how Svelte orders an
 * unmount/remount of the same component) would leave the deck looking dead.
 *
 * Reads nothing on the way in, so it is safe to call from the registration
 * `$effect` itself; that is what keeps the effect from re-running on its own
 * write.
 */
export function registerDeckCommands(deck: DeckId, impl: DeckCommands): () => void {
	writeSlot(deck, impl);
	return () => {
		// The cleanup can run from inside the effect that owns it, so the "is this
		// still my slot?" check is untracked: a tracked read here would make that
		// effect depend on the slot it is about to clear.
		if (untrack(() => readSlot(deck)) !== impl) return;
		writeSlot(deck, null);
	};
}

/** The commands for one deck, or `null` while that deck is not mounted. Read
 *  inside a `$derived`/`$effect` to react to a deck mounting or unmounting. */
export function getDeckCommands(deck: DeckId): DeckCommands | null {
	return readSlot(deck);
}
