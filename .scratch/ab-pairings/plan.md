# A/B pairings – Plan

- **Slug**: ab-pairings
- **Stage**: Plan
- **Inputs**: `tree.md` (D1 to D10, four Structure amendments), `outline.md` (S1 to S9 plus five design problems), `research.md` (constraints 1 to 12, Q1 to Q42), `ticket.md`
- **Critical**: no
- **Scope**: web layer only. No file under `android/`, no Java, no Capacitor plugin. The APK
  appears only as a manual check.
- **Phases**: nine, one per outline slice, in the outline's order.

Every phase ends with the gate `pnpm check && pnpm test` in the worktree, and one commit
carrying the `QRSPI: ab-pairings` trailer. The e2e suite runs per phase for S6 and once more
before the final commit.

---

## Prerequisites

1. **Worktree**: `/home/maverock24/github/mobile-media-app-ab-pairings`, created with
   `git worktree add -b qrspi/ab-pairings /home/maverock24/github/mobile-media-app-ab-pairings main`
   from the main checkout (currently `0d76e3a`). The convention on this machine is a sibling
   directory per effort, matching `mobile-media-app-delta`, `-perf`, `-qrspi`.
   The main checkout holds another session's uncommitted work
   (`android/.../ScreenDimPlugin.java`, `src/lib/native/screen-dim.ts`,
   `src/routes/+layout.svelte`). A worktree checkout of a commit never sees it. Do not edit,
   stage or revert those three files from anywhere.
2. **Artifacts**: `.scratch/` is untracked, so the worktree starts without it. Copy
   `.scratch/ACTIVE` and `.scratch/ab-pairings/` from the main checkout into the worktree
   before the first phase, so the QRSPI gate reads the same effort id. `ab-pairings` is
   `Critical: no` and touches no sensitive path, so the gate will not block code writes.
3. **Branch**: `qrspi/ab-pairings`, one branch for the whole effort. Confirm
   `git status --porcelain` is empty in the worktree before each phase, and `.scratch/ACTIVE`
   still names `ab-pairings`.
4. **Per phase**: `pnpm install` once, then `pnpm check && pnpm test`. Phase-specific
   automated checks below run before the gate.
5. **Before the final commit**: `pnpm test:e2e` (Playwright builds and previews on
   `127.0.0.1:4177`; the suite is serial, `workers: 1`).
6. **No new dependency.** Everything below uses Svelte 5 runes, `persisted()`, `createPlayer`
   and the existing `addToast`. No shadcn/bits-ui component is added.

---

## Order

| # | Slice | Decisions | Risk | New files |
|---|---|---|---|---|
| S1 | Per-queue loop mode | D2 | **highest** | none |
| S2 | Start a track at a position | prefactor | medium | none |
| S3 | Deck command registry + ref resolver | D1 | medium, **largest** | 3 |
| S4 | Pairings store | D4, D10 | low | 1 |
| S5 | Pairs sub-tab | D7 | medium (transport hole) | 1 |
| S6 | Row content and delete | D9 | low | 1 test |
| S7 | Start a scene | D5, D8 | high (exclusivity) | 1 |
| S8 | Position write path | D3 | medium (write cost) | 1 |
| S9 | Save semantics | D6 | low | 1 test |

---

## S1 – Per-queue loop mode (D2)

**Files**: `src/lib/audio/player.svelte.ts`, `tests/unit/models/player.test.ts`.

**The change.**

- `PlayerQueueOptions` (`player.svelte.ts:65-71`) gains `loop?: 'off' | 'one' | 'all'`.
  `PlayerLoadOptions` inherits it (`:73-78`).
- Next to `let selectionLoop = false` (`:156`) add `let queueLoop: 'off' | 'one' | 'all' | null = null`.
  `null` means "no explicit mode", which is every queue loaded today.
- `loadQueue` (`:292`) writes `queueLoop = options.loop ?? null` immediately below
  `selectionLoop = options.selectionLoop ?? false` (`:303`).
- New module function `resolvedLoop(): { isRepeat: boolean; selectionLoop: boolean }`:
  - `queueLoop === null` returns `{ isRepeat: settings.isRepeat, selectionLoop: isSelectionLoopActive() }`,
    which is exactly today's behaviour and keeps the live getter from `Mp3PlayerView.svelte:363`
    working.
  - `'one'` returns `{ isRepeat: true, selectionLoop: false }`.
  - `'all'` returns `{ isRepeat: false, selectionLoop: true }`.
  - `'off'` returns `{ isRepeat: false, selectionLoop: false }`.
- `nextIndex` (`:347-357`) stops reading `settings.isRepeat` and `isSelectionLoopActive()`
  directly and spreads `resolvedLoop()` into the `getNextTrackIndex` argument object.
  `getNextTrackIndex` and `src/lib/models/music.ts` are untouched, so
  `tests/unit/models/getNextTrackIndex.test.ts` stays green unmodified.
- The `ended` listener (`:480-490`) replaces `settings.isRepeat && !isSelectionLoopActive()`
  with `const loop = resolvedLoop(); loop.isRepeat && !loop.selectionLoop`. The rewind body and
  the `advanceTrack(true)` else branch are unchanged.
- Nothing else moves: `settings.lastTrackTimestamp = 0` writes, `pause`/`play` listeners,
  `startCurrent`, `haltPlayback` stay as they are. Do not touch `syncLoopTracksToSelection`
  (`Mp3PlayerView.svelte:1372-1393`) or the MiniPlayer loop toggle (`MiniPlayer.svelte:237-246`).

**Automated check**:
`pnpm exec vitest run tests/unit/models/player.test.ts`

**Tests to write**, in a new `describe('player – per-queue loop mode')` block using the
existing `makePlayer` / `FakeAudio.emit` seam (`:6-55`):

1. `loops the same track when the queue declares loop: 'one'`: `settings.isRepeat = false`;
   `await player.play([a, b], 0, { loop: 'one' })`; `audio.emit('ended')`; `await flush()`;
   assert `player.state.currentIndex === 0`, `player.state.isPlaying === true`,
   `audio.playCalls` grew, and `audio.currentTime === 0`.
