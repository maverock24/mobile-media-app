# A/B pairings — Outline (vertical slices)

- **Slug**: ab-pairings
- **Stage**: Structure
- **Inputs**: `tree.md` (D1–D10), `research.md`, `ticket.md`
- **Critical**: no
- **Scope check**: web layer only. No `android/` file, no Java, no Capacitor plugin. The
  feature is a player-module option, a plain `.ts` store, a registry and one new panel.
  The APK appears only as a manual check (S5, S7, S8).

## Order and why

Risk first, prefactors before the slices that cannot be tested without them:

| # | Slice | Decisions | Risk |
|---|---|---|---|
| S1 | Per-queue loop mode | D2 | **highest** |
| S2 | Start a track at a position | – (prefactor) | medium |
| S3 | Deck command registry + ref resolver | D1 | medium, **largest** |
| S4 | Pairings store | D4, D10 | low |
| S5 | Pairs sub-tab | D7 | medium (transport hole) |
| S6 | Row content and delete | D9 | low |
| S7 | Start a scene | D5, D8 | high (exclusivity) |
| S8 | Position write path | D3 | medium (write cost) |
| S9 | Save semantics | D6 | low |

Every slice leaves the app working: S1–S4 and S9 add code that nothing calls yet (or
changes a call it already made), S5–S8 add UI plus its own wiring.

New files created across the effort (none exist today):

```
src/lib/models/pairing.ts               types + pure helpers (plain .ts, no runes)
src/lib/pairings/resolvePairingTrack.ts ref -> StoredAudioFile | null (plain .ts)
src/lib/pairings/startPairing.ts        A-then-B sequencing (plain .ts)
src/lib/pairings/positionWriter.ts      throttled position flush (plain .ts)
src/lib/stores/pairings.svelte.ts       persisted('ab-pairings', ...)
src/lib/stores/deckCommands.svelte.ts   per-deck command registry
src/lib/components/views/PairsView.svelte
tests/unit/pairings/{pairingStore,resolvePairingTrack,startPairing,positionWriter,mergePairing}.test.ts
tests/unit/stores/deckCommands.test.ts
tests/e2e/pairs.test.ts
```

---

## S1 — Per-queue loop mode (D2)

**Riskiest slice.** It rewrites the single advance path both decks and YouTube share, and
three existing test blocks pin the behaviour it changes.

- **Files**: `src/lib/audio/player.svelte.ts`, `tests/unit/models/player.test.ts`.
- **What changes**
  - `PlayerQueueOptions` (and therefore `PlayerLoadOptions`) gains
    `loop?: 'off' | 'one' | 'all'` (`player.svelte.ts:65-77`).
  - `loadQueue` (`:292`) stores the mode alongside the existing `selectionLoop` snapshot
    (`:156`, written at `:303`).
  - `nextIndex` (`:347-357`) stops reading `settings.isRepeat` and `isSelectionLoopActive()`
    directly. It resolves them from the queue mode first: absent means today's
    `{ isRepeat: settings.isRepeat, selectionLoop: isSelectionLoopActive() }`; `'one'` means
    repeat-one; `'all'` means `selectionLoop: true`; `'off'` means neither. `getNextTrackIndex`
    keeps its signature, so `src/lib/models/music.ts` and its pinned test are untouched.
  - The `ended` listener (`:480-490`) repeats the same track when the queue mode is `'one'`,
    and skips the repeat path when the mode is `'off'`.
- **Automated check**:
  `pnpm exec vitest run tests/unit/models/player.test.ts`
  New case: a queue loaded with `{ loop: 'one' }` on a two-track queue and
  `settings.isRepeat === false` keeps `isPlaying === true` and `currentIndex === 0` after
  `ended`; a queue with `{ loop: 'off' }` stops even when `isRepeat` is true. The nine
  existing blocks (repeat-one, advance, stop/resume) must stay green in the same command.
- **Manual check**: none needed; no UI sets a mode yet.
- **Watch**: the MiniPlayer loop toggle writes the global `musicSelectionLoopActive`
  (`MiniPlayer.svelte:240-243`), so while a queue declares a mode that toggle looks dead for
  that deck. Accepted by D2, but the slice must not make the toggle throw or desync
  `musicHasSelectedTracks`.

## S2 — Start a track at a position (prefactor, no decision)

D1's `apply(track, positionSec, options)` needs a way to begin playback at second N, and the
module has none (Q38: `PlayerQueueOptions` carries only `preserveOrder`/`selectionLoop`).

