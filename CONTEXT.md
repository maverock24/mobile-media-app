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

## File management (move / copy / delete)

A browse-row action strip (swipe-left reveal) provides Download, Move, Copy, and
Delete. Only native (SAF) local files support move/copy/delete; Drive files
support download only. Local deletes are permanent; copy uses the local
destination picker. Drive file management was removed (ADR-0002, revised).

## Navigation

- Architecture map and conventions: `AGENTS.md`.
- `src/lib/audio/` — audio modules (`equalizer.ts`, `fileResolver.ts`,
  `player.svelte.ts`).
- `src/lib/stores/` — rune stores (`mediaEngine`, `settings`, `library`, …).
- `src/lib/components/views/` — feature screens.