2. `stops at the end of a queue declared loop: 'off'`: `settings.isRepeat = true`;
   `await player.play([a, b], 1, { loop: 'off' })`; `audio.emit('ended')`; `await flush()`;
   assert `player.state.isPlaying === false` and `player.state.currentTime === 0`, which is the
   `haltPlayback()` branch (`player.svelte.ts:407`).
3. `keeps the pre-queue behaviour when no mode is declared`: `settings.isRepeat = true`;
   `await player.play([a, b], 0)`; `audio.emit('ended')`; assert index still 0 and playing,
   so the legacy read path is pinned against the refactor.
4. `wraps a multi-track queue declared loop: 'all'`: play two tracks at index 1 with
   `{ loop: 'all' }`, emit `ended`, assert `state.currentIndex === 0` and playing.

The 34 existing cases in the file must stay green in the same command.

**Manual check**: `pnpm dev`, web, load a folder of three MP3s on deck A, press play, press
Next once, then switch to deck B, load a folder and press the MiniPlayer loop toggle. Look
for: deck A still advances on Next and stops at the last track, deck B still wraps when the
toggle is on, and the browser console shows no error from `player.svelte.ts`. A repeated or
stuck track here means the `resolvedLoop` mapping is wrong.

---

## S2 – Start a track at a position (prefactor)

**Files**: `src/lib/audio/player.svelte.ts`, `tests/unit/models/player.test.ts`.

**The change.**

- `PlayerQueueOptions` gains `startAtSec?: number` (so `PlayerLoadOptions` inherits it).
- New module variable `let pendingStartSec: number | null = null`.
- `loadQueue` (`:292`) stores the option: `pendingStartSec = options.startAtSec ?? null`,
  beside the `selectionLoop` write. `startCurrent` (`:331-344`) does not receive `options`, so
  the queue is the right place to hold it: it applies to the queue's first start only.
- `startCurrent`, right after `el().src = url` (`:339`), calls the apply helper when
  `el().readyState >= 1`; otherwise the `loadedmetadata` listener does it.
- New `function applyPendingStart(el: HTMLAudioElement)`: returns when `pendingStartSec === null`;
  copies the value into `const sec`, sets `pendingStartSec = null`, returns when
  `!(sec > 0)`; clamps with `Number.isFinite(el.duration) && el.duration > 0 ? Math.min(sec, el.duration - 1) : sec`;
  then `el.currentTime = target` and `state.currentTime = target`.
- Called from the existing `loadedmetadata` listener in `wireAudioEvents` (`:466-474`), after
  the duration mirror, so it runs once the element reports metadata.
- `pendingStartSec` is also nulled at the top of `advanceTrack` (`:392`) and inside `prev()`
  (`:634-650`), so a start position that never found metadata cannot leak onto the next track.
- Must not route through `seek()` (`:653-658`): its 100 ms `seeking` guard suppresses the
  following `timeupdate`, which would lose the first position report S8 depends on.

**Automated check**:
`pnpm exec vitest run tests/unit/models/player.test.ts -t "start at a position"`

**Tests to write**, both names containing `start at a position`:

1. `starts a track at a position when metadata arrives`: `await player.play([a, b], 0, { startAtSec: 42 })`;
   `audio.emit('loadedmetadata')`; assert `audio.currentTime === 42` and
   `player.state.currentTime === 42`. `FakeAudio` (`:6-36`) has no `readyState`, so the
   listener path is the one under test; do not add `readyState` to the fake for this case.
2. `does not carry a start position to the next track`: same play, then `await player.next()`
   without emitting metadata; emit `loadedmetadata` for the new track; assert
   `audio.currentTime === 0`.

**Manual check**: `pnpm dev`, web, load a folder, play track 1, seek to the middle, press Next,
then Prev, then Pause and Play. Look for: each of those starts at 0:00 except the one that
resumes in place, nothing jumps to a stale 40-odd second mark, and no console error. `42` in
Test 1 is the only start position any code path can produce in this phase, so a stray jump
would have to be that value.

---

## S3 – Deck command registry and the ref resolver (D1)

**Largest phase.** Four source files, one of them a 2 400-line component.

**Files**

- `src/lib/stores/deckCommands.svelte.ts` (new)
- `src/lib/models/pairing.ts` (new, types and pure helpers only, no runes)
- `src/lib/pairings/resolvePairingTrack.ts` (new)
- `src/lib/audio/player.svelte.ts` (`Player.setLoop`)
- `src/lib/components/views/Mp3PlayerView.svelte` (registration effect, `capture`, `apply`,
  `setLoop`, plus two new optional fields on `startPlayback`)
- `tests/unit/stores/deckCommands.test.ts`, `tests/unit/pairings/resolvePairingTrack.test.ts`

**The change.**

*Registry.* `deckCommands.svelte.ts`:

```ts
export type DeckId = 'A' | 'B';
export interface DeckCapture { source: StoredAudioFile; positionSec: number; durationSec: number }
export interface DeckCommands {
  capture(): DeckCapture | null;
  apply(ref: PairingTrackRef, positionSec: number, options?: { loop?: 'off' | 'one' | 'all' }):
    Promise<'started' | 'missing'>;
  setLoop(mode: 'off' | 'one' | 'all'): void;
}
const decks = $state<{ A: DeckCommands | null; B: DeckCommands | null }>({ A: null, B: null });
export function registerDeckCommands(deck: DeckId, impl: DeckCommands): () => void
export function getDeckCommands(deck: DeckId): DeckCommands | null
```

The holder is `$state`, not a plain `Map`, because the panel derives Save's disabled state
from `getDeckCommands('A')?.capture()`. A plain map would evaluate once, before the decks'
mount effects run, and never re-run; `musicView.svelte.ts` gets away with a plain `Set`
because nothing derives from it. The unregister clears the slot only when it still holds this
implementation, so a stale cleanup cannot evict a remounted deck.

