# A/B pairings — Questions (Q stage)

Scope: what the code does today. Not what to build. Every question must be
answerable with `file:line` evidence.

Settled already (ticket.md, do not re-open): P1 pair contents, P2 unlimited
auto-named newest-first list, P3 A position tracks live playback and is written
on pause and periodically, P4 tapping starts both decks and stays on the tab.

Three of these are blocking: **the command channel to both decks (Q1–Q7), the
loop mechanism (Q8–Q12), the position write path (Q13–Q18)**. The design cannot
be settled without all three answered.

---

## A. Deck ownership and control

- **Q1.** Each deck is a separate `Mp3PlayerView` with a private `createPlayer`
  instance. What is the complete public surface of a `Player` object, and which
  of those methods can be called from outside the owning view today?
  *Look:* `src/lib/audio/player.svelte.ts:99-124` (interface), `:548-667`
  (implementation), `src/lib/components/views/Mp3PlayerView.svelte:103`
  (props), `:349-366` (the instance).

- **Q2.** Is a deck's `player` instance reachable from anywhere outside its own
  component scope — a module-level export, a context, a registry, or a store?
  *Look:* `Mp3PlayerView.svelte:349` (local `const player`), and grep the whole
  of `src/lib` for any export of a `Player`.

- **Q3.** What command channels into a deck already exist? Specifically, what is
  `registerMusicPlayerView`/`requestMusicPlayerView` and how does the
  both-decks-register, request-applies-to-all pattern behave?
  *Look:* `src/lib/stores/musicView.svelte.ts:10-30`,
  `Mp3PlayerView.svelte:571-577` (registration), `MiniPlayer` (caller),
  `Mp3PlayerView.svelte:92` (import).

- **Q4.** What is `registerAudioSource`/`claimAudio`'s registry, what exactly does
  a registered stop callback do to a deck, and how are the ids named?
  *Look:* `src/lib/stores/mediaEngine.svelte.ts:37-57`,
  `Mp3PlayerView.svelte:559-568`.

- **Q5.** Which handlers does a deck claim on the engine, under what condition,
  and can two decks hold them at once? Trace `claimMusicControls` and its gate.
  *Look:* `Mp3PlayerView.svelte:592-608` (`claimMusicControls`), `:616`, `:668`,
  `:672`, `:731-739` (the gates); `mediaEngine.svelte.ts:179-180`
  (`setPlaybackHandlers`/`setSkipHandlers` declarations), `:210-224`
  (`displayedSource`).

- **Q6.** What does the MiniPlayer actually call to drive playback, and does it
  ever address a non-visible deck? What happens to its controls when both decks
  play?
  *Look:* `MiniPlayer.svelte:30-90` (display resolution), `:176-196`
  (`seekTo`/`togglePlayback`/skips), `:219-222` (deck A speed only?).

- **Q7.** How does the favourites path start playback on a deck it does not own —
  what is `startPlayback` in the view's injected `FavoriteTracksOptions`, and
  what state does it set before audio starts?
  *Look:* `src/lib/favorites/favoriteTracks.ts:96-111` (the interface it
  expects), `Mp3PlayerView.svelte:1082-1107` (the implementation),
  `:1073-1080` (`beginQueue`).

## B. Looping on deck B

- **Q8.** Where does repeat/loop live today: which fields are global to both
  decks and which are per-deck? Enumerate every loop-ish field and flag.
  *Look:* `src/lib/stores/settings.svelte.ts:38-42` (`isRepeat`, `isShuffle`),
  `mediaEngine.svelte.ts:122-123` (`musicSelectionLoopActive`,
  `musicHasSelectedTracks`), `player.svelte.ts:66-68`, `:93-98`
  (`selectionLoop` option, `isSelectionLoop` getter).

- **Q9.** What exactly makes a deck repeat one track today, end to end? Which
  branch reads `isRepeat`, what does it do to the element, and does it consult
  the queue length?
  *Look:* `player.svelte.ts:479-489` (`ended` listener),
  `:347-356` (`nextIndex`), `src/lib/models/music.ts:258-305`
  (`getNextTrackIndex`, incl. `trackCount === 1`), `tests/unit/models/getNextTrackIndex.test.ts:42-60`.

- **Q10.** What is the "selection loop" path, what does it loop over, and what
  does the view do when it is toggled off or the selection empties?
  *Look:* `Mp3PlayerView.svelte:884-927` (`toggleBrowseFileSelection`,
  `preloadLoopSelection`, `clearBrowseSelection`), `:1339-1395`
  (`resumePlayback`), `MiniPlayer.svelte:237-246`.

