# Mobile Media App — Domain Context

A SvelteKit + Capacitor media hub: local MP3 playback, podcasts, radio, weather,
and Google Drive music libraries. The live code in `src/` is authoritative.

## Core concepts

- **deck** — one of two independent music players (Deck A, Deck B) that can play
  simultaneously. Each deck owns its own queue, audio element, and playback
  speed; they share the global `mediaEngine` for MediaSession, the MiniPlayer,
  and audio exclusivity (`claimAudio`).
- **player** — the playback core behind a deck: the queue, the audio element,
  and the advance/preload/retry/loop behaviour. It is the deep module decided in
  ADR-0001, `src/lib/audio/player.svelte.ts` (`createPlayer`, tested in
  `tests/unit/models/player.test.ts`). `Mp3PlayerView` builds one per deck and
  hands it the file list (scan, Drive, favourites, folder pickers), the URL
  adapter, the per-deck volume/mute/speed controls and the equalizer hook. A deck
  is a player instance + the view chrome that binds to it.
- **mediaEngine** — the shared playback-core store: MediaSession glue, radio
  stream audio, per-deck state, audio exclusivity, wakelock, background resume.
- **track / episode** — a playable item in a music queue (track) or a podcast
  (episode).
- **selection loop** — a loop over tracks the user explicitly selected in the
  browse view (as opposed to a full-folder queue). Selection loops wrap to the
  start; `isRepeat` is repeat-one (a single track repeats itself) and never
  wraps the list.
- **source** — where a track comes from: `web` (File System Access), `native`
  (Capacitor/Android), or `drive` (Google Drive). Resolving a source to a
  playable URL is an adapter concern the player must not own.
- **persisted store** — a localStorage-backed Svelte-5 rune store
  (`src/lib/persisted.svelte.ts`). `musicSettings`, `podcastData`, `appSettings`,
  and the others are persisted stores. Podcasts/settings live only on-device
  (the Google Drive settings/podcast sync was removed).

## View composition

`Mp3PlayerView` composes nine per-deck modules, one set per deck rather than a
module singleton, because two decks mount at once. Seven are factories:
`createDriveSession` (`src/lib/drive/driveSession.svelte.ts`),
`createFolderPicker` (`src/lib/drive/folderPicker.svelte.ts`),
`createDriveLibrary` (`src/lib/drive/driveLibrary.ts`),
`createDeviceLibrary` (`src/lib/device/deviceLibrary.svelte.ts`),
`createBrowseNavigation` (`src/lib/browse/browseNavigation.svelte.ts`),
`createFileOps` (`src/lib/files/fileOps.ts`) and `createFavoriteTracks`
(`src/lib/favorites/favoriteTracks.ts`). The other two are pure modules the
view and the factories call directly, `src/lib/browse/libraryCache.ts` and
`src/lib/browse/folderScan.ts`.

State shared by more than one module stays in the view and is injected through
accessors: `allFiles`, `browsePath`, `showQueue`, `pendingFileOp` and the
transfer fields (`transferFile`, `transferDirection`, `isTransferring`,
`transferProgress`, `transferPhase`). Each factory owns only the state its own
functions drive. `createFavoriteTracks` reads `allFiles` and the live queue
(`player.state.tracks`) and owns `isChangingTrack` through a get/set accessor;
the shared `musicSettings.favoriteTracks` list is passed by reference.

Two effects stay in the view for their timing. The mount effect wraps its restore
preamble in `untrack()` so reads such as `driveSession.ensureDriveAccessToken`
are not dependencies; without it the effect re-runs while hydration writes those
signals and fires concurrent `finishDriveLoad` calls. The browse reload effect
depends on `browsePath`, `driveSearch`, `browseVersion` and
`musicSettings.librarySource`.

## File management (move / copy / delete)

A browse-row action strip (swipe-left reveal) provides Download, Move, Copy, and
Delete. Only native (SAF) local files support move/copy/delete; Drive files
support download only. Local deletes are permanent; copy uses the local
destination picker. Drive file management was removed (ADR-0002, revised).

## Navigation

- Architecture map and conventions: `AGENTS.md`.
- `src/lib/audio/` — audio modules (`equalizer.ts`, `fileResolver.ts`,
  `player.svelte.ts`).
- `src/lib/browse/` — pure library cache and folder scan, plus browse navigation.
- `src/lib/drive/` — the per-deck Drive session, folder picker and library.
- `src/lib/device/` — the per-deck device library.
- `src/lib/files/` — the per-deck file operations.
- `src/lib/favorites/` — the per-deck track favourites and the resolve-and-play
  machine behind them.
- `src/lib/podcast/` — episode display, iTunes search, resume progress, the
  library flows and the podcast transport. Five of these came out of
  `PodcastView.svelte` in the last phase; `rss.ts` and `refresh.ts` predate it.
- `src/lib/stores/` — rune stores (`mediaEngine`, `settings`, `library`, …).
- `src/lib/components/views/` — feature screens.