*Deck wiring.* In `Mp3PlayerView.svelte`, one new `$effect` beside the `registerAudioSource`
effect (`:559-567`) and the `registerMusicPlayerView` effect (`:571-576`):

- returns `registerDeckCommands(deck, { capture, apply, setLoop })` as its cleanup.
- `capture()`: `const i = player.state.currentIndex; const t = player.state.tracks[i];`
  return `null` when `i < 0` or `!t`, else
  `{ source: t.source, positionSec: player.state.currentTime, durationSec: player.state.duration }`.
- `apply(ref, positionSec, options = {})`:
  `const file = resolvePairingTrack(ref, [...allFiles, ...player.state.tracks.map(t => t.source)])`;
  return `'missing'` when `file === null`; otherwise `beginQueue('Pairings')`
  (`:1073-1078`) then
  `const ok = await startPlayback([file], 0, { preserveOrder: true, loop: options.loop, startAtSec: positionSec, suppressAlert: true });`
  and return `ok ? 'started' : 'missing'`. `suppressAlert: true` matters: `startPlayback`
  calls a bare `alert()` on `player.state.error` (`:1092-1095`), and D5 wants a toast from the
  panel, not a blocking dialog.
- `setLoop(mode)`: `player.setLoop(mode)`.
- `startPlayback` (`:1082-1105`) gains `startAtSec?: number` and `loop?: 'off' | 'one' | 'all'`
  in its options type and forwards both into `player.play` (`:1088-1091`). All existing
  call sites pass no such fields, so they are unaffected.

*Module.* `Player.setLoop(mode: 'off' | 'one' | 'all'): void` in the returned object
(`player.svelte.ts:528-666`) sets the `queueLoop` variable S1 introduced. It changes the mode
of the loaded queue without touching the element or the queue contents.

*Resolver.* `resolvePairingTrack(ref: PairingTrackRef, candidates: StoredAudioFile[]): StoredAudioFile | null`
copies the order of `resolveFavoriteTrackFile` (`src/lib/favorites/favoriteTracks.ts:165-194`):
a candidate whose `getStoredFileKey` equals `ref.key` wins; else reconstruct
`{ source: 'native', name, relativePath, path, mimeType, modifiedAt }` when
`ref.source === 'native' && ref.path`; else `{ source: 'drive', ... fileId ... }` when
`ref.source === 'drive' && ref.fileId`; else `null` (a `web` ref with no live `File` cannot be
rebuilt, exactly as for favourites).

*Types.* `src/lib/models/pairing.ts` in this phase holds `PairingTrackRef` (the serialisable
`FavoriteTrack` members minus `title`/`artist`, keeping `key`, `name`, `relativePath` and the
source-specific `path` / `fileId` / `mimeType` / `modifiedAt` / `sizeBytes` / `webViewLink`),
`Pairing`, and `pairTrackRef(file: StoredAudioFile): PairingTrackRef`. Storing `name` is what
lets a native or drive ref be rebuilt without the library; dropping `title`/`artist` is D4.

**Depends on**: S1 (`loop` option), S2 (`startAtSec`).

**Automated check**:
`pnpm exec vitest run tests/unit/stores/deckCommands.test.ts tests/unit/pairings/resolvePairingTrack.test.ts`

**Tests to write.**

`tests/unit/stores/deckCommands.test.ts` (style of `tests/unit/stores/musicView.test.ts`):

1. `returns null for a deck that has not registered`, so the panel's derived has a defined
   first read.
2. `capture returns each deck's own state`: register two fakes, assert each `capture()` call
   hits only its own fake (a `vi.fn` counter per fake).
3. `apply addresses only the named deck`: call `getDeckCommands('B')!.apply(ref, 5)`, assert
   A's `apply` was never called and B's got `(ref, 5, undefined)`.
4. `unregistering one deck leaves the other`: run A's unregister, assert `getDeckCommands('A')`
   is null and B still answers.
5. `a stale unregister does not evict a remounted deck`: register A twice, run the first
   cleanup, assert the second implementation is still there.

`tests/unit/pairings/resolvePairingTrack.test.ts`:

6. `prefers a live library candidate over reconstruction` (candidate key matches, ref carries
   a different `path`, the candidate wins).
7. `rebuilds a native ref without the library` (`path` present, no candidates, object deep
   equals the source fields).
8. `rebuilds a drive ref from fileId` and `returns null for a drive ref without fileId`.
9. `returns null for a web ref when the library is gone`.

**Manual check**: `pnpm dev`, web, load a folder on deck A and a folder on deck B, play each
deck for a few seconds and switch between the A and B sub-tabs. Look for: both decks still
play and pause, the MiniPlayer still pauses whichever deck is on screen, and the console shows
no uncaught error from the new registration effect. The registration runs on mount whether or
not anything calls it, so a broken effect would surface here as a duplicate claim or a silent
deck. `capture`/`apply` themselves get their first real exercise in S7.

---

## S4 – Pairings store (D4, D10)

**Files**: `src/lib/stores/pairings.svelte.ts` (new), `src/lib/models/pairing.ts`,
`tests/unit/pairings/pairingStore.test.ts` (new).

**The change.**

- `export const pairings = persisted('ab-pairings', { pairs: [] as Pairing[], nextId: 0, activePairId: null as number | null }, { trim: (s) => ({ ...s, pairs: s.pairs.slice(0, MAX_PAIRINGS) }) })`
  with `export const MAX_PAIRINGS = 50`. `trim` bounds the stored blob only, matching
  `podcastData`'s use (`settings.svelte.ts:125-141`); the array bound in memory is the merge
  helper's job in S9.
