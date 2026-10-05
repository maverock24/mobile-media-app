# Refactoring plan

- Status: active, PR 1 open
- Base: `main` at `8dc7495`
- Branch per PR: `refactor/dead-code`, `refactor/adr-0001-player`, `refactor/mp3-drive-domain`, ...
- Scope: `src/` only. `android/` is out of scope.
- Rule: every PR is behaviour-preserving. Store APIs stay source-compatible.
- Gate: `pnpm check && pnpm test` on every commit, `pnpm test:e2e` before merge,
  and Playwright is mandatory on the player-migration PR.

## Goal

Shrink the codebase by removing dead code and by reducing the complexity
concentrated in `src/lib/components/views/Mp3PlayerView.svelte`. This plan does
not chase playback defects; it removes code and moves it to where it can be
tested.

## Where the code stands

`src/` holds 68 TypeScript and Svelte files, 16,599 lines.

| file | lines | parsed functions | analyzer complexity |
| --- | --- | --- | --- |
| `src/lib/components/views/Mp3PlayerView.svelte` | 4,578 | 371 | 751 |
| `src/lib/components/views/PodcastView.svelte` | 1,400 | 95 | 242 |
| `src/lib/components/views/SettingsView.svelte` | 1,291 | 31 | 71 |
| `src/lib/components/ui/MiniPlayer.svelte` | 461 | 20 | 53 |
| `src/lib/components/views/RadioView.svelte` | 413 | 20 | 37 |
| `src/lib/stores/mediaEngine.svelte.ts` | 832 | | |
| `src/lib/google-drive.ts` | 703 | | |
| `src/lib/audio/player.svelte.ts` | 418 | | |

Function counts and complexity scores come from the `codedeck-analysis.json`
snapshot of 2026-09-06, so treat the scores as a rough ordering, not as a
measurement. Line counts are from `HEAD`.

Playback helpers are copied across files, which is the reason a single player
fix costs four edits:

| function | copies |
| --- | --- |
| `safePlay` | `src/lib/audio/player.svelte.ts:115`, `src/lib/components/views/Mp3PlayerView.svelte:853`, `src/lib/components/views/PodcastView.svelte:144`, `src/lib/components/ui/YoutubePanel.svelte:119` |
| `togglePlay` | `src/lib/components/views/PodcastView.svelte:908`, `src/lib/components/views/RadioView.svelte:93`, `src/lib/components/ui/YoutubePanel.svelte:429`, plus a dead copy at `src/lib/components/views/Mp3PlayerView.svelte:3127` |
| `pausePlayback` | `src/lib/components/views/Mp3PlayerView.svelte:3139`, `src/lib/components/views/PodcastView.svelte:916`, `src/lib/components/views/RadioView.svelte:101` |

## The programme

### PR 1: verified dead code (this branch)

Fifteen functions with no reference anywhere in `src/`, `tests/`, `scripts/` or
the root config files. The proof method is at the bottom of this file.

| file:line | function | note |
| --- | --- | --- |
| `src/lib/components/AuroraBackground.svelte:91` | `getMoonAlpha` | superseded by the inline moon math below it |
| `src/lib/components/ui/MiniPlayer.svelte:153` | `handleSeekInput` | `PlayerControls` has the live one |
| `src/lib/components/views/Mp3PlayerView.svelte:1664` | `isCurrentFolderFavorited` | feature-shaped, see below |
| `src/lib/components/views/Mp3PlayerView.svelte:1670` | `toggleCurrentFolderFavorite` | feature-shaped |
| `src/lib/components/views/Mp3PlayerView.svelte:1851` | `cancelDriveLoad` | feature-shaped |
| `src/lib/components/views/Mp3PlayerView.svelte:1993` | `signOutGoogleDrive` | feature-shaped |
| `src/lib/components/views/Mp3PlayerView.svelte:2847` | `navigateLocalPickerUp` | feature-shaped |
| `src/lib/components/views/Mp3PlayerView.svelte:2947` | `navigateDrivePickerInto` | feature-shaped |
| `src/lib/components/views/Mp3PlayerView.svelte:2952` | `navigateDrivePickerUp` | feature-shaped |
| `src/lib/components/views/Mp3PlayerView.svelte:3127` | `togglePlay` | dead copy; the live handlers are `resumePlayback` and the markup |
| `src/lib/components/views/Mp3PlayerView.svelte:3228` | `selectTrack` | dead copy |
| `src/lib/components/views/Mp3PlayerView.svelte:3432` | `handleSeekInput` | dead copy |
| `src/lib/components/views/Mp3PlayerView.svelte:3436` | `handleSeekCommit` | dead copy |
| `src/lib/components/views/PodcastView.svelte:967` | `handleSeek` | dead copy |
| `src/lib/components/views/RadioView.svelte:93` | `togglePlay` | dead copy; `pausePlayback`/`resumePlayback` are the live pair |

"Feature-shaped" means the function is the only remaining implementation of
something a user could once do: signing out of Google Drive, cancelling a Drive
load, walking up a folder picker, favouriting a folder. Nothing calls them, so
removing them removes the capability, not just the code. Git history keeps them;
if the capability is wanted back, restore it deliberately rather than leaving
dead copies around.

Left in place by choice, because they are exported helpers rather than local
leftovers: `src/lib/utils/storage.ts:22 setJSON` and `:31 removeJSON`.