- **Files**: `src/lib/audio/player.svelte.ts`, `tests/unit/models/player.test.ts`.
- **What changes**: `PlayerQueueOptions` gains `startAtSec?: number`. `startCurrent`
  (`:331-344`) and `loadAndPlayAt` (`:372-394`) apply it when the element's metadata arrives:
  set `el().currentTime` from an existing one-shot `loadedmetadata` listener
  (`player.svelte.ts:470`, the same seam `podcastPlayer.ts:179` uses), falling back to a
  direct assignment when the element already reports `readyState >= 1`. `state.currentTime`
  follows.
- **Automated check**:
  `pnpm exec vitest run tests/unit/models/player.test.ts -t "start at a position"`
  The case plays `{ startAtSec: 42 }`, emits `loadedmetadata` on `FakeAudio`
  (`tests/unit/models/player.test.ts:6-36` has `emit`), and asserts `audio.currentTime === 42`.
- **Manual check**: none.
- **Watch**: `seek()`'s 100 ms `seeking` guard (`:653-658`) suppresses `timeupdate` mirrors;
  the start path must not route through it or the first position report is lost.

## S3 — Deck command registry and the ref resolver (D1)

**Largest slice.** Four files, one of them a 2 400-line component.

- **Files**
  - `src/lib/stores/deckCommands.svelte.ts` (new)
  - `src/lib/models/pairing.ts` (new: `PairingTrackRef`, `Pairing` types only in this slice)
  - `src/lib/pairings/resolvePairingTrack.ts` (new)
  - `src/lib/components/views/Mp3PlayerView.svelte`
  - `tests/unit/stores/deckCommands.test.ts`, `tests/unit/pairings/resolvePairingTrack.test.ts`
- **What changes**
  - Registry: `registerDeckCommands(deck, impl): () => void`, `getDeckCommands(deck)`, shaped
    like `musicView.svelte.ts:10-30` (a module-level store keyed by deck, returning an
    unregister for `$effect` cleanup).
  - The registered object, per D1: `capture(): { source: StoredAudioFile; positionSec: number } | null`,
    `apply(ref: PairingTrackRef, positionSec: number, options: { loop?: 'off'|'one'|'all' }):
    Promise<'started' | 'aMissing'>`, `setLoop(mode)`. `apply` takes a **ref**, not a
    `StoredAudioFile`: only the deck holds `allFiles`/`player.state.tracks`, and S7's tab has
    no library (see *Unimplementable as written*, item 3).
  - `Mp3PlayerView` registers on mount next to the existing
    `registerAudioSource`/`registerMusicPlayerView` effects (`:559-576`), keyed by `deck`, and
    unregisters on teardown. `capture` reads `player.state.currentIndex/tracks/currentTime`.
    `apply` resolves the ref with `resolvePairingTrack`, then calls the existing
    `startPlayback([file], 0, { preserveOrder: true, loop: options.loop, startAtSec })`
    (`:1082-1105`) so the claim, the deck flag and `syncTrackToMediaEngine` all happen on the
    proven path. `setLoop` writes the queue's mode through a `player.load`-free path (the
    module keeps the loaded mode; a `setLoop` on the module is enough).
  - `resolvePairingTrack(ref, candidates)` mirrors `resolveFavoriteTrackFile`
    (`favoriteTracks.ts:165-194`): index by `getStoredFileKey`, then reconstruct per source
    (native needs `path`, drive needs `fileId`, web needs the live `File` from the loaded
    library), else `null`.
- **Depends on**: S1 (loop mode), S2 (start position).
- **Automated check**:
  `pnpm exec vitest run tests/unit/stores/deckCommands.test.ts`
  Two fake decks register, `capture` returns each one's own state, `apply` addresses only the
  named deck, and unregistering one leaves the other. The resolver test rides in the same
  effort: `pnpm exec vitest run tests/unit/pairings/resolvePairingTrack.test.ts`.
- **Manual check**: the deck-side wiring (`capture` returning the real track, `apply`
  starting the real file) has no automated check until S7, because nothing calls the registry
  yet. S7's check is the first one that exercises the real deck.
- **Watch**: `startPlayback` sets `deckFlag = true` then claims (`:1099-1103`). Reusing it is
  what keeps D8 a no-op rule, so `apply` must not open a second start path.

## S4 — Pairings store (D4, D10)

D10 is owned here: this slice decides that the store and the resolution logic are plain `.ts`
in `$lib`, unit tested directly. D10's two other parts are honoured by S3 (registry with two
fake decks) and S6 (the single Playwright test).

- **Files**: `src/lib/stores/pairings.svelte.ts` (new), `src/lib/models/pairing.ts`,
  `tests/unit/pairings/pairingStore.test.ts` (new).