- `Pairing = { id: number; name: string; savedAt: number; a: PairingTrackRef; b: PairingTrackRef | null; bVolume: number; bSpeed: number; positionSec: number; durationSec: number }`.
- Store functions, each reassigning the top-level key it owns, because `persisted()` tracks
  one read per top-level property (`persisted.svelte.ts:81-88`) and an in-place `push`/`splice`
  would never flush:
  - `addPairing(candidate: Omit<Pairing, 'id'> & { id?: number }): Pairing` uses `candidate.id`
    when given, else `pairings.nextId`, then increments `pairings.nextId` and assigns
    `pairings.pairs`. S9 passes the matched pair's id here, which is how a re-save keeps row
    identity.
  - `removePairing(id: number): void` assigns `pairings.pairs.filter(p => p.id !== id)` and sets
    `pairings.activePairId = null` when it pointed at the removed row, so S8 stops writing to a
    row that no longer exists.
  - `setActivePair(id: number | null): void`.
  - `setActivePositionSec(positionSec: number, durationSec: number): void` returns immediately
    when `activePairId === null` or the row is gone, else assigns
    `pairings.pairs.map(p => p.id === activePairId ? { ...p, positionSec, durationSec } : p)`.
- `formatClock(sec: number): string` and the merge helper live in `src/lib/models/pairing.ts`
  (S9 adds the helper, this phase adds `formatClock`).

**Automated check**: `pnpm exec vitest run tests/unit/pairings/pairingStore.test.ts`

**Tests to write.** Seed `localStorage.clear()` in `beforeEach`; the store is module state, so
each case resets `pairings.pairs = []`, `pairings.nextId = 0`, `pairings.activePairId = null`.

1. `writes the key on the first save`: after `addPairing`, `JSON.parse(localStorage.getItem('ab-pairings')!)`
   has one pair. This pins the storage-key string, which nothing else asserts.
2. `removePairing removes one row and leaves the rest`.
3. `removePairing clears activePairId when the active row goes`.
4. `activePairId survives a reload`: set it, wait for the microtask flush
   (`await Promise.resolve()`), re-`JSON.parse` the key.
5. `stores the newest 50 pairs`: push 51 through `addPairing`, read the serialised key, assert
   the array length is 50.
6. `setActivePositionSec writes only the active row` and `is a no-op when no pair is active`.
7. `formatClock renders mm:ss` for 0, 65 and 3725.

**Manual check**: `pnpm dev`, web, open the app on a clean profile with DevTools on
Application, Local Storage. Look for: an `ab-pairings` key holding
`{"pairs":[],"nextId":0,"activePairId":null}` (roughly 45 bytes) and no console warning about
the write. Nothing calls the store yet, so a wrong key or a failing `trim` shows up here as a
missing entry or a `[persisted] failed to write` error.

---

## S5 – Pairs sub-tab (D7)

**Files**: `src/routes/+page.svelte`, `src/lib/stores/mediaEngine.svelte.ts`,
`src/lib/components/views/PairsView.svelte` (new, empty state only),
`tests/unit/stores/mediaEngine.test.ts`.

**The change.** This phase follows D7's Structure amendment, not the outline's widening of
`activeMusicDeck` (see *Deviations*, item 3).

- `ActiveView` (`mediaEngine.svelte.ts:62-69`) gains `'music:pairs'`. The template literal at
  `+page.svelte:71` types against it, so it is mandatory. `activeMusicDeck` stays
  `'A' | 'B'` and keeps meaning "which deck the music controls act on".
- `+page.svelte`: `type MusicSubTab` becomes `'A' | 'B' | 'pairs' | 'youtube'`. Add
  `let musicPairsTab = $state(false)` and derive
  `youtubePanel.open ? 'youtube' : musicPairsTab ? 'pairs' : mediaEngine.activeMusicDeck`
  (`:52-55`).
- `selectMusicSubTab` (`:57-66`): the early return and the `'youtube'` branch stay. The else
  branch becomes: `musicPairsTab = tab === 'pairs'; if (tab !== 'pairs') mediaEngine.activeMusicDeck = tab; closeYoutubePanel();`.
  `closeYoutubePanel()` in every non-YouTube branch is what stops `youtubePanel.open`'s
  precedence from silently keeping the YouTube panel up.
- A fourth `role="tab"` button `Pairs` between the B button (`:216-221`) and the YouTube
  button (`:222-229`), `aria-selected={musicSubTab === 'pairs'}`, text-only name, no icon.
  `Pairs` is unique across both tablists (`+page.svelte:208` and the bottom nav at `:278`).
- A fourth panel after the deck B panel (`:235`) and before `<YoutubePanel />`:
  `<div class="absolute inset-0" class:hidden={musicSubTab !== 'pairs'}><PairsView /></div>`.
  Never unmounted, exactly like the decks.
- `PairsView.svelte` v1 renders an empty state only, no store import yet:
  a wrapper plus `<p>No pairings yet. Save an audiobook on deck A with music on deck B.</p>`.

**Automated check**: `pnpm exec vitest run tests/unit/stores/mediaEngine.test.ts -t "pairs tab"`

**Tests to write**, in a new `describe('displayedSource – pairs tab')` block that extends
`resetDisplay()` (`tests/unit/stores/mediaEngine.test.ts:146-153`):

1. `the pairs tab maps to no deck source while nothing plays`: `activeView = 'music:pairs'`,
   nothing playing, `displayedSource` is `null`.
2. `the pairs tab still shows a deck that plays`: same view, `musicPlayingB = true`,
   `displayedSource === 'B'`. This pins the widened `ActiveView` against the fallback loop at
   `mediaEngine.svelte.ts:241-243`, which today no case feeds an unrecognised view to.

**Manual check**: `pnpm dev`, web, Music tab. Look for: `Pairs` sits between `B` and YouTube,
tapping it shows "No pairings yet.", tapping `A` returns to deck A, tapping `YouTube` opens the
panel, and tapping `Pairs` while the panel is open closes it and shows the Pairs panel. The
last one is the `closeYoutubePanel()` assertion; if the panel stays up, the derivation is
still winning on precedence.

---

## S6 – Row content and delete (D9)

**Files**: `src/lib/components/views/PairsView.svelte`, `tests/e2e/pairs.test.ts` (new).

**The change.**

- Import `pairings`, `removePairing` from `$lib/stores/pairings.svelte` and
  `formatClock` from `$lib/models/pairing`.
