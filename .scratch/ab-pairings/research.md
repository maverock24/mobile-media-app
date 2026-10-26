# A/B pairings — Research (merged, Q1–Q42)

Merged from `.scratch/ab-pairings/research/{1,2,3}.md` against the checked-out code on
`main`. Read-only: no code, test or commit was made. Every line number was re-read here;
where a cluster's number or count disagreed with the code, the code wins and the
disagreement is marked `CONFLICT`.

## Constraints that decide the design

1. **No deck can be commanded from outside its own component.** The instance is a
   component-local `const player = createPlayer(...)`
   (`src/lib/components/views/Mp3PlayerView.svelte:349`); the module exports only
   `createPlayer` and types (`src/lib/audio/player.svelte.ts:101`, `:127`), and neither
   deck is `bind:this`-ed at the shell (`src/routes/+page.svelte:232`, `:235`).
2. **The only two-way command channel into a deck is the engine's five scalar slots**, and
   they are single-owner: `setPlaybackHandlers`/`setSkipHandlers` overwrite
   `_onPlay/_onPause/_onSeek/_onNext/_onPrev` (`src/lib/stores/mediaEngine.svelte.ts:320-329`),
   claimed only by the deck where `displayedSource` names it
   (`src/lib/components/views/Mp3PlayerView.svelte:616`, `:668`, `:731`, `:739`).
3. **The only per-deck channel that reaches both decks at once can only stop them.**
   `registerAudioSource('musicA'|'musicB', () => player.stop())`
   (`src/lib/components/views/Mp3PlayerView.svelte:559-567`), and `claimAudio` skips every
   pair involving `musicB` (`src/lib/stores/mediaEngine.svelte.ts:43-51`), so Deck A
   claiming audio never stops Deck B.
4. **`player.stop()` is destructive to position, not to the queue.** `haltPlayback` zeroes
   `state.currentTime` and the element's, then `unload()` drops the `src`
   (`src/lib/audio/player.svelte.ts:231-238`, `:588-591`); a later `resume()` re-resolves
   and restarts at 0 (`:593-606`).
5. **Looping is one global boolean per mechanism, never per deck.** `musicSettings.isRepeat`
   is read by every deck (`src/lib/audio/player.svelte.ts:351`, `:483`) and by YouTube
   (`src/lib/components/ui/YoutubePanel.svelte:392`); `mediaEngine.musicSelectionLoopActive`
   is one global read through each deck's getter
   (`src/lib/components/views/Mp3PlayerView.svelte:363`). Per-deck settings exist only for
   volume and speed (`src/lib/stores/settings.svelte.ts:35-36`, `:51-52`).
6. **Repeat-one is not reachable from the UI.** Nothing sets `isRepeat = true`: the only
   writer is the reset at `src/lib/components/views/SettingsView.svelte:423`, plus E2E
   localStorage seeding (`tests/e2e/music-player.test.ts:233-235`). The `ended` listener is
   the sole implementation (`src/lib/audio/player.svelte.ts:480-490`).