- **What changes**
  - `pairings = persisted('ab-pairings', { pairs: [], nextId: 0, activePairId: null })`.
  - `Pairing = { id, name, savedAt, a: PairingTrackRef, b: PairingTrackRef | null, bVolume,
    bSpeed, positionSec }`; `PairingTrackRef` mirrors the serialisable `FavoriteTrack` union
    minus `title`/`artist` (`models/music.ts:36-51`), i.e. no `File` for web, so it round-trips
    through localStorage.
  - `trim` keeps the newest 50, via a pure helper in `models/pairing.ts` so the bound is
    testable outside the store.
  - Store functions: `addPairing`, `deletePairing(id)`, `setActivePair(id | null)`,
    `setActivePositionSec(sec)` (the last one is the write target S8 needs). Every write
    reassigns the top-level key: `persisted()` tracks one read per top-level key
    (`persisted.svelte.ts:81-88`), so an in-place `push`/`splice` would never flush (Q20).
- **Automated check**: `pnpm exec vitest run tests/unit/pairings/pairingStore.test.ts`
  Add writes the key, delete removes one row and leaves the rest, `activePairId` survives a
  reparse, 51 rows store 50 newest, and the `name` is derived from both titles plus the date.
  This is also the pin for the storage key string `ab-pairings`, which nothing else asserts.
- **Manual check**: none.
- **Watch**: write cost. `persisted()` rewrites the whole key per flush
  (`persisted.svelte.ts:47-48`) with no real debounce (`:10-11`), so 50 pairs is roughly 15 kB
  per flush and S8 must throttle before it starts calling `setActivePositionSec`.

## S5 — Pairs sub-tab (D7)

- **Files**: `src/routes/+page.svelte`, `src/lib/stores/mediaEngine.svelte.ts`,
  `src/lib/components/views/PairsView.svelte` (new, empty state only),
  `tests/unit/stores/mediaEngine.test.ts`.
- **What changes**
  - `mediaEngine.activeMusicDeck` widens to `'A' | 'B' | 'pairs'` (`mediaEngine.svelte.ts:124`).
    That is the state the derived `musicSubTab` reads (`+page.svelte:52-55`); nothing else can
    hold a third tab, see *Unimplementable as written*, item 1.
  - `MusicSubTab` gains `'pairs'`; `selectMusicSubTab` handles it in the deck branch
    (`+page.svelte:57-66`), i.e. it writes `activeMusicDeck = 'pairs'` and calls
    `closeYoutubePanel()`, so the `youtubePanel.open` precedence cannot silently keep the
    panel open.
  - Tab button `Pairs` between B and YouTube (between `:216-221` and `:222-229`),
    text-only accessible name, unique against both tablists (`:208`, `:278`).
  - `ActiveView` gains `'music:pairs'` (`mediaEngine.svelte.ts:62-69`); the template literal
    at `+page.svelte:71` forces this, so D7's "only if the type forces it" reduces to "it
    does".
  - `<PairsView />` mounted in a fourth `class:hidden` panel (`:236`), never unmounted, same
    as the decks.
- **Automated check**:
  `pnpm exec vitest run tests/unit/stores/mediaEngine.test.ts -t "music:pairs"`
  New case: `activeView = 'music:pairs'` with nothing playing yields `displayedSource === null`,
  and with deck B playing it yields `'B'`. This pins the widened union and the fallback
  branch that the new view relies on.
- **Manual check**: web build, Music tab, `Pairs` sits between `B` and YouTube, tapping it
  shows the empty panel, tapping `A` returns to deck A.
- **Watch**: this is the transport hole from Q27. On the Pairs tab with both decks paused,
  `displayedSource` is `null`, so no deck re-claims the engine slots
  (`Mp3PlayerView.svelte:616`, `:668`) and the MiniPlayer drives the last claimer. Not a new
  regression (it is the same on Weather), but it becomes reachable while user-visible decks
  are one tap away. Accept and record; do not add a claim rule here.

## S6 — Row content and delete (D9)

- **Files**: `src/lib/components/views/PairsView.svelte`, `tests/e2e/pairs.test.ts` (new).
- **What changes**: rows newest first, auto name, A's stored position as `mm:ss`, B's volume
  as a percentage, a delete button using the two-tap confirmation pattern already in the
  browse view. Delete calls `deletePairing`. This is D10's single Playwright test.
- **Depends on**: S4 (store), S5 (tab).
- **Automated check**:
  `pnpm exec playwright test tests/e2e/pairs.test.ts -g "renders a saved pairing"`
  Seeds `ab-pairings` with one pair through `page.addInitScript` (`music-player.test.ts:233-235`
  is the pattern), opens Music, clicks `getByRole('tab', { name: 'Pairs', exact: true })`,
  asserts the row's auto name and `mm:ss`, and that the delete affordance exists.