- Render `{#each pairings.pairs as pair (pair.id)}` in array order, which is newest first
  because S9 and `addPairing` always place a new row at index 0.
- Row content, all text: `pair.name`; `formatClock(pair.positionSec)` plus
  `' / ' + formatClock(pair.durationSec)` when `durationSec > 0`; `Math.round(pair.bVolume) + '%'`;
  and `pair.b ? pair.b.name : 'no background track'`. D9's "duration when known" now has a
  home, so the row reads both numbers from the pair, never from the live queue.
- The row's main area is a `<button type="button">` (the S7 tap target) and the delete control
  is a **sibling** `<button type="button" aria-label={'Delete ' + pair.name}>` inside the same
  flex row. Nesting a button inside a button is invalid HTML and would make the delete
  unreachable for `getByRole('button', { name: 'Delete …' })`.
- Delete uses the app's two-tap toast pattern, not `confirm()`. Copy the shape of
  `confirmAndDelete` (`src/lib/files/fileOps.ts:140-147`):
  `addToast({ message: 'Delete ' + pair.name + '?', type: 'warning', autoDismissMs: 0, action: { label: 'Delete', handler: () => removePairing(pair.id) } })`.
- Keep the empty state for zero rows.

**Automated check**:
`pnpm exec playwright test tests/e2e/pairs.test.ts -g "renders a saved pairing"`

**Test to write.** One test, name containing `renders a saved pairing`:

- `await page.addInitScript(() => localStorage.setItem('ab-pairings', JSON.stringify({ pairs: [PAIR], nextId: 8, activePairId: null })))`
  with `PAIR` a native-source ref, no `File`, so it is serialisable (the pattern at
  `tests/e2e/music-player.test.ts:233-235`). `PAIR` carries `name: 'Atomic Habits + Rain, 4.6.2026'`,
  `positionSec: 125`, `durationSec: 3600`, `bVolume: 40`, `bSpeed: 0.9`, and
  `b: { key: 'n:music/Rain.mp3', source: 'native', name: 'Rain.mp3', relativePath: 'music/Rain.mp3', path: '/storage/emulated/0/Music/Rain.mp3' }`.
- `await goToTab(page, 'Music')`, then
  `await page.getByRole('tab', { name: 'Pairs', exact: true }).click()`
  (`goToTab` only drives the bottom nav, `tests/e2e/helpers.ts:26-38`).
- Assert: the row name is visible, the row contains `2:05`, the row contains `40%`, and
  `getByRole('button', { name: 'Delete Atomic Habits + Rain, 4.6.2026' })` is visible. Also
  assert `page.locator('audio')` still has count 2 (`music-player.test.ts:194`), because the
  new panel must not mount a third element.

**Manual check**: `pnpm dev`, web, DevTools, Application, Local Storage: paste the same
one-pair payload into `ab-pairings` by hand and reload. Open Music, Pairs. Look for: one row
showing the name, `2:05 / 1:00:00`, `40%` and `Rain.mp3`; clicking the delete icon raises a
toast `Delete Atomic Habits + Rain, 4.6.2026?` with a Delete button; clicking that button
removes the row; a reload does not bring it back.

---

## S7 – Start a scene (D5, D8)

**Second riskiest phase.** One tap must start two decks without breaking the exclusivity
invariants pinned by `tests/e2e/music-player.test.ts:466-587` (radio stops deck A, never deck B).

**Files**: `src/lib/pairings/startPairing.ts` (new), `src/lib/components/views/PairsView.svelte`,
`tests/unit/pairings/startPairing.test.ts` (new).

**The change.**

`startPairing.ts`:

```ts
export type StartPairingResult = 'started' | 'aMissing' | 'bMissing' | 'idle';

export async function startPairing(pair: Pairing, deps: {
  deckA: DeckCommands | null;
  deckB: DeckCommands | null;
  setDeckBVolume: (v: number) => void;
  setDeckBSpeed: (v: number) => void;
  setActivePair: (id: number) => void;
}): Promise<StartPairingResult>
```

Sequence, in this order and no other:

1. `if (!deps.deckA) return 'idle'`.
2. `if (pair.b) { deps.setDeckBVolume(pair.bVolume); deps.setDeckBSpeed(pair.bSpeed); }` before
   any playback, so deck B's controls effect (`player.svelte.ts:520-527`, driven by
   `Mp3PlayerView`'s `controls`) has already pushed volume and rate onto the element when B's
   `apply` loads the src.
3. `const a = await deps.deckA.apply(pair.a, pair.positionSec)`. If `a === 'missing'`,
   `return 'aMissing'` and start nothing: D5's rule for an unresolvable audiobook.
4. `if (!pair.b || !deps.deckB) { deps.setActivePair(pair.id); return 'started'; }`.
5. `const b = await deps.deckB.apply(pair.b, 0, { loop: 'one' })`. B always starts at 0 as a
   background loop.
6. `deps.setActivePair(pair.id); return b === 'missing' ? 'bMissing' : 'started';`

A's `apply` goes through `startPlayback` → `claimAudio('musicA')`, which stops podcast, radio
and YouTube and skips every `musicB` pair (`mediaEngine.svelte.ts:43-51`). That is D8 in full:
no second claim rule, no direct `claimAudio` call here, and no `clear()` on both decks.

In `PairsView.svelte`, the row's main button calls:

```ts
const result = await startPairing(pair, {
  deckA: getDeckCommands('A'), deckB: getDeckCommands('B'),
  setDeckBVolume: (v) => { musicSettings.deckBVolume = v; },
  setDeckBSpeed: (v) => { musicSettings.deckBSpeed = v; },
  setActivePair,
});
if (result === 'aMissing') addToast({ message: 'That audiobook is missing, so nothing started.', type: 'error' });
else if (result === 'bMissing') addToast({ message: 'The background track is missing. The audiobook started alone.', type: 'warning' });
else if (result === 'idle') addToast({ message: 'Deck A is not ready yet.', type: 'error' });
```

Nothing here writes `activeTab`, `activeMusicDeck` or `musicPairsTab`, so the view stays on
Pairs.

