# Mobile Media App — Domain Context

A SvelteKit + Capacitor media hub: local MP3 playback, podcasts, radio, weather,
and Google Drive music libraries. The live code in `src/` is authoritative.

## Core concepts

- **deck** — one of two independent music players (Deck A, Deck B) that can play
  simultaneously. Each deck owns its own queue, audio element, and playback
  speed; they share the global `mediaEngine` for MediaSession, the MiniPlayer,
  and audio exclusivity (`claimAudio`).
- **player** — the playback core behind a deck: the queue, the audio element,
  and the advance/preload/retry/loop behaviour. Planned as a deep module
  (`src/lib/audio/player.svelte.ts`) with a small interface; today it is buried inside
  `Mp3PlayerView.svelte`. A deck is a player instance + the view chrome that
  binds to it.
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
  and the others are persisted stores.
- **Drive config sync** — the module that uploads/downloads the persisted stores
  to Google Drive appdata and resolves conflicts (last-write-wins by timestamp).

## Navigation

- Architecture map and conventions: `AGENTS.md`.
- `src/lib/audio/` — audio modules (`equalizer.ts`, `fileResolver.ts`, planned
  `player.ts`).
- `src/lib/stores/` — rune stores (`mediaEngine`, `settings`, `library`,
  `driveConfigSync`, …).
- `src/lib/components/views/` — feature screens.
