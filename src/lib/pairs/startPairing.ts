/**
 * startPairing.ts — one tap on a saved scene starts both decks (D5, D8).
 *
 * Deck A plays the audiobook from the position the row shows; deck B, when the
 * pair has one, loops its single background track from the start at the stored
 * volume and speed. Everything goes through `DeckCommands` (D1), so both decks
 * start through their own normal playback path and each claims audio exactly as
 * it does for a user tap: A's claim stops podcast, radio and YouTube, and
 * `claimAudio` already skips every `musicB` pair, so B keeps playing (D8). No
 * second exclusivity rule, no direct `claimAudio` call, no `clear()` on both
 * decks.
 *
 * The three failure shapes are D5's, all decided at tap time:
 *
 *  - **A unresolved.** Toast, start nothing. A missing audiobook is the whole
 *    scene missing, so B is not started either.
 *  - **B unresolved.** A keeps playing alone and the toast says the background
 *    track is missing.
 *  - **No B track.** Deck B is left alone unless it is audible, in which case it
 *    is stopped through its own commands; a paused deck keeps its queue.
 *
 * The row is never removed or rewritten here: a dead row is the human's to fix
 * or delete (D5). Nothing in this module touches the selected tab either, which
 * is what keeps the view on the Pairs tab after a tap.
 *
 * Dependencies are injected (D10): the module is plain `.ts`, so the whole
 * sequence, the order of the calls and the toasts are unit tested against fake
 * deck commands, and `pairingDeps()` is the only place that reaches the stores.
 */
import { getDeckCommands, type DeckCommands } from '$lib/stores/deckCommands.svelte';
import { mediaEngine } from '$lib/stores/mediaEngine.svelte';
import { musicSettings } from '$lib/stores/settings.svelte';
import { addToast, type AddToastOptions } from '$lib/stores/toastStore.svelte';
import { setActivePair } from './pairings';
import type { AbPairing } from './types';

/** What a tap did. The caller only needs this for tests and, if it ever wants
 *  to differentiate, for logging: the toasts are raised in here. */
export type StartPairingResult = 'started' | 'aMissing' | 'bMissing' | 'idle';

/** Everything a tap needs from the outside world. */
export interface StartPairingDeps {
	/** Deck A's commands, or `null` while that deck is not mounted. */
	deckA: DeckCommands | null;
	/** Deck B's commands, or `null` while that deck is not mounted. */
	deckB: DeckCommands | null;
	/** Whether deck B is making sound right now. Read, not inferred from the
	 *  queue: a paused deck has a queue too, and it must not be disturbed. */
	isDeckBPlaying: () => boolean;
	setDeckBVolume: (volume: number) => void;
	setDeckBSpeed: (speed: number) => void;
	setActivePair: (id: number | null) => void;
	toast: (options: AddToastOptions) => void;
}

/** The real dependencies, read fresh on every tap so a remounted deck's slot is
 *  the one used. Kept out of `startPairing`'s body so a test that passes its own
 *  `deps` never touches the registry or the stores. */
export function pairingDeps(): StartPairingDeps {
	return {
		deckA: getDeckCommands('A'),
		deckB: getDeckCommands('B'),
		isDeckBPlaying: () => mediaEngine.musicPlayingB,
		setDeckBVolume: (volume) => {
			musicSettings.deckBVolume = volume;
		},
		setDeckBSpeed: (speed) => {
			musicSettings.deckBSpeed = speed;
		},
		setActivePair,
		toast: addToast,
	};
}

/**
 * Start the scene `pair`. Resolves with what happened; the toasts are raised
 * here so every caller agrees on the wording (D5).
 */
export async function startPairing(
	pair: AbPairing,
	deps: StartPairingDeps = pairingDeps()
): Promise<StartPairingResult> {
	// A deck that has not registered cannot start the scene at all, and the
	// human needs to know the tap did nothing rather than think it worked.
	if (!deps.deckA) {
		deps.toast({ message: 'Deck A is not ready yet.', type: 'error' });
		return 'idle';
	}

	// A first, at the position the row shows. `startAtSec` rides on the deck's
	// own start options (S2), so the audiobook resumes instead of restarting.
	const a = await deps.deckA.apply(pair.a, pair.positionSec);
	if (a === 'missing') {
		deps.toast({ message: 'That audiobook is missing, so nothing started.', type: 'error' });
		return 'aMissing';
	}

	// Volume and speed go in after A has started but before B loads a src, so
	// deck B's element is already at the stored level and rate on its first
	// frame instead of at the previous track's.
	if (pair.b) {
		deps.setDeckBVolume(pair.bVolume);
		deps.setDeckBSpeed(pair.bSpeed);
	}

	// An audiobook-only scene: B is untouched unless it is audible, and then it
	// is stopped through its own commands rather than left playing under a
	// scene that has no music.
	if (!pair.b) {
		if (deps.isDeckBPlaying()) deps.deckB?.stop();
		deps.setActivePair(pair.id);
		return 'started';
	}

	// A pair with a B track but no mounted deck B still starts A: the audiobook
	// is the scene, and B's absence is a not-ready deck, not a missing file.
	if (!deps.deckB) {
		deps.setActivePair(pair.id);
		return 'started';
	}

	// B always starts at 0 as a background loop (S1's `loop: 'one'`), so the
	// track repeats itself instead of advancing to the next queued file.
	const b = await deps.deckB.apply(pair.b, 0, { loop: 'one' });
	deps.setActivePair(pair.id);

	if (b === 'missing') {
		deps.toast({
			message: 'The background track is missing. The audiobook started alone.',
			type: 'warning'
		});
		return 'bMissing';
	}

	return 'started';
}