**Depends on**: S1, S2, S3, S4, S5.

**Automated check**: `pnpm exec vitest run tests/unit/pairings/startPairing.test.ts`

**Tests to write**, with fake `DeckCommands` that record calls:

1. `starts nothing when deck A cannot resolve the audiobook`: A returns `'missing'`, assert
   result `'aMissing'`, B's `apply` never called, `setActivePair` never called, and both
   setters never called.
2. `starts A alone when deck B cannot resolve the background track`: A `'started'`, B
   `'missing'`, assert result `'bMissing'` and `setActivePair` called once.
3. `applies A before B, with loop: one on B and B volume and speed written first`: assert call
   order `[volume, speed, A.apply, B.apply]`, that B's `apply` received `(ref, 0, { loop: 'one' })`
   and A's received `(ref, positionSec)` with no loop option.
4. `treats a pair with no background track as started`: `b: null`, result `'started'`, B's
   `apply` never called.
5. `returns idle when deck A has not registered`.

**Manual check**: APK (the manual `android-build` workflow produces a debug APK; `pnpm
build:mobile` plus `pnpm cap:sync:android` is the local route). On the device: start a
podcast playing, then open Music, Pairs, and tap a saved scene. Look for: the podcast audio
stops, deck A starts at the position shown in the row (not 0:00), deck B's background track
keeps playing past its own end instead of stopping, the app stays on the Pairs tab, and the
row is still there with its delete button.

---

## S8 – Position write path (D3)