- **Manual check**: none.
- **Watch**: D9 asks for A's duration "when known", and no field in D4's pair stores one.
  Render the stored position only (`mm:ss`); take the duration from the live queue when that
  track happens to be loaded. See *Unimplementable as written*, item 2.

## S7 — Start a scene (D5, D8)

**Second riskiest.** One tap must start two decks without breaking the exclusivity invariants
that E2E pins (`music-player.test.ts:466-587`: radio stops deck A, never deck B).

- **Files**: `src/lib/pairings/startPairing.ts` (new), `src/lib/components/views/PairsView.svelte`,
  `src/lib/components/views/Mp3PlayerView.svelte` (only if `apply` needs to expose the status),
  `tests/unit/pairings/startPairing.test.ts` (new).
- **What changes**
  - `startPairing({ a, b, positionSec, bVolume, bSpeed }, registry)` sequences in the order
    that keeps today's rules: write `deckBVolume`/`deckBSpeed` from the pair, `apply` A
    (its `startPlayback` claim stops podcast/radio/YouTube and skips `musicB`,
    `mediaEngine.svelte.ts:43-51`, so B is untouched), then `apply` B with `{ loop: 'one' }`.
    A's claim already covers D8; no second rule and no direct `claimAudio` call.
  - Returns a status: `'started' | 'aMissing' | 'bMissing' | 'idle'`, which the panel maps to
    the D5 toasts (A unresolvable: toast and start nothing; B unresolvable: A alone plus a
    "background track is missing" toast). `setActivePair(id)` on success so S8 has a target.
  - The tab stays on Pairs: nothing here touches `activeTab` or `activeMusicDeck`.
- **Depends on**: S1, S2, S3, S4, S5.
- **Automated check**: `pnpm exec vitest run tests/unit/pairings/startPairing.test.ts`
  A fake registry records calls: A-missing resolves nothing and B is never applied; B-missing
  resolves A only and returns `bMissing`; a full pair applies A then B, with B's options
  carrying `loop: 'one'`, and `setActivePair` ran.
- **Manual check**: APK, play a podcast, then tap a scene. The podcast stops, A starts at the
  stored position, B loops the same track past its end, and the row stays on screen.
- **Watch**: order matters if B is currently playing its own queue. Applying B second replaces
  B's queue, which is the point, but A's claim must not have already stopped B, so the deck A
  `apply` must go through `startPlayback` and not through `runSelectionLoop` or any path that
  calls `clear()` on both.

## S8 — Position write path (D3)

