# Design tree: ab-pairings

- **Slug**: ab-pairings
- **Stage**: Design
- **Critical**: no
- **Done**: Questions, Research

## End state

A fourth music sub-tab, between B and YouTube, lists saved A/B scenes newest first. Save captures deck A's track and position, deck B's track, and B's volume and speed. Tapping a scene starts A at its stored position and B looping at the stored volume and speed, without leaving the tab. While a scene is playing, its A position follows playback, so opening it again continues from where the listener actually stopped.

## Out of scope

- Restoring a scene automatically at app start (the tab is the entry point).
- Saving the EQ, mute flag, sort order or deck A's volume (A is fixed at 100).
- Drive delta or any library-indexing work.
- Making `mp3TrackPositions` live again; it is wiped on purpose and stays so.
- Naming dialogs, folders, tags, or sharing scenes between devices.

## Blocked-by map

- D1 (the command seam) blocks D5, D6 and D9.
- D2 (per-deck loop) blocks D5 only.
- D3 (position write path) blocks D6.
- D4 (store shape) blocks everything that persists.
- D7, D8, D10 are independent.

## Decisions

### D1. How the tab commands both decks

- **Status**: settled
- **Blocked by**: none
- **Decision**: a per-deck command registry, modelled on the both-decks registry the view already uses (`src/lib/stores/musicView.svelte.ts:10-30`). Each `Mp3PlayerView` registers, on mount and keyed by `deck`, a small object: `capture()` returning the deck's current track and position, `apply(ref, positionSec, options)` starting playback, and `setLoop(mode)`. The tab calls it directly. Rejected: `mediaEngine`'s `_onPlay/_onPause/...` slots, which are single-owner and gated on `displayedSource` (`mediaEngine.svelte.ts:320-329`, `Mp3PlayerView.svelte:668`), so a hidden deck or a second deck cannot be driven through them.
- **Amendment (Structure stage)**: `apply` takes the persisted `PairingTrackRef`, not a `StoredAudioFile`, because resolution has to happen where the library index lives (the deck), and returns a status (`'started' | 'missing' | 'no-position'`) so the tab can toast without knowing why.

### D2. Looping deck B without changing the global setting

- **Status**: settled
- **Blocked by**: none
- **Decision**: loop becomes a per-queue property. `PlayerQueueOptions` gains `loop?: 'off' | 'one' | 'all'`, stored on the loaded queue and read by the advance logic, defaulting to today's global behaviour when absent. Starting a scene loads B with `loop: 'one'`, so B repeats its single background track whether or not `musicSettings.isRepeat` is on, and deck A's audiobook is unaffected. The global toggle keeps its current meaning for queues that did not ask for a specific mode.

### D3. Where deck A's position is written

- **Status**: settled
- **Blocked by**: none
- **Decision**: the deck that owns the active scene writes it. A new `activePairId` in the pairings store marks which scene is playing; the deck writes `positionSec` for that scene on pause, on stop, on seek, on `visibilitychange` to hidden, and every 5 seconds while playing. Only the active scene is written, so browsing other scenes never rewrites a position. Rejected: reviving `mp3TrackPositions`, which is per track rather than per scene and is deliberately wiped (`settings.svelte.ts:147-149`).

### D4. Store shape and budget

- **Status**: settled
- **Blocked by**: none
- **Decision**: new `persisted('ab-pairings', { pairs: [], nextId: 0, activePairId: null })`. A pair is `{ id, name, savedAt, a: PairingTrackRef, b: PairingTrackRef | null, bVolume, bSpeed, positionSec, durationSec }`. `PairingTrackRef` mirrors the existing favourite union (`src/lib/models/music.ts:36-44`) so reconstruction without the library index already has a proven shape, but carries no title/artist. The store's `trim` keeps the newest 50 pairs. Payload is small: no episode bodies, no blobs.
- **Amendment (Structure stage)**: `durationSec` sits beside `positionSec` on the pair (D9's row shows both, and a duration cannot be recovered after the file moves), not on the track ref.

### D5. What a scene does when a file is gone

- **Status**: settled by the human
- **Blocked by**: D1, D2
- **Decision**: resolved at tap time, not at save time. If A's file cannot be resolved, the tap toasts and starts nothing. If B's cannot, A starts alone and the toast says the background track is missing. The row stays until the human deletes it, because a wrong guess about a moved file is worse than a visible dead row.

### D6. Save semantics

- **Status**: settled
- **Blocked by**: D1, D3, D4
- **Decision**: Save is disabled while deck A has no track. A save with the same A track and the same B track (or the same A track and no B) updates that pair's `positionSec`, `savedAt`, volume and speed, and moves it to the top, instead of appending a duplicate. Saving the same audiobook with different music is a different pair, which is the point of the feature.

### D7. The tab

- **Status**: settled
- **Blocked by**: none
- **Decision**: `MusicSubTab` gains `'pairs'`; tab order is A, B, pairs, YouTube, and the label is `Pairs`. The panel mounts a new `PairsView.svelte` in `+page.svelte`. `mediaEngine.activeView` is widened only if the type forces it, and then with `music:pairs`.
- **Amendment (Structure stage)**: the widening is not optional. `activeMusicDeck` is `'A' | 'B'` and the sub-tab is derived from it, so a third tab needs either a third value there or its own piece of state, and `ActiveView` gains `music:pairs` regardless. The slice takes the second option: the pairs tab is selected state in `+page.svelte`, and `activeMusicDeck` keeps meaning "which deck the music controls act on".

### D8. Exclusivity

- **Status**: settled
- **Blocked by**: D1
- **Decision**: a scene start routes through the deck's own playback path, so each deck claims audio exactly as it does today. `claimAudio` already skips `musicB` pairs (`mediaEngine.svelte.ts:43-51`), so A claiming never stops B. Starting a scene also does the same mutual pause of a podcast, radio or YouTube source that starting a track does today, by reusing the existing claim, not by adding a second rule.

### D9. Row content

- **Status**: settled
- **Blocked by**: D4
- **Decision**: each row shows the auto name (A title plus B title plus date), A's stored position as `mm:ss` and duration when known, B's volume as a percentage, and a delete button. Delete asks for the existing two-tap confirmation pattern used by file ops, not a browser `confirm`.

### D10. Test seam

- **Status**: settled
- **Blocked by**: none
- **Decision**: the store and the resolution logic are plain `.ts` in `$lib/`, unit tested directly. The registry is unit tested with two fake decks. The panel gets one Playwright test that seeds `ab-pairings` through `addInitScript`, opens the music view and clicks the `Pairs` sub-tab by role, and asserts the row renders and the delete affordance exists, because nothing else in the suite would notice the tab being unreachable.
- **Amendment (Structure stage)**: `goToTab` from `tests/e2e/helpers.ts` clicks the bottom navigation, not the music sub-tabs, so the test clicks `getByRole('tab', { name: 'Pairs' })` after reaching the Music tab.
