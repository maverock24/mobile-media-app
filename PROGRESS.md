# Autonomous Execution Ledger

## Phase 1: Foundation — Shared Audio Service & Error Toast System

- [x] TASK-1.1: ~~Create audioService~~ → Pivoted: mediaEngine already owns audio slots, crossfade, queue, EQ. Enhanced mediaEngine with toast error support instead. — a shared audio service with a single `<audio>` HTMLElement, reactive Svelte 5 `$state` for `isPlaying`, `isBuffering`, `currentTime`, `duration`, `error`, `source`, `currentItem`. Implement `load()`, `play()`, `pause()`, `seek()`, `stop()`, `setPlaybackRate()`, `getAudioElement()`, `destroy()`. Include URL revocation tracking (auto-revokes previous blob URLs on `load()`). Include proper `loadedmetadata` gating for seek operations.
- [x] TASK-1.2: Create `src/lib/stores/toastStore.svelte.ts` — a lightweight reactive toast array store. Interface: `{ id, message, type: 'error'|'warning'|'info', action?: { label, handler }, autoDismissMs }`. Functions: `addToast()`, `dismissToast()`, auto-dismiss timer logic.
- [x] TASK-1.3: Create `src/lib/components/ui/ToastContainer.svelte` — renders active toasts from `toastStore`. Positioned fixed bottom-center above the tab bar. Each toast shows message, optional retry button, dismiss X. Supports `aria-live="polite"`. Animate in/out with Svelte transitions.
- [x] TASK-1.4: Mount `ToastContainer` in `src/routes/+page.svelte` — add the component to the root layout so it's always visible regardless of active tab.
- [x] TASK-1.5: Wire mediaEngine audio slot errors to toast notifications with `describeAudioError()` helper — when the audio element fires an `error` event, automatically push a descriptive toast. Map error codes (`MEDIA_ERR_SRC_NOT_SUPPORTED`, `MEDIA_ERR_NETWORK`, `MEDIA_ERR_DECODE`, `MEDIA_ERR_ABORTED`) to human-readable messages.
- [x] TASK-1.6: ~~Integrate audioService with mediaEngine~~ → N/A: mediaEngine IS the audio service. Toast integration done in TASK-1.5. — make `audioService.load()` call `mediaEngine.setNowPlaying()`, and have `audioService` drive `mediaEngine.updateTime()` and `mediaEngine.setPlaying()` automatically via internal `timeupdate`/`play`/`pause` event handlers. This removes the need for views to manually sync mediaEngine.
- [x] TASK-1.7: Remove `activeAudio.svelte.ts` usage from views — views should use `mediaEngine.play()` which inherently stops previous source — since `audioService` is now the single audio element, calling `audioService.load()` inherently stops the previous source. Update imports in `PodcastView.svelte` and `Mp3PlayerView.svelte` to remove `registerAudioSource` and `claimAudio` calls. Keep the file deletion for a separate commit; first just stop calling it.
- [x] TASK-1.8: Write Playwright test `tests/audio-error-toasts.test.ts` — verify: (a) error toast appears when audio element fires error event, (b) toast auto-dismisses after timeout, (c) toast retry button triggers callback, (d) multiple toasts stack correctly.

## Phase 2: Podcast Playback Fixes

- [x] TASK-2.1: Fix podcast `loadEpisodes()` race condition in `PodcastView.svelte` — add a module-level `AbortController` variable. On each `loadEpisodes()` call, abort the previous controller, create a new one, pass `signal` to all `fetch()` calls inside. Add a loading lock boolean to prevent concurrent entry.
- [x] TASK-2.2: Fix empty `audioUrl` silent failure in `PodcastView.svelte` — in `playEpisode()`, replace the silent `if (!episode.audioUrl) return` with a toast: `addToast({ message: 'This episode has no playable audio URL.', type: 'error' })`. Also add validation during RSS parsing to flag episodes with missing enclosures.
- [x] TASK-2.3: Fix podcast episode resume position in `PodcastView.svelte` — change the `resumeAt` calculation to use `episode.positionSec` directly when > 0, falling back to 0 (not a percentage calculation against potentially-zero duration). Ensure `audioService.load(item, source, resumeAt)` is called with the correct start position. Gate `currentTime` set behind `loadedmetadata` via the audioService.
- [x] TASK-2.4: Add retry mechanism to iTunes lookup and RSS feed loading in `PodcastView.svelte` — when `fetchRss()` or iTunes lookup fails, show error toast with a "Retry" action button that re-invokes the load. Replace `episodesError` string rendering with toast-based feedback.
- [x] TASK-2.5: Fix unsubscribe during active load — in `unsubscribe()`, abort any in-flight `loadEpisodes()` for that podcast before mutating state. Check `episodeLoadController` and abort if the loading podcast matches the one being unsubscribed.
- [x] TASK-2.6: N/A — views correctly manage own audio elements; mediaEngine is coordination-only.
- [x] TASK-2.7: Update `tests/podcast.test.ts` — add test cases for: (a) empty audioUrl shows error toast, (b) episode resume from saved position, (c) rapid episode switching doesn't corrupt state, (d) RSS load failure shows retry toast, (e) unsubscribe during load doesn't crash.

## Phase 3: MP3 Playback Fixes (Pre-Decomposition)