- **Q11.** Both the repeat-one flag and the selection-loop flag are global, not
  per deck. What happens today if Deck A needs repeat-one while Deck B needs
  single-track wrap — which existing state would have to change owner, and which
  consumers read those fields?
  *Look:* every `isRepeat` reader (`player.svelte.ts:51, 351, 483`;
  `YoutubePanel.svelte:392`; `SettingsView.svelte:423`) and every
  `musicSelectionLoopActive` reader/writer
  (`Mp3PlayerView.svelte:122, 242, 363, 585-590, 894-907, 1077, 1372-1395`).

- **Q12.** What does the player do at the end of a single-track queue today, and
  what does `advanceTrack` do on the same-track loop branch (including whether it
  keeps `isPlaying` and the element's `currentTime`)?
  *Look:* `player.svelte.ts:397-460` (advance + same-track loop),
  `:404-425`.

## C. Position

- **Q13.** Where does a deck's live position live, who writes it, and at what
  rate? Trace from the element's `timeupdate` to `mediaEngine.deckACurrentTime`
  / `deckBCurrentTime`.
  *Look:* `player.svelte.ts:462-471` (throttled `state.currentTime`),
  `Mp3PlayerView.svelte:692-712` (engine push), `mediaEngine.svelte.ts:135-141`
  (the fields), `MiniPlayer.svelte:68-75` (the reader).

- **Q14.** Can a position be read for a deck that is not the displayed one, and
  what does `mediaEngine.clear()` do to both decks' positions?
  *Look:* `mediaEngine.svelte.ts:338-360`.

- **Q15.** What is `musicSettings.lastTrackKey`/`lastTrackIndex`/
  `lastTrackTimestamp` supposed to hold, who writes each, and why is
  `lastTrackTimestamp` forced to 0 by an effect?
  *Look:* `settings.svelte.ts:44-47`, `player.svelte.ts:217-221`,
  `:326, 337, 413, 425, 479, 482, 495, 649`,
  `Mp3PlayerView.svelte:552-557`, `:120-150`.

- **Q16.** What is `mp3TrackPositions` and why is it wiped on module load? Is any
  code still reading it?
  *Look:* `settings.svelte.ts:139-150`, and grep `mp3TrackPositions` across
  `src/` and `tests/`.

- **Q17.** What does `player.stop()` do to `state.currentTime` and to the loaded
  element, and therefore what is left of a deck's position after another source
  claims audio? What does `resume()` restart from in that state?
  *Look:* `player.svelte.ts:231-238` (`haltPlayback`), `:588-591` (`stop`),
  `:590-600` (`resume`), `Mp3PlayerView.svelte:559-568` (the stop callback).

- **Q18.** What collides with writing a saved position from live playback: how
  often is `state.currentTime` written, what does `persisted()` do per write, and
  what else in the app writes to localStorage on a timer or on `timeupdate`?
  *Look:* `player.svelte.ts:126` (`THROTTLE_MS`), `:462-471`;
  `src/lib/persisted.svelte.ts:44-92` (flush, microtask coalescing, `$effect`
  dependency on top-level keys only); `mediaEngine.svelte.ts` tick/watchdog
  effects (`:689+` `initMediaEngine`), `docs/state/sleep-timer.md`.

## D. Persistence

- **Q19.** How does `persisted()` work exactly: what it reads on init, which
  fields it tracks for reactivity (`Object.keys(defaults)`), how it merges stored
  data over defaults, and what happens on a quota error?
  *Look:* `src/lib/persisted.svelte.ts:12-116`, especially `:24-36` (merge
  over defaults) and `:80-90` (shallow top-level key tracking).

- **Q20.** Does an in-place mutation of an array or object inside a `persisted()`
  store schedule a flush, or must the top-level key be reassigned? What evidence
  exists in tests?
  *Look:* `persisted.svelte.ts:80-90`; `musicSettings.favoriteTracks` usage
  (`favoriteTracks.ts:127-260`), `tests/unit/favorites/favoriteTracks.test.ts`,
  `tests/unit/models/podcast-persist.test.ts`.

- **Q21.** What are all the existing localStorage keys and roughly what does each
  payload weigh? What is the known budget ceiling and where is it documented?
  *Look:* `settings.svelte.ts` (all eight `persisted()` calls), plus
  `src/lib/stores/runtimeDiagnostics.svelte.ts:60-80`,
  `src/lib/stores/googleDriveSession.svelte.ts:23-40`,
  `src/lib/drive/folderPicker.svelte.ts:32-60`,
  `src/lib/youtube/saveMarker.ts:6-41`; `persisted.svelte.ts:14-24` (the quota
  comment).

- **Q22.** How does `musicSettings` handle its own migration and shape drift, and
  what is the precedent for a size-bounded store (`trim`)?
  *Look:* `settings.svelte.ts:60-66` (legacy `playbackSpeed` migration),
  `:120-141` (`podcastData` `trim`, `MAX_EPISODES_PER_PODCAST`),
  `persisted.svelte.ts:11-26`.

- **Q23.** Is there a precedent for a persisted list of user items — how is it
  shaped, bounded, and kept from resurrecting dead references?
  *Look:* `musicSettings.favoriteFolders` / `favoriteTracks`
  (`settings.svelte.ts:55-57`), `FavoriteTrack` union
  (`src/lib/models/music.ts:42-60`), `favoriteTracks.ts:127-160`.

## E. The sub-tab UI

- **Q24.** How is the visible music sub-tab derived today, and what breaks in the
  derivation if a third, non-deck tab exists? What is `activeMusicDeck`'s type
  and who else writes it?
  *Look:* `src/routes/+page.svelte:48-66`, `mediaEngine.svelte.ts:124` and every
  writer of `activeMusicDeck` (grep across `src/` and `tests/`).

- **Q25.** What does a component mounted in the music panel receive, and what
  does `class:hidden` do to it — is it unmounted, does it keep effects, does it
  keep audio?
  *Look:* `+page.svelte:196-250` (the always-mounted comment and both wrappers),
  `:231-236` (`class:hidden` per deck), `:242-249` (`YoutubePanel` self-gating
  comment).

- **Q26.** What does the shell publish about the visible view, and what consumes
  `mediaEngine.activeView`? What would a `pairs` sub-tab have to set it to, and
  which type/consumer would reject an unknown value?
  *Look:* `+page.svelte:68-71`; `mediaEngine.svelte.ts:56-70` (`ActiveView`
  union), `:210-230` (`displayedSource`);
  `tests/unit/stores/mediaEngine.test.ts:145-185`.

- **Q27.** Does the deck's own transport and MediaSession integration depend on
  its sub-tab being visible, and what happens to the MiniPlayer's transport while
  a non-deck tab is showing?
  *Look:* `Mp3PlayerView.svelte:616-700` and `:731-739` (`isMusicView` gates),
  `:668` (`if (isMusicView) claimMusicControls()`),
  `MiniPlayer.svelte:160-196`.

- **Q28.** What is the tab bar's accessibility/shape contract (roles, labels) and
  how do the E2E tests address the tabs by name?
  *Look:* `+page.svelte:208-228`; `tests/e2e/music-player.test.ts:264-270`
  (`getByRole('tab', { name: 'B', exact: true })`); `tests/e2e/helpers.ts:26-49`.

## F. Identity of a track

- **Q29.** How is a `StoredAudioFile` keyed across sources, and what does the key
  deliberately leave out (is a native file's key path-only, so two libraries
  could collide)?
  *Look:* `src/lib/models/music.ts:83-105` (the union), `:135-143`
  (`getStoredFileKey`/`getTrackKey`).

- **Q30.** For each source, what is needed to turn a saved reference back into
  playable audio after a restart, and what happens when the file is gone?
  *Look:* `src/lib/audio/fileResolver.ts:54-90`;
  `Mp3PlayerView.svelte:1014-1060` (`resolveTrackUrl`),
  `src/lib/browse/libraryCache.ts:156-185` (`restoreStoredFilesFromCache`),
  `src/lib/drive/driveLibrary.ts` (`materializeStoredFile`).

- **Q31.** How does the favourites feature already solve this exact problem (a
  persisted reference to a file that may not be present), per source, including
  its `null` results and its "not available" toasts?
  *Look:* `src/lib/favorites/favoriteTracks.ts:1-58` (the preserved-behaviour
  notes), `:113-260` (`resolveFavoriteTrackFile`, `getResolvedFavoriteTrackFiles`),
  `:262-280` (`playFavoriteTrack`); `tests/unit/favorites/favoriteTracks.test.ts`
  and `tests/unit/models/play-favorite-flow.test.ts`.

- **Q32.** A web-sourced file carries a live `File` object that cannot be
  serialised. What does the library cache keep in IndexedDB for web files, and is
  a web deck's library restored on mount without a user gesture?
  *Look:* `models/music.ts:19` (`source: 'web'` carries `file: File`),
  `:62-96` (`CachedWebLibraryFile`), `libraryCache.ts`,
  `Mp3PlayerView.svelte:1521-1560` (mount restore).

- **Q33.** Both decks share `musicSettings.librarySource`,
  `lastFolderName`, `nativeTreeUri` and `driveFolderId`. What does that mean for
  a pairing whose A and B tracks come from different sources, and which deck's
  load overwrites the shared fields?
  *Look:* `settings.svelte.ts:40-44`, `Mp3PlayerView.svelte:1000, 1290-1300,
  1527-1600`, `src/lib/drive/driveLibrary.ts:148, 452`.

- **Q34.** Each deck holds its own Drive session (`createDriveSession`). What
  does that mean for starting two Drive-sourced tracks at once, and who owns the
  access token for a pairing start?
  *Look:* `Mp3PlayerView.svelte:185`, `src/lib/drive/driveSession.svelte.ts`
  (`ensureDriveAccessToken`), `src/lib/stores/googleDriveSession.svelte.ts:20-45`.

## G. Audio exclusivity

- **Q35.** What happens to both decks when podcast, radio or YouTube claims
  audio, and what is the one documented exception?
  *Look:* `mediaEngine.svelte.ts:21-57`, callers at
  `src/lib/podcast/podcastPlayer.ts:184, 397, 455`,
  `src/lib/components/views/RadioView.svelte:112`,
  `src/lib/components/ui/YoutubePanel.svelte:251, 455`,
  `mediaEngine.svelte.ts:366-372` (`playStream`).

- **Q36.** In what order must state be set relative to `claimAudio` so that a
  start does not immediately stop itself, and what does the view do about it?
  *Look:* `Mp3PlayerView.svelte:1097-1104` and `:1358-1366` (ordering comments),
  `mediaEngine.svelte.ts:41-57`, `:81-94` (`_userWantsPlayback` /
  `markUserPaused`), `:200-206` (`isPlaying` getter contract).

- **Q37.** Which single global knob decides whether the sleep timer, the
  lock-screen controls and the MiniPlayer pause both decks or only the visible
  one?
  *Look:* `src/lib/stores/sleepTimer.svelte.ts:25-40`,
  `MiniPlayer.svelte:181-196`, `Mp3PlayerView.svelte:1339-1400`.

## H. Tests

- **Q38.** Which unit tests exercise the player module, and which of them would
  constrain a new "start at position" or "loop one track" path?
  *Look:* `tests/unit/models/player.test.ts` (47 cases), `:0` header for the fake
  element/resolver seams; `tests/unit/models/getNextTrackIndex.test.ts`.

- **Q39.** Which tests cover `mediaEngine`'s exclusivity and `displayedSource`?
  *Look:* `tests/unit/stores/mediaEngine.test.ts` (18 cases),
  `tests/unit/stores/mediaEngineBackgroundResume.test.ts`,
  `tests/unit/stores/mediaEngineNativeTick.test.ts`.

- **Q40.** Which tests cover the favourites playback path (the closest existing
  analogue to "start this track from a saved reference")?
  *Look:* `tests/unit/favorites/favoriteTracks.test.ts`,
  `tests/unit/models/play-favorite-flow.test.ts`,
  `tests/unit/models/favorite-crash-scenarios.test.ts`.

- **Q41.** Which E2E tests pin the current sub-tab wiring and both-decks
  behaviours, and how do they drive a deck (clicks, file choosers, localStorage
  seeding)?
  *Look:* `tests/e2e/music-player.test.ts:173-560` (nine deck tests, incl.
  repeat-one at `:226`, deck B at `:264`, exclusivity at `:466`),
  `tests/e2e/helpers.ts:12-49`.

- **Q42.** Is there any test for `persisted()` itself — storage key, merge, flush
  timing, quota failure?
  *Look:* `tests/unit/` has no `persisted` test today; the closest are
  `tests/unit/models/podcast-persist.test.ts:13-140` and
  `tests/unit/models/favorite-crash-scenarios.test.ts`. Confirm by grepping
  `persisted|localStorage` across `tests/unit`.

---

## Known cross-cutting uncertainties

- Whether deck A's position can be written without a new store write path, given
  `stop()` zeroes `state.currentTime` and `lastTrackTimestamp` is deliberately
  forced to 0 (`Mp3PlayerView.svelte:552-557`).
- Whether a `pairs` value fits `ActiveView`/`displayedSource` at all, or whether
  the derivation in `+page.svelte:53-55` must change shape.
- Whether the per-deck loop requirement can be met without re-owning
  `isRepeat`/`musicSelectionLoopActive`, which are read by the YouTube panel and
  Settings too.
- `docs/state/audio-playback-lifecycle.md` is declared in sync with
  `mediaEngine.svelte.ts` (`:1`); Research should read it for the lifecycle
  contract before proposing any new start sequence.