**Files**: `src/lib/pairings/positionWriter.ts` (new), `src/lib/components/views/Mp3PlayerView.svelte`,
`src/lib/stores/pairings.svelte.ts` (calls S4's `setActivePositionSec`),
`tests/unit/pairings/positionWriter.test.ts` (new).

**The change.**

`positionWriter.ts`:

```ts
export interface PositionWriter { start(): void; stop(): void; flush(): void }
export function createPositionWriter(deps: {
  isActive: () => boolean;
  read: () => { positionSec: number; durationSec: number };
  write: (positionSec: number, durationSec: number) => void;
  intervalMs?: number; // default 5000
}): PositionWriter
```

- `start()` sets `setInterval(deps.intervalMs ?? 5000, flush)` and registers one
  `document.addEventListener('visibilitychange', …)` that flushes when
  `document.visibilityState === 'hidden'`. Both are torn down in `stop()`.
- `flush()` returns early when `!deps.isActive()`, reads `deps.read()`, returns early when
  both numbers equal the last written pair, otherwise writes and remembers.
- No `timeupdate` subscription anywhere: `state.currentTime` already changes at most every
  250 ms (`player.svelte.ts:125`, `:462-469`) and each flush rewrites the whole
  `ab-pairings` key (`persisted.svelte.ts:47-48`), so a per-tick writer would rewrite the blob
  four times a second with no debounce to absorb it.

`Mp3PlayerView.svelte`, deck A only:

- A writer instance built in a mount `$effect` whose body is `if (deck !== 'A') return;`, with
  `isActive: () => pairings.activePairId !== null`,
  `read: () => ({ positionSec: player.state.currentTime, durationSec: player.state.duration })`,
  `write: (positionSec, durationSec) => setActivePositionSec(positionSec, durationSec)`.
  `start()` in the effect body, `stop()` in the cleanup.
- `flush()` at three named seams, plus the interval:
  - `pausePlayback()` (`:1326-1334`), immediately after `player.pause()`.
  - `handleSeekSeconds()` (`:1431-1433`), immediately after `player.seek(seconds)`.
  - the `registerAudioSource` stop callback (`:559-567`), **before** `player.stop()`, because
    `stop()` → `haltPlayback()` zeroes `state.currentTime` (`player.svelte.ts:231-238`). This is
    the cross-source steal path (a podcast or radio claim), and it is the write that keeps a
    stolen scene resumable.
- Deliberately no write on `timeupdate`, on `advanceTrack`, or on `setLoop`.

**Depends on**: S7 (there has to be an active scene), S4 (the write target).

**Automated check**: `pnpm exec vitest run tests/unit/pairings/positionWriter.test.ts`

**Tests to write**, `vi.useFakeTimers()` in `beforeEach`:

1. `writes once every five seconds while active`: `start()`, advance `state.currentTime` by one
   each of 12 second-ticks, assert `write` called twice, with `(1, d)` and `(6, d)` style
   values from the fake `read`.
2. `writes immediately on flush`: `flush()` right after start writes once.
3. `flushes once when the document goes hidden`: dispatch `visibilitychange` with
   `document.visibilityState` stubbed to `'hidden'`, assert one write; a second dispatch with
   no change writes nothing more.
4. `writes nothing when no pair is active`: `isActive()` false, advance 30 seconds and
   `flush()`, assert zero writes.
5. `does not repeat an identical position`: two `flush()` calls with the same values write once.

**Manual check**: APK only, and this is the effort's one manual-only path, because the
Capacitor `pause` flush and the WebView `visibilitychange` do not exist under jsdom or headless
Chromium. Play a saved scene for 30 seconds, send the app to the background for 30 seconds,
kill it from the recents list, reopen it, tap the same scene. Look for: deck A resumes within
a few seconds of where it actually stopped, and the row's `mm:ss` is larger than it was before
the restart.

---

## S9 – Save semantics (D6)

**Files**: `src/lib/components/views/PairsView.svelte`, `src/lib/models/pairing.ts`,
`tests/unit/pairings/mergePairing.test.ts` (new).

**The change.**

`models/pairing.ts` gains two pure functions:

- `pairingKeyOf(p: Pairing): string` returns `` `${p.a.key}|${p.b?.key ?? ''}` ``.
- `upsertPairing(pairs: Pairing[], candidate: Pairing, limit = MAX_PAIRINGS): Pairing[]`:
  `const rest = pairs.filter(p => pairingKeyOf(p) !== pairingKeyOf(candidate)); return [candidate, ...rest].slice(0, limit);`
  The in-memory cap makes the panel and the stored blob agree; S4's `trim` only bounds the
  serialised copy.
- `derivePairingName(aTitle: string, bTitle: string | null, savedAt: number): string` returns
  `` `${aTitle}${bTitle ? ' + ' + bTitle : ''}, ${new Date(savedAt).toLocaleDateString()}` ``.

`PairsView.svelte`:

- A `Save` button in the panel header, `disabled={!captureA}` where
  `const captureA = $derived(getDeckCommands('A')?.capture() ?? null)`, which is D6's "disabled
  while deck A has no track". The derived is reactive because `capture()` reads `$state`
  fields on `player.state`.
- `save()`: read `captureA` and `getDeckCommands('B')?.capture() ?? null`; build the candidate
  `{ id: match?.id, name: derivePairingName(titleOf(captureA.source), captureB ? titleOf(captureB.source) : null, savedAt), savedAt: Date.now(), a: pairTrackRef(captureA.source), b: captureB ? pairTrackRef(captureB.source) : null, bVolume: musicSettings.deckBVolume, bSpeed: musicSettings.deckBSpeed, positionSec: Math.floor(captureA.positionSec), durationSec: Math.round(captureA.durationSec) }`
  where `savedAt = Date.now()` and `titleOf` is `parseFilename(file.name).title` from
  `$lib/models/music`. The `match` is found with `pairingKeyOf` over `pairings.pairs`.
- `addPairing` returns the stored pair: `const saved = addPairing(candidate)`, which keeps the
  matched id when there is one and allocates `nextId` otherwise. `addPairing` receives `id`
  undefined for a new pair and its body uses `candidate.id ?? pairings.nextId`, so no sentinel
  value is ever stored.
- `setActivePair(saved.id)` after a successful save, so S8 writes to the row just saved.

**Depends on**: S4 (store), S6 (the panel with rows), S3 (`capture`), S8 (or lands with S8's
store hook; see *Ordering*).

**Automated check**: `pnpm exec vitest run tests/unit/pairings/mergePairing.test.ts`

**Tests to write**:

1. `same audiobook and same background track update one row at the top`: upsert twice with the
   same `a.key` and `b.key` and different `savedAt`/`positionSec`, assert length 1, the newer
   `savedAt` and `positionSec` at index 0, and the id unchanged.
2. `same audiobook with a different background track is a second row`: assert length 2, newest
   first.
3. `same audiobook with no background track twice is one row`: both `b: null`, assert length 1.
4. `an audiobook-only row and the same audiobook with music are different rows` (the `''` half
   of `pairingKeyOf`).
5. `never returns more than 50 rows`.
6. `derivePairingName uses both titles and the date`, and omits the `+` when there is no B.

**Manual check**: `pnpm dev`, web, load a folder on deck A and a different one on deck B, open
Music, Pairs, tap Save. Look for: one row named `A title + B title, <date>`. Then go to A, play
about 20 seconds, return to Pairs, tap Save again. Look for: still exactly one row, now at the
top, showing the newer `mm:ss`. A duplicated row or an unchanged position is the failure.

---

## Acceptance criteria

Observable on the web build unless stated. Each maps to a phase and its checks.

1. **Save adds one row named from both tracks.** With a track on deck A and a track on deck B,
   Save on the Pairs tab adds exactly one row whose label contains both titles and the date;
   with deck A empty, Save is disabled and does nothing. (S9; web manual, `mergePairing` tests.)
2. **Tap starts A at the stored position and B looping.** Tapping a row starts deck A's
   audiobook at the `mm:ss` shown on the row, not 0:00, and deck B's background track keeps
   playing past its own end instead of stopping. (S1, S2, S3, S7; APK manual.)
3. **A second save of the same pair updates instead of appending.** Saving the same audiobook
   with the same background track twice leaves one row, moved to the top, with the newer
   position. (S9; `mergePairing` test, web manual.)
4. **A's position follows playback and survives a restart.** While the scene plays, the row's
   `mm:ss` grows; after backgrounding, killing and reopening the APK, tapping the same scene
   resumes within a few seconds of the point where playback actually stopped. (S8; APK manual,
   `positionWriter` test.)
5. **Delete removes the row and the payload shrinks.** The delete button raises the two-tap
   toast, confirming removes the row, the row does not come back after a reload, and the
   `ab-pairings` entry in localStorage is shorter and no longer contains that name. (S4, S6;
   e2e + web manual.)
6. **A missing B track still starts A with a toast.** With deck B's file renamed or removed,
   tapping the row starts deck A at its stored position, shows a toast saying the background
   track is missing, and leaves the row in place so the human can fix or delete it. With deck
   A's file gone, nothing starts and an error toast says so. (S7; `startPairing` test, APK
   manual.)
7. **The existing tabs still behave.** A, B and YouTube keep their positions and order, each
   deck still keeps its own queue and title across sub-tab switches, the MiniPlayer still
   drives the deck on screen, `page.locator('audio')` stays at 2, and radio or podcast playback
   still stops deck A and never deck B. (S1, S5, S6; existing
   `tests/e2e/music-player.test.ts` and `smoke.test.ts` stay green, manual web check.)

---

## Ordering and risk

- **Riskiest: S1.** It rewrites `nextIndex` and the `ended` listener, which are the single
  advance path for both decks and YouTube (`YoutubePanel.svelte:392` reads `isRepeat`). Three
  existing test blocks pin the behaviour it changes (`player.test.ts:114-162`,
  `getNextTrackIndex.test.ts:44-54`, the stop/resume block at `:432-502`). If it is wrong, the
  symptom is a deck that loops a whole audiobook or stops a background track, on a code path
  every listener uses.
- **Second riskiest: S7.** It is the only phase that starts playback on two decks from one tap,
  and the exclusivity invariants it must not break are pinned only in E2E
  (`music-player.test.ts:466-587`).
- **Largest: S3.** Five source files, two of them new modules, plus a registration effect in a
  2 400-line component. It is large but shallow: the logic all lives in the deck-side candidate
  resolution, which is a copy of `resolveFavoriteTrackFile`.