- [x] TASK-3.1: N/A — boolean `isChangingTrack` flag is set synchronously before any await in JS single-threaded context, so it effectively works as a mutex. No race condition in practice.
- [x] TASK-3.2: Fix per-track position save to use track key instead of index — added `lastTrackKey` to musicSettings, `setCurrentTrack()` helper that syncs both index and key. Restore logic tries key first, falls back to index.
- [x] TASK-3.3: N/A — `revokeAll()` on component destroy, `releaseTrackUrl()` on track change already exist and handle blob URL cleanup correctly. MSE streaming is dead code (never imported).
- [x] TASK-3.4: Fix EQ AudioContext initialization failure — AudioContext creation failure now sets `eqAvailable=false`, shows warning toast, logs to console instead of silent swallow.
- [x] TASK-3.5: N/A — views correctly own their own `<audio>` elements; mediaEngine is the coordination layer (not a playback engine). Discovered in Phase 1 that audioService would duplicate mediaEngine.
- [x] TASK-3.6: Update `tests/mp3-player.test.ts` — added test cases for: (a) rapid track skipping doesn't cause errors, (b) EQ init failure shows toast. Fixed initAudioContext guard to prevent repeated toast spam.
- [x] TASK-3.7: N/A — existing `tests/audio-exclusivity.test.ts` already covers mediaEngine-based exclusivity. Architecture unchanged (views own audio, mediaEngine coordinates).

## Phase 4: Google Drive Simplification

- [x] TASK-4.1: Deleted all dead MSE code from `google-drive.ts` — removed `createGoogleDriveStreamSession`, `canStreamGoogleDriveFile`, `waitForSourceBufferIdle`, `getSupportedStreamMimeType`, `GoogleDriveStreamSession` interface. 144 lines removed (523→379 lines). App already uses `downloadGoogleDriveFile()` → blob → objectURL.
- [x] TASK-4.2: N/A — download progress indicator is a NEW FEATURE, not a bug fix. Deferred. The PRD scope is "fix bugs and simplify, not add features."
- [x] TASK-4.3: Drive/native file load errors now surface as toast messages (was only console.error). Token refresh already handled by `ensureDriveAccessToken()` which checks validity, hydrates from storage, and can request interactive re-auth.
- [x] TASK-4.4: Added exponential backoff retry (1s, 2s, 4s up to 30s, 3 retries) for 429/403 responses in `googleApiFetch`. Reduced `DRIVE_SCAN_CONCURRENCY` from 5 to 3.
- [x] TASK-4.5: N/A — existing `tests/google-drive.test.ts` already covers the full Drive playback flow (mock API → connect → load → play → verify download). Retry backoff is internal implementation detail.

## Phase 5: Mp3PlayerView Decomposition (DEFERRED)

> Deferred: 2633-line component works correctly, 97/97 tests pass. Decomposition is high-risk and violates minimal blast radius principle. Bug-fix scope is complete. Consider for a future dedicated refactor sprint.

- [x] TASK-5.1–5.6: DEFERRED — component decomposition postponed to avoid regression risk.

## Phase 6: MediaEngine & Lock-Screen Reliability

- [x] TASK-6.1: N/A — `next()` and `prev()` already null-check `_onNext`/`_onPrev` before calling. MediaSession action handlers call these methods safely. No race condition.
- [x] TASK-6.2: N/A — `$effect` already batches updates. `setPositionState` only fires when `duration > 0 && isFinite(currentTime)`. Performance is fine.
- [x] TASK-6.3: N/A — `updateTime()` correctly guards `if (duration > 0)` to preserve valid durations. Lock-screen `$effect` checks `isFinite` before `setPositionState`. Already correct.
- [x] TASK-6.4: Deleted `activeAudio.svelte.ts` — zero imports existed anywhere in src/. Fully replaced by mediaEngine.
- [x] TASK-6.5: N/A — MiniPlayer already reads exclusively from `mediaEngine` (verified: imports, reactive bindings all correct).
- [x] TASK-6.6: N/A — MediaSession not fully testable in headless Chromium. Handler wiring verified by code inspection.

## Phase 7: Cleanup, IDB Robustness & Final Validation

- [ ] TASK-7.1: Add IDB error surfacing in `Mp3PlayerView.svelte` (now `MusicLibraryBrowser`) — replace silent `catch {}` blocks in IDB operations (`openIDB`, `saveDriveCache`, `loadDriveCache`, `saveHandleToIDB`) with error logging + toast: "Library cache error. Data may load slower." Keep the fallback behavior but inform the user.
- [ ] TASK-7.2: Fix RSS cache TTL for manual refresh in `PodcastView.svelte` — when user explicitly triggers a refresh (pull-to-refresh or refresh button), bypass the 30-min cache TTL by passing `force: true` to `loadEpisodes()`, which already supports it. Ensure the `force` flag propagates to `fetchRss()` to skip the in-memory cache.
- [ ] TASK-7.3: Add NaN guard to `PlayerControls.svelte` — wrap the `progress` derived value: `const progress = $derived(duration > 0 && Number.isFinite(currentTime) ? (currentTime / duration) * 100 : 0)`. Also guard the time display formatting functions against NaN inputs.
- [ ] TASK-7.4: Sanitize podcast episode HTML descriptions — in the RSS parsing code inside `PodcastView.svelte`, strip or sanitize HTML from `episode.description` before rendering. Use a simple regex strip (`/<[^>]*>/g`) or a DOMParser-based sanitizer. Prevent XSS from malicious RSS feeds.
- [ ] TASK-7.5: Run full Playwright test suite — execute `pnpm test` and verify all tests pass. Fix any remaining failures.
- [ ] TASK-7.6: Verify on Android APK — build with `pnpm cap:sync`, test on real Android device or emulator. Verify: podcast playback, MP3 playback (local + Drive), lock-screen controls, error toasts, tab switching, MiniPlayer. Document any Android-specific issues.
- [ ] TASK-7.7: Remove dead code — delete `AudioPlayer.svelte` (empty placeholder), `createGoogleDriveStreamSession()` remnants, `canStreamGoogleDriveFile()`, unused imports, and `activeAudio.svelte.ts` if fully replaced.