### PR 2: wire the ADR-0001 player module

ADR-0001 (`docs/adr/0001-player-module.md`, accepted 2026-08-22) decided this
already. The module landed in commit `af3f6e5` and is complete with tests, but
nothing in `src/` calls it: the only caller of `createPlayer`
(`src/lib/audio/player.svelte.ts:88`) is
`tests/unit/models/player.test.ts:43`. `Mp3PlayerView.svelte` still binds its own
`<audio bind:this={audioEl}>` and keeps its own `safePlay` at line 853.

Work: construct one `createPlayer` instance per deck inside `Mp3PlayerView`,
supply the `resolveUrl` adapter, bind the view to `player.state`, then delete the
in-view playback copies. Scanning, Drive auth, favourites and folder pickers stay
where they are; PR 3 to PR 5 move those separately.

The landmine: the module never calls `claimAudio` (zero hits in
`src/lib/audio/player.svelte.ts`) while `guardrails.md` requires every audio
source to register a stop callback with `mediaEngine`. Deck A and Deck B would
both keep playing. The view must register the module's `pause()` with
`registerAudioSource`, and the migration PR must prove exclusivity with e2e.

### PR 3: Drive and folder-picker domain

About 52 Drive-related functions in the view, against a 703-line
`src/lib/google-drive.ts` and `src/lib/stores/googleDriveSession.svelte.ts`
already in place. Move the orchestration out of the view into those modules.

### PR 4: browse and scan domain

About 30 functions. `src/lib/models/browse.ts` and
`src/lib/native/directory-reader.ts` are the seams.

### PR 5: favourites domain

Six functions, plus the machine that resolves favourite tracks to files.

### After the programme

`PodcastView.svelte` (1,400 lines, complexity 242, its own `safePlay`) is the
next single-file target and needs its own decision about whether the podcast
engine shares `createPlayer`. The three duplicated handlers in
`RadioView.svelte` fold into that pass.

## Known follow-ups

Non-blocking items the three audits of PR 2 left open. Recorded here so they are
not lost; none of them blocks this PR.

- A re-sorting `append()` can put a resolved URL on the wrong index. `ensureUrl`
  writes the URL to the index captured before its `await`, so a file that sorts
  ahead of the resolved track takes that slot and playback follows the wrong
  entry. Same in the pre-migration code, so it is not a migration regression.
- A resolve superseded by a queue replacement keeps its blob attached as
  `cleanup` instead of revoking it immediately: one object URL survives until
  the next `clear()` or `destroy()`, for a track that is no longer queued.
- `mediaEngine` has no `unregisterAudioSource`, so the view's register effect
  has no teardown. Podcast, Radio and YouTube have the same shape; the fix
  belongs in `mediaEngine`, not in one view.
- The deck element is now a detached `new Audio()` with `preload = 'none'`
  instead of an in-DOM `<audio>`. Its behaviour on Android and iOS WebViews is
  unverified without a device, like the rest of the native path.
- `next()` from a loaded, paused deck starts playback and resolves `true`, where
  the audit expected `false`. `advanceTrack` has no `wasPlaying` guard, unlike
  the `loadAndPlayAt` path `prev()` uses, so the audit's premise that a paused
  skip never claims holds for `prev()` only. Either add the guard, so a paused
  skip just loads the src, or correct the documented behaviour. The behaviour
  today is pinned by a test in `tests/unit/models/player.test.ts`.

## Out of scope

- `android/`: `DirectoryReaderPlugin.java` (627 lines, 21 functions) and
  `MediaPlaybackService.java`.
- `SettingsView.svelte` (1,291 lines) and `WeatherView.svelte`.
- Splitting the markup of `Mp3PlayerView.svelte` into child components. This pass
  extracts logic only, so the diff stays reviewable.
- The analyzer's raw dead-code count (114) and its duplicate-name hits. Both are
  mostly noise, as the method below shows.
- `docs/research/` and the repo's own `.agents/`.

## Definition of done

- `Mp3PlayerView.svelte` under 2,500 lines, from 4,578.
- Every function in the PR 1 table gone, none re-added by later PRs.
- ADR-0001 wired, deck exclusivity proven by e2e.
- `guardrails.md` and `CONTEXT.md` describe the code as it then is.
- `pnpm validate` green.

## How the dead-code proof was produced

1. `codedeck-analysis.json` (snapshot 2026-09-06, 173 files) claims 114 unused
   functions. It counts a function as unused when no other file calls it, which
   misses Svelte markup in the same file: `onclick={handleSeekPointerDown}` is a
   call the analyzer does not see. Of 111 claims inside `src/`, 94 appear again
   in their own file and are false positives.
2. Remaining candidates were tested against a word-boundary scan of every
   `src/`, `tests/`, `scripts/`, `static/` and root config file, with the
   generated `codedeck*.json` files excluded so the analysis could not match
   itself.
3. Thirteen functions have zero references anywhere. Four more
   (`MiniPlayer.svelte:153`, `Mp3PlayerView.svelte:3127`, `:3432`,
   `RadioView.svelte:93`) appear exactly once in their own file, at the
   declaration, but share a name with a live function elsewhere, so only the
   per-file check can clear them.
4. Every candidate was read before deletion, and the resulting diff was checked
   with `pnpm check` and `pnpm test`.