- **Must land together**: S1, S2, S3 and S4 are blockers for S7, and S7 without S5 has no
  surface, so **S5 + S7 are one shippable unit** (the tab plus its start action). S4 + S6 are
  one unit (store plus rows). S8 must land with or after S7; a writer with no active pair is
  inert but untestable end to end, so land S8 before the final e2e run.
- **Revertable independently**:
  - S9 (delete the Save button and the merge helper): rows, delete and start keep working.
  - S8 (delete the writer and its three flush calls): the scene keeps its saved position
    instead of following playback; acceptance criterion 4 regresses, nothing else.
  - S6 (rows and delete): store and start keep working, the tab shows an empty list.
  - S1: revertable **only before S7 lands**; afterwards B's loop depends on the queue mode.
  - S2: same condition, because S7's `apply` passes `startAtSec`.
  - S5 + S7: not revertable alone, and not revertable without S8's `activePairId` consumer
    being harmless (it is).

---

## Deviations from the outline

1. **S3's file list is incomplete.** The registered object carries `setLoop` (D1), and the
   module has no way to change a loaded queue's mode, so S3 also edits
   `src/lib/audio/player.svelte.ts` to add `Player.setLoop(mode)`. The outline lists four
   files; the real count is five.
2. **S3 also grows `startPlayback`'s options type** (`startAtSec`, `loop`) and passes
   `suppressAlert: true` from `apply`. The outline says "reuse the existing `startPlayback`"
   but not that its signature must carry the two new fields; without them `apply` cannot honour
   S1's and S2's new options, and without `suppressAlert` a missing file raises a blocking
   `alert()` (`:1092-1095`) instead of D5's toast.
3. **S5 follows D7's Structure amendment, not the outline's text.** The outline widens
   `mediaEngine.activeMusicDeck` to `'A' | 'B' | 'pairs'`; the amendment takes "its own piece of
   state" instead, so `activeMusicDeck` keeps meaning "which deck the controls act on". Reasons:
   the amendment postdates the outline, widening would make `MiniPlayer.svelte:461`
   (`activeMusicDeck === 'B'`, the deck B volume row) mean something it does not, and it would
   force edits to two unit-test writers (`mediaEngine.test.ts:150`, `:179`) for no gain. The
   cost is recorded in *Open*: the MiniPlayer's A/B toggle does nothing visible while the Pairs
   tab is selected, because the pairs selection is a separate local flag.
4. **S5's check filter is `-t "pairs tab"`**, not `-t "music:pairs"`. Test names read as
   behaviour, and the describe block carries the filter.
5. **S2 is scoped to `startCurrent` only.** The outline also routes `loadAndPlayAt` through the
   start position. The only caller of the feature (`player.play`) goes through `startCurrent`,
   while `loadAndPlayAt`'s callers are `next`, `prev` and `resume`, all of which must keep
   starting at 0. Touching them adds risk with no caller, so the option is consumed once, on
   the queue's first track, and explicitly cleared on advance.
6. **S6 renders the duration from the pair, not from the live queue.** D4's Structure
   amendment added `durationSec` to the pair, which resolves the outline's "D9's duration has
   no home" problem; the fallback the outline proposes is no longer needed.
7. **S8 adds `durationSec` to the write** and names the stop seam. D3 says "on stop"; the only
   stop that loses information is the cross-source steal, so the flush must run inside the
   `registerAudioSource` callback **before** `player.stop()` zeroes `state.currentTime`. The
   outline's trigger list does not name that seam.
8. **`removePairing` clears `activePairId`** when the active row is deleted. Neither D3 nor the
   outline says so, but without it S8 keeps writing a position to a row that no longer exists.
   It lives in S4, not S6.
9. **S9's 50-row cap is applied in memory as well as at serialisation.** The outline's *Watch*
   says the helper "should" apply the same bound; the plan makes it a requirement, because a
   51-row panel over a 50-row blob is a visible disagreement after a reload.
10. **Manual checks exist for S1, S2, S4 and S6**, which the outline marks "none needed".
    Each gets a regression check (S1, S2), a boot check (S4) or a hand-seeded row (S6), because
    every phase needs one and none of these can be observed from an automated run.
11. **`apply`'s status is `'started' | 'missing'`, not D1's `'started' | 'missing' | 'no-position'`.**
    `no-position` has no producer: a pair always carries `positionSec`, and 0 is a valid start,
    so nothing can distinguish "no position available" from "start at 0". The deck-level status
    names the deck (`'missing'`), and `startPairing` maps it to `'aMissing'` / `'bMissing'`,
    which is the distinction D5 actually needs.

---

## Open, accepted, or worth one line in the ADR

- **The transport hole on the Pairs tab (Q27).** With `activeView = 'music:pairs'`,
  `displayedSource` is `null` when nothing plays, no deck re-claims the engine slots, and the
  MiniPlayer drives whichever deck claimed last. Same shape as the Weather tab, but reachable
  one tap from a visible deck. Accepted and not fixed here; it becomes visible in S5's manual
  check and should be recorded rather than patched in this effort.
- **The MiniPlayer's A/B toggle does nothing visible on the Pairs tab** (consequence of
  deviation 3). Accepted.
- **The MiniPlayer loop toggle looks dead for a deck whose queue declares a mode**
  (`MiniPlayer.svelte:240-243` writes the global flag; S1's `resolvedLoop` ignores it for an
  explicit queue). Accepted by D2.
- **Cross-deck loop coupling is pre-existing**: `syncLoopTracksToSelection`
  (`Mp3PlayerView.svelte:1372-1393`) runs per deck and can clear the shared
  `musicSelectionLoopActive` global when one deck's selection empties. S1 must not make it
  worse, and the ADR should carry the line.
- **`setLoop` has no production caller** in any slice. It exists because D1 settles it, it is
  two lines (`Player.setLoop` plus the registry passthrough), and case 4 of S1 pins the module
  behaviour. If the human prefers no unused seam, drop it from the registry and from
  `Player`, and S7 still works because `apply` carries `loop`.