7. **End of queue is decided in one place and consulted by neither deck's UI.** `trackCount
   === 1` returns `0` only when `isRepeat || selectionLoop`, else `null`
   (`src/lib/models/music.ts:284`); `null` halts (`src/lib/audio/player.svelte.ts:407`), the
   same-track branch rewinds and keeps `isPlaying` (`:410-421`).
8. **A live position exists only in memory.** `timeupdate` writes `state.currentTime` at most
   every 250 ms (`src/lib/audio/player.svelte.ts:125`, `:463-469`), mirrored unconditionally
   to `mediaEngine.deckACurrentTime`/`deckBCurrentTime`
   (`src/lib/components/views/Mp3PlayerView.svelte:695-709`). **Nothing in `src/` writes a
   playback position to localStorage.**
9. **The two resume fields that exist are tombstones.** `musicSettings.lastTrackTimestamp` is
   written as `0` at all 11 sites (`src/lib/audio/player.svelte.ts:326`, `:337`, `:413`,
   `:425`, `:479`, `:482`, `:495`, `:649`; `src/lib/components/views/Mp3PlayerView.svelte:127`,
   `:135`) and a view effect forces it back to `0` (`:553-557`);
   `mp3TrackPositions` is emptied on module load and has no reader
   (`src/lib/stores/settings.svelte.ts:143-149`).
10. **`persisted()` has no debounce and no field granularity.** One tracked read per top-level
    key (`src/lib/persisted.svelte.ts:81-88`), one flush per microtask (`:69-79`), and each
    flush re-serialises and rewrites the whole key (`:47-48`); `debounceMs` is ignored
    (`:10-11`), a quota throw is swallowed (`:50-56`), and mutating a nested array in place
    schedules nothing because the top-level key must be reassigned.
11. **A fourth sub-tab costs type surface plus a transport hole, not layout.**
    `MusicSubTab` (`src/routes/+page.svelte:52`) and `ActiveView`
    (`src/lib/stores/mediaEngine.svelte.ts:62-69`) both enumerate tabs and `activeView` is
    published from a template literal (`src/routes/+page.svelte:71`), so an unlisted tab fails
    typecheck; widened, `displayedSource` maps it to `null` (`mediaEngine.svelte.ts:213-219`),
    losing the paused-deck branch (`:235`) and leaving `_onPlay` to whichever deck claimed last.
12. **A new panel is always mounted, and two E2E invariants fence the music area.** Panels are
    toggled with `class:hidden`, never unmounted (`src/routes/+page.svelte:206`, `:231-236`,
    comment `:196-205`); `page.locator('audio')` must stay at 2
    (`tests/e2e/music-player.test.ts:194`, `:292`) and a new `role="tab"` name must be unique
    across both tablists (`src/routes/+page.svelte:208`, `:278`).

## Q1

`Player` is a 12-member interface — `state`, `play`, `load`, `append`, `clear`, `stop`,
`pause`, `resume`, `next`, `prev`, `seek`, `destroy`
(`src/lib/audio/player.svelte.ts:101-123`) — implemented as one returned object literal,
`:528-666`, by `createPlayer` (`:127`). The owning view holds it as `const player` at
`src/lib/components/views/Mp3PlayerView.svelte:349-366`. Zero methods are callable from
outside the view's scope today (Q2); five are reachable indirectly through the engine —
`stop()` via the registered audio-source callback (`:559-567`), `pause()`/`resume()`/`seek()`
via the playback slots (`:592-600`), `next()`/`prev()` via the skip slots (`:601-607`).
`play`, `load`, `append`, `clear` and `destroy` have no outside caller at all.

## Q2

No. The instance is a component-local `const` (`Mp3PlayerView.svelte:349`), the module's only
exports are `createPlayer` (`player.svelte.ts:127`) and the types `PlayerTrack`/`PlayerState`/
`Player` (`:25`, `:36`, `:101`), and neither mount binds a ref
(`src/routes/+page.svelte:232`, `:235`). There is no player registry, Svelte context or store
anywhere; the two registries that do exist hold zero-arg closures
(`src/lib/stores/musicView.svelte.ts:13`, `mediaEngine.svelte.ts:37`).

## Q3

`registerMusicPlayerView` adds a zero-arg handler to a module `Set` and returns an unregister
function (`src/lib/stores/musicView.svelte.ts:17-22`); `requestMusicPlayerView` calls every
handler (`:25-27`). Both decks register on mount
(`src/lib/components/views/Mp3PlayerView.svelte:571-576`), so one request applies to both,
but each handler only sets its own `showQueue = false` (`:573-575`): it is a browse-to-player
navigation signal, not a transport command. The sole caller is the MiniPlayer's "Return to
music player" button (`src/lib/components/ui/MiniPlayer.svelte:267`).

## Q4

`_stopFns` is a module-level object keyed by `AudioSourceId`
(`src/lib/stores/mediaEngine.svelte.ts:36-41`); `claimAudio` calls every entry except the
claimer's, with `if (id === 'musicB' || other === 'musicB') continue`
(`:43-51`), then tears down the engine-owned radio stream unless the claim is `radio` or
`musicB` (`:53-56`). A deck's callback runs `player.stop()`
(`src/lib/components/views/Mp3PlayerView.svelte:561-566`) — queue survives, position does not
(`player.svelte.ts:588-591`). Ids are the deck prop mapped to `'musicA'`/`'musicB'`
(`Mp3PlayerView.svelte:560`); five are registered today: `musicA`/`musicB` (`:561`),
`podcast` (`PodcastView.svelte:165`), `radio` (`RadioView.svelte:34`), `youtube`
(`YoutubePanel.svelte:121`); `'essay'` and `'mixer'` exist in the union
(`mediaEngine.svelte.ts:36`) and have no registrant.

## Q5

A deck claims two handler groups in `claimMusicControls`
(`src/lib/components/views/Mp3PlayerView.svelte:592-608`): `setPlaybackHandlers(resumePlayback,
pausePlayback, handleSeekSeconds)` and `setSkipHandlers(skipNext, skipPrev)`, which assign
scalar module fields with no owner check (`mediaEngine.svelte.ts:320-329`), so last writer
wins and there is no per-deck list. The gate is
`mediaEngine.displayedSource === (deck === 'A' ? 'A' : 'B')`
(`Mp3PlayerView.svelte:616`, repeated `:731`), with the claim under it at `:668` and `:739`; a
single-valued getter (`mediaEngine.svelte.ts:211-249`) means two decks cannot pass in one
flush. The consequence: on any non-deck view neither deck claims and the previous deck's
closures stay installed, because nothing clears the slots.

## Q6

The MiniPlayer resolves `mediaEngine.displayedSource` (`MiniPlayer.svelte:34-36`) and drives
playback only through the engine slots: seek `:178`, play/pause `:183-187`, prev/next
`:190-195`. It never names a deck, and with both decks playing on the music tab it reaches the
visible deck, because `displayedSource` prefers the view's own source while it plays
(`mediaEngine.svelte.ts:223`); on a non-music tab it shows Deck A (fallback order `:241-243`,
pinned by `tests/unit/stores/mediaEngine.test.ts:192-198`). The hidden deck keeps playing
untouched, so its transport is unreachable until its sub-tab is selected. Speed is Deck A only
— label `:174`, write `musicSettings.deckASpeed` `:220`, chip at `:367` — while the volume row
renders only for Deck B (`:461-476`).

## Q7

`FavoriteTracksOptions.startPlayback` is typed
`(files, index, options?: { selectionLoop?, preserveOrder?, suppressAlert? }) => Promise<boolean>`
(`src/lib/favorites/favoriteTracks.ts:99-105`). `playFavoriteTrack` calls
`beginQueue('Favorite Tracks')` (`:264`) then
`startPlayback(files, nextIndex, { preserveOrder: true })` (`:265`). The implementation
(`Mp3PlayerView.svelte:1082-1105`) awaits `player.play(...)` (`:1088-1091`), bails on
`player.state.error` (`:1092-1095`), calls `syncTrackToMediaEngine` (`:1097`), sets the deck
playing flag (`:1099-1101`), then `claimAudio` (`:1103`). Everything set before audio is
bookkeeping done by `beginQueue` (`:1073-1078`): `queueSessionId`, shared `lastFolderName`,
`trackListLockedByUser`, and `musicSelectionLoopActive = false`.

## Q8

Global to both decks: `musicSettings.isRepeat` (`src/lib/stores/settings.svelte.ts:39`),
`musicSettings.isShuffle` (`:38`), `mediaEngine.musicSelectionLoopActive`
(`mediaEngine.svelte.ts:122`) and `musicHasSelectedTracks` (`:123`). Per-instance: the player's
own `selectionLoop` snapshot (`player.svelte.ts:156`, written only by `loadQueue` `:303`) and
the optional live getter `isSelectionLoop` (`:98`), which the view always supplies and wires to
the global (`Mp3PlayerView.svelte:363`) — so in the app the snapshot is dead. Per deck but with
no engine mirror beyond a boolean: `selectedBrowseFileKeys` (`:182`). There is no per-deck
repeat flag and no per-deck loop field of any kind.

## Q9

The element's `ended` listener clears `isBuffering`, zeroes `lastTrackTimestamp`, and when
`settings.isRepeat && !isSelectionLoopActive()` sets `element.currentTime = 0` and calls
`safePlay()` (`src/lib/audio/player.svelte.ts:480-490`); otherwise it calls `advanceTrack(true)`
(`:488`). It never consults the queue length. Length is handled one level down: `trackCount ===
1` returns `0` when `isRepeat || selectionLoop`, else `null` (`src/lib/models/music.ts:284`),
pinned by `tests/unit/models/getNextTrackIndex.test.ts:44-54`. Since no UI writes
`isRepeat = true`, this branch is reachable today only from persisted or seeded state.

## Q10

The selection loop loops over the per-deck ticked browse rows (`Mp3PlayerView.svelte:884-909`),
materialised by `preloadLoopSelection` as `beginQueue(label, {selectionLoop:true})`,
`player.clear()`, `player.load(selected, {selectionLoop:true, startIndex:0})` (`:915-924`), in
tick order from `getSelectedBrowseFilesInOrder` (`:934-950`); `loadQueue` skips sorting when
the flag is set (`player.svelte.ts:297`). The only explicit toggle is the MiniPlayer button
(`MiniPlayer.svelte:237-246`); ticking a row writes the flag directly (`:904`, `:907`). Turning
it off sets both engine flags false and a view effect clears that deck's keys
(`Mp3PlayerView.svelte:583-590`); when the selection empties during playback
`syncLoopTracksToSelection` sets the global flag false and returns (`:1372-1393`) — and because
it runs per deck through `onBeforeAdvance` (`:360`), an empty selection on one deck disables the
other deck's loop on its next advance.

## Q11

`isRepeat` is read at `player.svelte.ts:51` (interface field), `:351` (into `nextIndex`) and
`:483` (`ended`), and at `YoutubePanel.svelte:392`; it is written only by the reset at
`SettingsView.svelte:423` and the default at `settings.svelte.ts:39`. `musicSelectionLoopActive`
is written at `Mp3PlayerView.svelte:122`, `:242`, `:904`, `:907`, `:927`, `:1077`, `:1377`,
`MiniPlayer.svelte:240`, `:243` and `browseNavigation.svelte.ts:249`, and read at
`Mp3PlayerView.svelte:363`, `:585`, `:1344`, `:1350`, `:1373`, `MiniPlayer.svelte:238-296`.
Because both decks pass the same `musicSettings` object into `createPlayer`
(`Mp3PlayerView.svelte:350`) and read the same engine boolean (`:363`), one value drives both:
set repeat for A and B repeats the same track too. The two fields that would have to change
owner are `musicSettings.isRepeat` and `mediaEngine.musicSelectionLoopActive`; the selection
loop is already per-deck in everything but its flag, since the ticked keys and the queue built
from them are per deck.

## Q12

A one-track queue with no flags: `nextIndex` returns `null` (`music.ts:284`), so `advanceTrack`
takes the `next === null` branch, calls `haltPlayback()` and returns `false`
(`player.svelte.ts:407`) — queue and `src` stay, `isPlaying`/`isBuffering` go false,
`state.currentTime` and the element are zeroed, element paused (`:231-238`). On the same-track
loop branch (`:410-421`) it calls `setCurrentTrack(next)`, sets `state.currentTime = 0` and
`lastTrackTimestamp = 0`, reloads the `src` only when the element is in an error state and
otherwise sets `el().currentTime = 0`, then when `wasPlaying` clears `isBuffering` and calls
`safePlay()` — so `isPlaying` stays true and only the position restarts. It returns `false`, so
the view does not re-claim the channel (`Mp3PlayerView.svelte:1417-1421`).

## Q13

Origin: the element's `timeupdate`, which skips while a seek is in flight (`seeking !== null`,
`player.svelte.ts:464`), skips if under `THROTTLE_MS = 250` has elapsed (`:125`, `:466`) and
otherwise copies `element.currentTime` into `state.currentTime` (`:468`) — at most ~4 Hz. The
view then mirrors it with no gate: one effect reads `player.state.currentTime` and writes
`mediaEngine.deckACurrentTime`/`deckBCurrentTime` (`Mp3PlayerView.svelte:695-709`), and an
earlier effect pushes an `untrack()` snapshot when metadata or buffering changes (`:637`,
`:650`), calling `mediaEngine.updateTime` only when this deck owns the display (`:706-708`).
The fields are declared at `mediaEngine.svelte.ts:135-136`; the only reader is
`MiniPlayer.svelte:67-72`.

## Q14

Yes. The push at `Mp3PlayerView.svelte:695-709` is not gated on the deck being displayed — only
the transport claim is (`:668`) — so `deckBCurrentTime` is live while the A sub-tab shows, which
is what the MiniPlayer's deck switch reads (`MiniPlayer.svelte:68-71`). `mediaEngine.clear()`
zeroes both deck times (`mediaEngine.svelte.ts:355-356`) along with both items, durations,
buffering flags and every `*Playing` flag (`:339-361`), and sets `source = null` (`:354`). The
zero does not stick while a deck is mounted: the deck effect reads `displayedSource`/`source`
(`Mp3PlayerView.svelte:616`, `:706`), re-runs, and writes its live time straight back.

## Q15

`lastTrackKey` and `lastTrackIndex` are written together by `setCurrentTrack` on every selection
(`player.svelte.ts:217-221`), and both decks write the same two fields, so they are
last-writer-wins across decks — which is why the view refuses its own `lastTrackIndex` read for
restore (`Mp3PlayerView.svelte:537-541`) and matches on `lastTrackKey` against the sorted list
with `lastTrackIndex` as fallback (`:142-150`). `lastTrackTimestamp` is documented as "seconds —
saved on pause/steal for UX continuity" (`settings.svelte.ts:47`) but is never given a nonzero
value: all 11 assignments are `= 0` (`player.svelte.ts:326`, `:337`, `:413`, `:425`, `:479`,
`:482`, `:495`, `:649`; `Mp3PlayerView.svelte:127`, `:135`), and an effect whose whole body is
the reset forces it back to `0` (`:553-557`). It is the tombstone of a removed resume feature:
commit `77fb0ec` deleted the `= audioEl.currentTime` writers, turned the restore read into
`currentTime = 0`, and added that reset effect in the same diff.

## Q16

`mp3TrackPositions` is a `persisted('mp3-track-positions', { positions: Record<string, number> })`
store keyed by track key (`settings.svelte.ts:143-145`), emptied three lines later on module
load (`:147-149`). Nothing reads or writes it: `grep -rn mp3TrackPositions src/ tests/ docs/`
returns only those three lines. The mechanism is dead; its only live effect is that booting the
app writes `{"positions":{}}` (16 B) back to the key.

## Q17

`stop()` is `haltPlayback()` plus `unload()` (`player.svelte.ts:588-591`) and keeps the queue.
`haltPlayback` sets `isPlaying`/`isBuffering` false, zeroes `state.currentTime`, pauses the
element and sets `element.currentTime = 0` (`:231-238`); `unload` removes `src` and calls
`element.load()` (`:224-228`). So after a foreign source claims audio, the only survivor is the
queue and `currentIndex`. `resume()` in that state takes the no-`src` branch: re-select the
index, `loadAndPlayAt(index, true, true)` — re-resolve the URL and play from the beginning
(`:593-606`); the native `src` re-set that preserves position (`:608-618`) is unreachable
because `stop()` already removed the `src`.

## Q18

Three things collide. (a) The write rate: `state.currentTime` changes ~4 times a second
(`player.svelte.ts:125`, `:463-469`). (b) The write cost: `persisted()` coalesces per microtask,
not per second (`persisted.svelte.ts:69-79`), and each flush re-serialises and rewrites the
whole key (`:47-48`) — for `music-settings` that is the 500 B default plus every favourite
(measured below in Q21), several times a second. (c) Precedent already paying for it: podcast
progress keeps the position in memory every tick and commits every 20 s plus on pause, with the
docstring naming the exact failure — each flush serialises the entire trimmed blob and "a single
over-quota write permanently kills that store" (`src/lib/podcast/progress.ts:40-49`, used at
`podcastPlayer.ts:213-232`). Nothing else writes localStorage from `timeupdate`; the only other
`timeupdate` listeners are `YoutubePanel.svelte:539` and the podcast element. Timer-driven
writers are the sleep timer's 1 s tick, which re-assigns the same `endsAt` so no flush fires
(`sleepTimer.svelte.ts:22-26`, `:44-46`), the podcast 20 s flush, and two native-only
`MediaControls` timers that touch no storage (`mediaEngine.svelte.ts:918-922`, `:756-769`).
Note `musicSettings`'s `debounceMs: 5000` (`settings.svelte.ts:60`) is ignored
(`persisted.svelte.ts:10-11`), so no design may assume five seconds of slack.

## Q19

Init: `localStorage.getItem` inside `try` (`persisted.svelte.ts:26`), then a shallow merge
`stored = { ...defaults, ...JSON.parse(raw) }` (`:27-28`) — new top-level keys get defaults,
unknown legacy keys survive in memory — falling back to the defaults literal on a throw
(`:29-31`), then `structuredClone` into `$state` (`:34`). Reactivity: one read per
`Object.keys(defaults)` entry, then `scheduleFlush()` (`:81-88`); keys that exist only in
storage are never tracked. Write path: optional `trim`, `JSON.stringify`, one `setItem`
(`:47-48`), deferred to the end of the microtask so mutations in one event loop coalesce
(`:69-79`); `trim` affects only the serialised copy. Quota: the `setItem` is caught, logged once
behind `_writeErrorLogged` and swallowed so the effect is not torn down (`:50-56`). Lifecycle
flushes run synchronously on `pagehide`, `beforeunload`, `visibilitychange` when hidden, and the
Capacitor `pause` event (`:99-106`).

## Q20

No. Tracking is per top-level property (`persisted.svelte.ts:84`), so `push`/`splice` on a
nested array writes sources the effect never read and no flush is scheduled; reassigning the key
does. Every existing touch of a persisted list replaces the array — `toggleFavoriteTrack`
(`favoriteTracks.ts:208`), `removeFavoriteTrack` (`:215`), folder favourites
(`folderPicker.svelte.ts:234`, `:245`, `:247`). Evidence in tests is positive-case only:
`tests/unit/models/podcast-persist.test.ts:13-40`, `:63-100`, and
`tests/unit/favorites/favoriteTracks.test.ts` checks in-memory shape, not persistence. No test
pins the negative case (see Q42).

## Q21

Eight `persisted()` keys, measured by `JSON.stringify` over the default literals in
`src/lib/stores/settings.svelte.ts`:

| key | declared | default | growth |
|---|---|---|---|
| `app-settings` | `:8-18` | 195 B | fixed |
| `sleep-timer-settings` | `:25-28` | 33 B | fixed |
| `music-settings` | `:33-60` | **500 B** | favourites, folder rows, `lastTrackKey`, `browsePath` |
| `podcast-settings` | `:72-79` | 84 B | fixed |
| `podcast-data` | `:110-141` | 84 B | **dominant**: ~830 B per episode with a 600-char body, capped at 120/podcast (`:126`) |
| `mp3-track-positions` | `:143-145` | 16 B | wiped on load (`:147-149`) |
| `weather-settings-v2` | `:162-192` | 497 B | small per city |
| `radio-data` | `:196-198` | 16 B | ~237 B per station |

Per-item growth, measured on the real shapes:
`FavoriteTrack` native ≈ 222 B, drive ≈ 294 B, web ≈ 118 B (shape at `models/music.ts:43-50`),
scaling with path/id length; a device folder row with a SAF `treeUri` ≈ 124 B
(`settings.svelte.ts:57`). `CONFLICT:` research/2 reports ~345 B native / ~382 B drive / ~155 B
web; the difference is sample path length, not a different shape — neither is a constant.
Seven more keys are written directly: `google-drive-session`
(`googleDriveSession.svelte.ts:28`, `:55`), `runtime-diagnostics`, at most 20 entries each with
message/stack/details/userAgent (`runtimeDiagnostics.svelte.ts:2`, `:71`), `navigation-state`
(`+page.svelte:28`, `:141-143`), `update-offered-version` (`androidUpdate.ts:71`, `:100-102`),
`youtube-audio-save-phase` (`saveMarker.ts:10`), `google-drive-folder-picker-pending`
(`folderPicker.svelte.ts:33`), and `runtime-error-notice-shown` which is sessionStorage
(`+page.svelte:105`). **No numeric budget is documented anywhere**: the only statements are
qualitative (`persisted.svelte.ts:14-24`, `settings.svelte.ts:113-124`), and nothing reads
`navigator.storage`. The known failure mode is a swallowed `QuotaExceededError`, covered by
`tests/unit/models/podcast-persist.test.ts:102-118`.

## Q22

Migration is an in-place patch at module load with no version field and no deletion: the legacy
single `playbackSpeed` is cast, copied into `deckASpeed`/`deckBSpeed` and left in place
(`settings.svelte.ts:62-68`), surviving in storage because the init merge keeps unknown keys and
untracked because `Object.keys(defaults)` no longer lists it; the same style normalises
`listTileTone` at import (`:20`). The size-bounded precedent is `trim`, used once: `podcastData`
keeps the manifest and caps episodes at `MAX_EPISODES_PER_PODCAST = 120`, preferring played/in-
progress episodes then the newest (`:125-141`), applied at serialisation only
(`persisted.svelte.ts:47`). `favoriteTracks` and `mp3TrackPositions` have neither `trim` nor cap.

## Q23

Two precedents, both keyed rather than indexed and both unbounded. `musicSettings.favoriteTracks`
is `FavoriteTrack[]` (`settings.svelte.ts:58`), a four-variant discriminated union —
`web` / `native` (+`path`) / `drive` (+`fileId`) / `youtube` (+`videoId`) (`models/music.ts:43-50`)
— where every row carries its own `key`, always `getStoredFileKey(file)`
(`favoriteTracks.ts:133`), plus denormalised `name`/`title`/`artist`/`relativePath` so the row
renders without a library. `favoriteFolders` is the smaller inline shape with a SAF `treeUri`
(`settings.svelte.ts:57`). Dead references are not pruned: resolution falls through to `null`
(`favoriteTracks.ts:194`) and the caller toasts (`:246-259`), so a favourite for a deleted file
stays forever and fails politely at play time.

## Q24

`musicSubTab` is derived, not stored: `youtubePanel.open ? 'youtube' : mediaEngine.activeMusicDeck`
(`src/routes/+page.svelte:52-55`), typed `'A' | 'B' | 'youtube'` (`:52`); `selectMusicSubTab`
early-returns if unchanged, opens the panel for `'youtube'`, otherwise writes
`mediaEngine.activeMusicDeck` and calls `closeYoutubePanel()` (`:57-66`). `activeMusicDeck` is
`'A' | 'B'` with default `'A'` (`mediaEngine.svelte.ts:124`, `:193`); its only writers are
`+page.svelte:62` and two unit tests (`tests/unit/stores/mediaEngine.test.ts:150`, `:179`), its
only other reader is `MiniPlayer.svelte:461`. The existing third tab works solely because
`youtubePanel.open` is a separate flag (`youtubePanel.svelte.ts:10-16`) that wins by precedence
inside the derivation; a second non-deck tab therefore needs a defined precedence between two
flags, which no current code expresses — and a `pairs` branch that forgets
`closeYoutubePanel()` leaves `open` true and the derivation returns `'youtube'` (`:63`).

## Q25

Both decks sit in the music wrapper (`class:hidden={activeTab !== 'music'}`, `+page.svelte:206`),
each in its own `class:hidden={musicSubTab !== 'A'|'B'}` panel (`:231-236`), and the wrapper
comment states the contract (`:196-205`): `display:none` does not pause audio and nothing
unmounts, so every `$effect` keeps running while hidden, including the always-push effect and
the transport claim (`Mp3PlayerView.svelte:615-689`, `:695-709`); audio is unaffected because
the element is created detached by the module (`player.svelte.ts:146`). Props in are
`{ deck, activeTab }` (`Mp3PlayerView.svelte:103`) and `activeTab` is never read again — it is a
dead prop. `YoutubePanel` takes no props, self-gates on `youtubePanel.open`
(`+page.svelte:248`; `YoutubePanel.svelte:554`) and deliberately keeps its audio outside the
gate; only weather and settings are `{#if}`-mounted (`+page.svelte:257-266`).

## Q26

The shell publishes one string: `mediaEngine.activeView = activeTab === 'music' ?
\`music:${musicSubTab}\` : activeTab` (`+page.svelte:70-72`), against
`ActiveView = 'music:A' | 'music:B' | 'music:youtube' | 'podcasts' | 'radio' | 'weather' |
'settings'` (`mediaEngine.svelte.ts:62-69`). `activeView` has exactly one reader, the
`displayedSource` getter (`:212`), which feeds `MiniPlayer.svelte:35` and every source's
self-gate (`Mp3PlayerView.svelte:616`, `:731`; `YoutubePanel.svelte:132`;
`PodcastView.svelte:332`; `RadioView.svelte:72`). A `pairs` tab must publish `'music:pairs'`,
which the template-literal operand rejects at typecheck; widened, the view map at `:213-219`
falls to `null`, so the playing-view branch (`:223`), the primary-state branch (`:227-230`) and
the keep-the-paused-deck branch (`:235`) cannot fire, and `:241-243`/`:245` return A, B, podcast
or radio by playback, else `null`. The A-over-B tie-break is pinned by
`tests/unit/stores/mediaEngine.test.ts:192-198`.

## Q27

The deck's transport claim does not depend on visibility, only on `displayedSource`
(`Mp3PlayerView.svelte:616`, `:731`, claim at `:668`, `:739`), and MediaSession is engine-owned:
three effects read `mediaEngine.item`/`isPlaying`/`duration`/`currentTime`
(`mediaEngine.svelte.ts:561-593`) and the action handlers dispatch to the slots (`:599-625`); a
deck writes those globals only under `isMusicView && musicOwnsDisplay`
(`Mp3PlayerView.svelte:672-686`). So on a pairs tab whose `activeView` is unrecognised,
`displayedSource` is `null` when nothing plays, no deck claims, and the slots keep the last
claimer (`mediaEngine.svelte.ts:320-329` — no owner check, no production clear path), which makes
the MiniPlayer's play button drive a stale deck while a paused deck cannot be reached at all.
`CONFLICT:` research/3 states that on a pairs tab "exactly one deck holds the MiniPlayer
transport, picked by playback"; research/1 states the transport "still follows the last deck that
claimed the slots". Both are true in different sub-cases — while a deck plays it re-claims, and
while neither plays the stale closures survive — but the nothing-playing case is the one that
breaks the paused-deck route.

## Q28

The bar is `role="tablist"` with `aria-label="Music player"` (`+page.svelte:208`) and three
`role="tab"` buttons carrying `aria-selected` and text-only accessible names `A`, `B`,
icon + `YouTube` (`:209-228`); there is no `aria-controls`, `id`, `role="tabpanel"` or roving
`tabindex`. The same aria-label is also on the deck's player region
(`Mp3PlayerView.svelte:2181-2182`), which is why the E2E helpers select the region by CSS
instead of role (`tests/e2e/music-player.test.ts:53-56`, `:64-76`). The bottom nav is a second
`role="tablist"` with `aria-label="Navigation"` whose buttons carry explicit `aria-label`s
(`+page.svelte:278`, `:285`). E2E addresses sub-tabs by exact name throughout (`:271`, `:333`,
`:347`, `:351`, `:357`, `:364`, `:409`, `:422`, `:446`, `:539`, `:569`, `:576`;
`tests/e2e/smoke.test.ts:91-92`), so a new button's name must be unique across both tablists.

## Q29

`getStoredFileKey` returns `d:${fileId}`, `n:${relativePath}` or `w:${relativePath}`
(`src/lib/models/music.ts:135-139`), and `getTrackKey` is an alias (`:141-143`); the prefixes
keep source families apart. The key deliberately leaves out the container: a native file carries
both `relativePath` and an absolute `path` (`:18`) and only the former is hashed, and the SAF
tree URI is absent too, so two libraries holding `Album/x.mp3` collide as `n:Album/x.mp3`.
`src/lib/browse/libraryDelta.ts:16-19` states the choice and its cost (a rename is one removal
plus one addition). Consumers make a collision a silent drop, not an error: `mergeStoredFiles`
dedupes by key (`music.ts:243-256`), `append` re-points by key (`player.svelte.ts:553-555`), and
favourites match on it (`favoriteTracks.ts:166-167`).

## Q30

`resolveTrackUrl` (`Mp3PlayerView.svelte:1014-1061`) is the URL seam: native first tries
`Capacitor.convertFileSrc(source.path)` when it actually transforms the path (`:1023-1031`;
same fast path at `fileResolver.ts:62-71`), then `materializeStoredFile` + `createObjectURL`
(`:1033-1035`) with a revocation cleanup attached to the live track (`:1046-1047`); failures
toast and return `null` (`:1058-1061`). After a restart each source needs: **web** the live
`File`, which only the IndexedDB cache holds (`libraryCache.ts:167-172`, from
`models/music.ts:64`); **native** `path` per file plus `musicSettings.nativeTreeUri` to
re-establish the scan; **drive** `fileId` plus a token (`driveLibrary.ts:356-384`), with Drive
files deliberately absent from the device cache (`libraryCache.ts:86-110`). A gone file surfaces
as an element `error`, retried once then advanced (`player.svelte.ts:493-513`), or as
`state.error` when resolution returns `null` (`:335`).

## Q31

The module header states the per-source contract, including the `null` results, as preserved
behaviour (`favoriteTracks.ts:1-58`, especially `:47-52`). Resolution is library index → live
queue → per-source reconstruction (native needs `path`, drive needs `fileId`), else `null`
(`:165-194`); a web favourite with no loaded `File` cannot resolve at all. `playFavoriteTrack`
turns both dead cases into a toast without throwing — single unresolved (`:246-250`), empty batch
(`:253-259`) — then `beginQueue` + `startPlayback(..., { preserveOrder: true })` (`:262-268`),
all under the per-deck `isChangingTrack` guard released in `finally` (`:240`, `:270`). Tests:
`tests/unit/favorites/favoriteTracks.test.ts` (23 cases), `tests/unit/models/play-favorite-flow.test.ts`
(17), `tests/unit/models/favorite-crash-scenarios.test.ts` (9).

## Q32

The web variant is `{ source: 'web'; name; relativePath; file: File }`
(`src/lib/models/music.ts:15`), and the cache stores that `File` itself
(`CachedWebLibraryFile`, `:64`), copied by `saveCachedLibrary` (`libraryCache.ts:86-95`) and
written with `idbPut` (`:126-128`), so IndexedDB structured-clones the blob — the only reason a
web library survives a restart, since the key for web is just `w:relativePath`
(`models/music.ts:135-139`). Restore on mount needs no gesture: the mount effect loads the
cached library and calls `hydrateTracksFromLibrary(allFiles)` (`Mp3PlayerView.svelte:1553-1557`),
then a warm refresh (`:1577`); the gesture requirement applies only to File System Access
permissions, where `queryPermission` is safe without one and a `'prompt'` result parks the handle
for the Reconnect button (`:1588-1597`). The Drive branch of the same effect reuses the persisted
token silently (`:1529-1545`).

## Q33

All four hints are single-valued in the shared `musicSettings` store
(`settings.svelte.ts:40-43`), while a deck's library state (`deviceLibrary`) is per instance.
Native picks write through to them: `deviceLibrary.svelte.ts:216-217` (source + folder label),
`:555` (tree URI), `:599`, `:626`, `:653`, `:678` (clears); Drive writes
`librarySource`/`nativeTreeUri`/`lastFolderName` in `activateDriveLibrary`
(`driveLibrary.ts:148-150`) and `driveFolderId` in `switchToFavorite` (`:452-453`) and the view's
`confirmDriveFolderSelection` (`Mp3PlayerView.svelte:996-1000`). `beginQueue` overwrites
`lastFolderName` on every start (`:1073-1075`), as does `appendTracksToQueue` (`:1122`), so it is
also a free-text queue label (`favoriteTracks.ts:264`), not a library name. Consequence: for a
pairing whose A track is native and B is Drive there is one persisted restore hint, and after a
restart both decks restore whichever library was loaded last (`Mp3PlayerView.svelte:1526-1560`).

## Q34

The per-deck part is a cache only: each deck calls `createDriveSession(...)`
(`Mp3PlayerView.svelte:185`, intent at `:183-184`), while the durable token lives in the shared
`googleDriveSession` store under `google-drive-session`
(`googleDriveSession.svelte.ts:28`, written `:45-55`). `ensureDriveAccessToken` resolves in
order: a valid local token with the delete scope (`driveSession.svelte.ts:60-65`), the shared
store (`:72-78`), a **one-shot** native pending authorization consumed without a guard
(`:81-93`; `google-drive.ts:247-263`), then a full OAuth request only when `interactive`
(`:102-118`), else `null`. For a pairing with both tracks on Drive, both decks reach
`materializeStoredFile` → `ensureDriveAccessToken` (`driveLibrary.ts:356-366`) and normally share
one token; the real costs are two simultaneous downloads and the one-shot gap, where only the
first caller gets the pending response and a non-interactive second returns `null`, surfacing as
"Your Google Drive session has expired" (`driveLibrary.ts:367-369`).

## Q35

`claimAudio` runs every registered stop callback except its own, with one hard-coded exception:
`if (id === 'musicB' || other === 'musicB') continue` (`mediaEngine.svelte.ts:43-50`), then tears
down the engine radio stream for any non-radio, non-Deck-B claim (`:53-56`). The exception is
Deck B, stated in the module header (`:21-33`) and in the state spec's invariant
(`docs/state/audio-playback-lifecycle.md:46-48`). So a podcast claim (`podcastPlayer.ts:184`,
`:397`, `:455`), a radio claim (`RadioView.svelte:112`; `mediaEngine.svelte.ts:370`) or a YouTube
claim (`YoutubePanel.svelte:251`, `:455`) stops Deck A and leaves Deck B playing; symmetrically,
Deck A's claim stops those sources and never Deck B, and Deck B's claim stops nothing. Both
halves are pinned by E2E: radio stops Deck A (`tests/e2e/music-player.test.ts:466-511`) and does
not stop Deck B (`:514-587`).

## Q36

Order is: this source's playing flag first, then `claimAudio`. The reason is visible in the
engine — `isPlaying` is derived from the per-source flags (`mediaEngine.svelte.ts:203-206`) and
`pause()`/`clear()` call `markUserPaused()` before dispatching (`:265-266`, `:340`) — so a claim
that ran first would stop other sources while this source still read as not playing. The deck
does exactly this in `startPlayback` (`Mp3PlayerView.svelte:1099-1103`, comment `:1099`), in
`resumePlayback` (`:1358-1365`, same comment) and in `claimDeckAudioForSkip` (`:1407-1414`), and
only claims when playback actually began: `skipNext`/`skipPrev` gate on the promise
(`:1417-1429`). Other sources follow the same convention (`podcastPlayer.ts:394-397`,
`YoutubePanel.svelte:247-251`, `mediaEngine.svelte.ts:366-370`).

## Q37

The knob is the pair of slots `mediaEngine._onPause`/`_onPlay`, written only by the deck that
`displayedSource` names (`Mp3PlayerView.svelte:616`, `:668`, `:739`). Every pause path routes
through them, so exactly one deck pauses: the sleep timer
(`sleepTimer.svelte.ts:28-33`, `mediaEngine._onPause?.() ?? mediaEngine.pause()`), the MiniPlayer
(`MiniPlayer.svelte:183-187`), the web MediaSession pause action (`mediaEngine.svelte.ts:603`) and
the native `mediaAction` pause (`:827-828`). The other deck keeps playing. One global side effect
rides along regardless of deck: `markUserPaused()` clears the single `_userWantsPlayback` latch
(`:89-93`) that Android background recovery is gated on (`:719`, `:761`), and an `isPlaying`
effect re-arms it (`:776-778`).

## Q38

`tests/unit/models/player.test.ts` is the only suite over the module: 610 lines, 13 `describe`
blocks, **34** `it()` cases, against a hand-written `FakeAudio` (`:6-36`) and a `makePlayer`
factory injecting `settings`, a mocked `resolveUrl`, `createAudio` and `native: false`
(`:38-53`), with `flush()` a 5 ms timeout (`:55`). `CONFLICT:` research/3 reports 47 cases; the
file holds 34. What constrains a new path: `describe('player — repeat-one')` (`:114-162`) pins
same-track rewind (index unchanged, `audio.currentTime` 0, `playCalls` up) and that the live
`isSelectionLoop()` getter beats the snapshot from `play()`; `getNextTrackIndex.test.ts:44-54`
pins single-track stop/loop; `describe('player — stop and resume (cross-source exclusivity)')`
(`:432-502`) asserts `audio.src === ''` after `stop()` and a restart from the beginning on
`resume()`. Nothing constrains start-at-position, because the API has none:
`PlayerQueueOptions` carries only `preserveOrder`/`selectionLoop` and `PlayerLoadOptions` adds
only `startIndex`/`keepCurrent` (`player.svelte.ts:65-77`); `seek` is covered once, at `:216-218`.

## Q39

`tests/unit/stores/mediaEngine.test.ts` has 18 cases in 5 blocks: `isPlaying` derivation (`:17`),
`setNowPlaying`/`clear` (`:47`), exclusivity (`:84-142`, ending with the two Deck-B assertions at
`:126-140`), `displayedSource` (`:145-200`, 6 cases) and transport fallbacks (`:202-224`). The
`displayedSource` cases set `mediaEngine.activeView` directly (`:151`, `:162`, `:170`, `:178`,
`:188`, `:194`), so a new `ActiveView` member needs a case here to be constrained at all, and no
case feeds an unrecognised view. The other two suites cover different facets — Android
intent-vs-instantaneous-state recovery (`mediaEngineBackgroundResume.test.ts`, 7 cases) and the
native position re-sync tick (`mediaEngineNativeTick.test.ts`, 1 case). No unit test constructs
two decks; both-decks behaviour exists only in E2E (Q41).

## Q40

Three suites, none touching the view: `tests/unit/favorites/favoriteTracks.test.ts` (23 cases
over create/resolve/is/toggle/remove/batch/play), `tests/unit/models/play-favorite-flow.test.ts`
(17) and `tests/unit/models/favorite-crash-scenarios.test.ts` (9). The flow test is a
hand-written re-enactment, not an import: its own comment says it simulates "the EXACT flow from
playFavoriteTrack" and it declares a local `FavoriteTrack` type (`:14-23`). So "start a track
from a persisted reference" has a strong model-level precedent to copy, and nothing exercises the
deck-side start sequence (`beginQueue` → `claimAudio`) outside E2E.

## Q41

Eight tests in `test.describe('Music deck playback (player module)')`, `:173-587` (research/3
said nine — `CONFLICT`, the block holds 8 `test(` calls at `:174`, `:204`, `:226`, `:264`, `:303`,
`:379`, `:466`, `:514`). Sub-tab wiring is pinned by `:271` (select B before loading B's
library), `:303-377` (A/B round trip keeps each deck's title and file: tabs at `:333`, `:347`,
`:351`, `:357`, `:364`; MiniPlayer Next re-pointed at the visible deck at `:355` and `:362`; on
Podcasts the MiniPlayer shows Deck A while both play at `:369-372`), `:421-455`
(stop-the-displayed-deck, both directions) and `:569`/`:576` (the radio survives a Deck B
sub-tab switch); `smoke.test.ts:91-92` pins the YouTube sub-tab. A deck is driven by a hidden `input[type="file"][multiple]` via
`waitForEvent('filechooser')` (`:35-44`, `:161-171`; deck B's is the third input), rows by name,
assertions through the MiniPlayer (`:46-51`); store state is seeded only with
`page.addInitScript` and only the `music-settings` key with `{ isRepeat: true }` (`:233-235`,
`:319-321`, `:396-398`, `:481-483`, `:531-533`). Two inherited constraints: `page.locator('audio')`
is asserted at count 2 (`:194`, `:292`), and the region/`h2` helpers (`:53-56`, `:64-76`) make a
second visible deck region or a reused aria-label ambiguous for `expectDeckShows` (`:150`).

## Q42

No test covers `persisted()` directly: there is no `persisted` test file, no test imports
`$lib/persisted.svelte`, and the only importer in the repo is
`src/lib/stores/settings.svelte.ts:1`. The nearest coverage is end-to-end through `podcastData`
in `tests/unit/models/podcast-persist.test.ts` — a write and its `nextId` (`:13-40`), an older
payload merged on boot (`:42-58`), the `trim` bound on the stored blob (`:60-100`) and survival
of one `QuotaExceededError` (`:102-118`). So the generic contract is covered only incidentally:
storage key and merge-over-defaults (`persisted.svelte.ts:24-34`), microtask-coalesced flush
(`:69-79`), the `$effect.root` top-level-key tracking (`:81-88`) and the four lifecycle
listeners (`:99-106`) have no direct test, and neither shallow key tracking nor flush timing is
asserted anywhere.

## Unresolved

- Whether a deck's player can be commanded from outside at all under the current interface:
  settled as "no" for direct calls, but whether the engine's scalar slots can carry a second
  owner is design, not code — settling it needs the Design round (`mediaEngine.svelte.ts:320-329`).
- Whether `musicSelectionLoopActive` can stay global while Deck B loops one track: the two
  mechanisms are exclusive in `ended` (`player.svelte.ts:483`), and no code today expresses a
  per-deck owner; settled by a decision, not a read.
- Whether `isRepeat` can move owner without breaking YouTube repeat-one
  (`YoutubePanel.svelte:392`) and the Settings reset (`SettingsView.svelte:423`) — needs a design
  decision plus a test.
- Where A's position is written: no store accepts one today (`mp3TrackPositions` is wiped and
  unread, `settings.svelte.ts:143-149`; `lastTrackTimestamp` is force-zeroed,
  `Mp3PlayerView.svelte:553-557`), and the write cost is the whole `music-settings` blob per flush
  (`persisted.svelte.ts:47-48`). Settling it needs either a new store or a throttle decision, plus
  a measurement of the real blob on a filled favourites list.
- Whether `ActiveView` gains `'music:pairs'` or the derivation changes shape: both compile-legal,
  neither tested — no existing test feeds an unknown view to `displayedSource`
  (`tests/unit/stores/mediaEngine.test.ts:145-200`).
- Precedence when both a non-deck sub-tab flag and another are open: undefined in code, since only
  `youtubePanel.open` exists (`+page.svelte:53-55`).
- The MiniPlayer's transport on a tab where `displayedSource` is `null`: the slots keep the last
  claimer and no production code clears them; whether that is acceptable is a design question
  (Q27, `mediaEngine.svelte.ts:320-329`).
- The localStorage ceiling has no documented number (`persisted.svelte.ts:14-24`); settling it
  needs a measured WebView quota, not more reading.
- Whether the Android plugin re-issues a pending Drive token on demand, which decides the worst
  case of the one-shot consume race (`google-drive.ts:247-263`); settling it needs the Android
  plugin source, not read here.
- How a pairing start orders the two decks given that Deck A's claim stops other sources but not
  Deck B (`mediaEngine.svelte.ts:43-51`) — readable as a constraint, but the ordering itself is
  design.
- Whether a pairs list should prune dead references, unlike favourites (Q23, Q31); settling it
  needs a product decision plus the E2E seeding limit that a `web` variant is unserialisable
  (`models/music.ts:15`).
- The shape of the seeded pairing payload cannot be checked against code because no pairing store
  exists yet; what is settled is only the mechanism (`page.addInitScript`, Q41) and the
  serialisability limit (`models/music.ts:15`).
