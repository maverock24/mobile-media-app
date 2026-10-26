# A/B pairings: save the audiobook-plus-music scene

- **Slug**: ab-pairings
- **Requested by**: the human, in their words: "i usually play an audiobook and mix in some background music for enhancing the atmosphere. so i would like to have an additional tab right of the B tab in the music view where i can click save and it would save the currently selected tracks and i can later also select a pair from here and then continue from the last position where i left."
- **Tier**: full. New persisted store, a new sub-tab, and playback orchestration across two decks.

## What the feature is

Deck A plays an audiobook, deck B loops background music. A new sub-tab between B and YouTube lists saved **pairings**. Saving captures the current scene; tapping a pairing restarts both decks.

## Settled decisions (Design round with the human)

- **P1 A pair holds**: deck A's track and its playback position, deck B's track, and deck B's volume and speed. Not the EQ, not the mute flag, not the sort order.
- **P2 The list is unlimited**, newest first, each entry named automatically from the A title and B title plus the date, and each deletable. No naming dialog on save.
- **P3 A's position tracks live playback**: while a pairing is the one playing, its stored position updates on pause and periodically, so resuming continues where the listener actually stopped, not where the pair was first saved.
- **P4 Tapping a pairing starts both decks immediately**: A from the stored position, B looping at the stored volume and speed. The view stays on the pairings tab.

## Constraints and known code

- The music sub-tabs are A / B / YouTube in `src/routes/+page.svelte:205-232`, with `MusicSubTab` derived at `:53` and `selectMusicSubTab` at `:57`. The new tab is called `pairs` and sits between B and YouTube.
- Deck B already has persisted `deckBVolume` and `deckBSpeed` (`src/lib/stores/settings.svelte.ts:36`, `:52`). Deck A's volume is fixed at 100 (`src/lib/components/views/Mp3PlayerView.svelte:106`), so there is nothing to save for A.
- Every board state is a `persisted()` store (`src/lib/persisted.svelte.ts`). A new store is a new localStorage key, so the payload must stay small and must not resurrect dead references.
- `mp3TrackPositions` (`settings.svelte.ts:143-149`) exists for per-track resume but is wiped on load, so it is currently disabled. Research must say whether it can be reused for A's position or whether the pairing carries its own.
- Both decks are always mounted and each owns a private `createPlayer` instance. How the pairings tab can start playback on both decks is the open design question, not an assumption.
- Audio exclusivity: starting a podcast, radio or YouTube source stops the music decks (`mediaEngine`). A pairing must not break that.
- Critical: no.
