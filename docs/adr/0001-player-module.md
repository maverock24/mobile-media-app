# ADR-0001: Extract the music playback core into a deep `player` module

- Status: Accepted
- Date: 2026-08-22
- Deciders: maintainer, via architecture review

## Context

`Mp3PlayerView.svelte` (≈4,175 lines) mixes the music playback core — the queue,
the audio element, advance/preload/retry/loop behaviour, URL resolution — with
file scanning, Google Drive auth, favorites, and folder pickers. The view is
mounted twice (Deck A and Deck B), so every playback bug doubles and is only
testable via Playwright e2e. Pure helpers (`getNextTrackIndex`, `sortFiles`)
were already extracted to `src/lib/models/music.ts` "for testability", but the
calls that actually harbour bugs (`safePlay`, `advanceTrack`, `preloadNextTrack`,
`startAudioAt`) stayed in the view — no locality. The commit history shows the
same playback defects (safePlay retries, advance auto-skip, audio exclusivity,
same-track loop) resurfacing repeatedly.

## Decision

Extract the playback core behind a deep module at `src/lib/audio/player.svelte.ts`,
factory `createPlayer(...)`, per-deck instance, with a small interface:

```ts
type Player = {
  state: PlayerState;                 // reactive $state
  play(tracks: Track[], startIndex?: number): Promise<void>;
  pause(): void; resume(): void;
  next(): void; prev(): void; seek(toSec: number): void;
  destroy(): void;
};
```

- The module owns the `HTMLAudioElement` and the advance/preload/retry/loop
  behaviour.
- The view binds to the reactive `state`; scanning, Drive auth, favorites, and
  folder pickers stay in the view.
- URL resolution is injected as a seam:
  `resolveUrl(track, interactiveAuth?) => Promise<string|null>`; the view
  supplies the real adapter (`materializeStoredFile`), tests supply a fake.
- The module receives the reactive `musicSettings` store (volume, speed,
  repeat/shuffle, equalizer).
- Each deck is one `player` instance. `mediaEngine` (MediaSession, deck state,
  audio exclusivity via `claimAudio`) remains the view's concern; the module is
  agnostic to it.
- Migration is incremental and behaviour-preserving: the module is added with
  the real view as its first caller, existing e2e plus new unit tests guard the
  change, then the in-view copies are deleted.

## Consequences

- Locality: the safePlay/advanceTrack/loop defect cluster concentrates in one
  module and is fixed once.
- Leverage: one interface serves both decks.
- Testability: the module is exercised through its interface with a fake audio
  element and fake URL resolver — no browser required.
- The `player` concept is added to `CONTEXT.md`; a deck is a `player` instance
  plus the view chrome bound to it.