- **Files**: `src/lib/pairings/positionWriter.ts` (new),
  `src/lib/components/views/Mp3PlayerView.svelte`, `src/lib/stores/pairings.svelte.ts`
  (uses S4's `setActivePositionSec`), `tests/unit/pairings/positionWriter.test.ts` (new).
- **What changes**: `createPositionWriter({ activePairId, readPositionSec, write, isDeckA })`
  with a 5 s interval and explicit `pause`, `stop`, `seek` and `visibilitychange` triggers.
  Only deck A's writer is active, and only while `pairings.activePairId` names a pair, so
  browsing other rows never rewrites a position. Writes are throttled to one call per 5 s plus
  the four triggers; nothing writes on `timeupdate`.
- **Depends on**: S7 (an active scene exists), S4 (write target).
- **Automated check**: `pnpm exec vitest run tests/unit/pairings/positionWriter.test.ts`
  Fake timers: 12 ticks of `state.currentTime` produce two writes, a pause writes immediately,
  a seek writes, and `visibilitychange` to hidden writes once. Also asserts no write happens
  when `activePairId` is null.
- **Manual check**: APK only, and it is the one manual-only path in the effort. Play a scene
  for 30 s, background the app for 30 s, kill it from recents, reopen, tap the same scene: A
  resumes within a few seconds of where it stopped. The Capacitor `pause` flush rides on
  `persisted()` (`persisted.svelte.ts:99-106`) and cannot be reached from jsdom.
- **Watch**: `persisted()` has no debounce, so a naive per-tick write rewrites the whole
  `ab-pairings` blob four times a second. The 5 s throttle is a correctness requirement, not a
  nicety.

## S9 — Save semantics (D6)

- **Files**: `src/lib/components/views/PairsView.svelte`, `src/lib/models/pairing.ts`
  (the merge helper), `tests/unit/pairings/mergePairing.test.ts` (new).
- **What changes**: a Save button in the panel, disabled while deck A's `capture()` returns
  `null`. The merge is pure: same A key and same B key (or same A and no B) updates
  `positionSec`, `savedAt`, `bVolume` and `bSpeed` and moves the row to index 0; any other
  combination appends. `positionSec` and the two B settings come from `capture()` and
  `musicSettings`, not from a stale row. After a successful save, `setActivePair` makes the
  saved row the active one so S8 keeps writing to it.
- **Depends on**: S4 (store), S6 (the panel with rows), S3 (`capture`).
- **Automated check**: `pnpm exec vitest run tests/unit/pairings/mergePairing.test.ts`
  Same A plus same B twice yields one pair with the newer `savedAt` and `positionSec` at index
  0; same A plus different B yields two pairs; same A plus no B twice yields one.
- **Manual check**: web build, load a folder on A and one on B, save, switch to A, play a bit,
  save again: one row, at the top, with the newer position.
- **Watch**: S4's `trim` runs at serialisation, so the in-memory array can exceed 50 until the
  next flush. The merge helper should apply the same bound in memory so the panel and the
  stored blob agree.

---

## Coverage

| Decision | Slice | Check |
|---|---|---|
| D1 registry | S3 | `deckCommands.test.ts` |
| D2 per-queue loop | S1 | `player.test.ts` |
| D3 position writes | S8 | `positionWriter.test.ts` + APK manual |
| D4 store | S4 | `pairingStore.test.ts` |
| D5 missing file | S7 | `startPairing.test.ts` |
| D6 save semantics | S9 | `mergePairing.test.ts` |
| D7 tab | S5 | `mediaEngine.test.ts -t music:pairs` |
| D8 exclusivity | S7 | `startPairing.test.ts` + APK manual |
| D9 row content | S6 | `tests/e2e/pairs.test.ts` |
| D10 test seam | S4 | the store test above; registry part in S3, Playwright part in S6 |

No decision appears twice, and no slice reads an artifact a later slice creates. The only
manual-only path is S8's background flush on the APK, because the Capacitor `pause` event and
the WebView's `visibilitychange` do not exist under jsdom or headless Chromium.

## Unimplementable or wrong as written

1. **D7 has no place to keep the third tab and understates the type work.** `musicSubTab` is
   derived (`+page.svelte:52-55`) from `youtubePanel.open` and `mediaEngine.activeMusicDeck`,
   which is `'A' | 'B'`. A `'pairs'` tab therefore needs `activeMusicDeck` widened, which D7
   does not mention, and `ActiveView` widened is not conditional: the template literal at
   `+page.svelte:71` types against it, so `'music:pairs'` is mandatory, not "only if the type
   forces it". Widening `activeMusicDeck` also touches `MiniPlayer.svelte:461`
   (`activeMusicDeck === 'B'`, the deck B volume row) and two unit-test writers
   (`tests/unit/stores/mediaEngine.test.ts:150`, `:179`).
2. **D9's "duration when known" has no home.** A `Pairing` (D4) stores a track ref, a
   position, B's volume and speed. Nothing stores a duration, and `PairingTrackRef` carries no
   duration field. S6 renders the position only and falls back to the live queue for the
   duration; either add `aDurationSec` to the pair or delete "duration" from the row spec.
3. **D10's `goToTab` cannot open the Pairs tab.** `goToTab` (`tests/e2e/helpers.ts:26-38`)
   clicks the bottom nav and its label union is `'Music' | 'Podcasts' | 'Radio' | 'Essays' |
   'Weather' | 'Settings'`. The sub-tabs are separate `role="tab"` buttons clicked by name, as
   `tests/e2e/music-player.test.ts:271` does for `B`. S6 does `goToTab(page, 'Music')` then
   clicks the `Pairs` tab.
4. **D1's `apply(track, ...)` needs two corrections to be implementable.** The argument must be
   a `PairingTrackRef`, not a `StoredAudioFile`: only the deck holds the library to resolve
   against, and the tab has none. And it must return a status rather than `void`/`boolean`,
   because D5 needs to distinguish "A started, B missing" from "nothing started", which a
   boolean cannot express.
5. **D2's precedence against the selection loop is undefined in one corner.** A queue with
   `loop: 'one'` while `musicSelectionLoopActive` is true: D2 says the queue's explicit mode
   wins, which is what S1 implements, but the MiniPlayer's loop toggle then has no visible
   effect for that deck. Also `syncLoopTracksToSelection` runs per deck on advance
   (`Mp3PlayerView.svelte:1372-1393`) and can clear the shared flag when one deck's selection
   empties, so deck B looping its single track can still switch deck A's loop off. Pre-existing
   cross-deck coupling; S1 must not make it worse, and it is worth one line in the ADR.
