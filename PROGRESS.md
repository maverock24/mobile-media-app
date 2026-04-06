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

- [ ] TASK-4.1: Replace `createGoogleDriveStreamSession()` in `google-drive.ts` with `createDriveAudioUrl()` — new function does: `fetch(alt=media)` → `response.blob()` → `URL.createObjectURL(blob)`. Returns `{ url, revoke }`. Delete all MediaSource/SourceBuffer code (`waitForSourceBufferIdle`, the `while` streaming loop, MSE setup). Delete `canStreamGoogleDriveFile()`.
- [ ] TASK-4.2: Add download progress indicator for Drive files — `createDriveAudioUrl()` should accept an `onProgress(loaded, total)` callback using `response.body.getReader()` with `Content-Length` header. Expose this in `Mp3PlayerView.svelte` as a download progress bar/spinner shown between tap and play-start.
- [ ] TASK-4.3: Add token refresh before Drive fetch — before calling `createDriveAudioUrl()`, check `googleDriveSession.hasValidToken()`. If token is within 5 minutes of expiry, call `googleDriveSession.ensureAccessToken()` first. If refresh fails, show toast: "Google Drive session expired. Tap to reconnect." with a sign-in action.
- [ ] TASK-4.4: Add exponential backoff to Drive folder scanning — create `fetchWithBackoff()` utility wrapping fetch calls. On 429/403 responses, retry with 2^attempt * 1000ms delay (max 30s, max 3 retries). Reduce `DRIVE_SCAN_CONCURRENCY` from 5 to 3. Use this wrapper in `streamGoogleDriveMp3Files()`.
- [ ] TASK-4.5: Write Playwright test `tests/drive-playback.test.ts` — mock Google Drive API responses. Test: (a) Drive MP3 plays successfully via blob URL, (b) download progress shown, (c) expired token triggers reconnect toast, (d) 403 rate limit retried with backoff.

## Phase 5: Mp3PlayerView Decomposition

- [ ] TASK-5.1: Extract `src/lib/components/views/MusicLibraryBrowser.svelte` — move all folder browsing logic: `browsePath`, `browseEntries`, `fetchEntries()`, folder navigation, file listing, sort controls, source toggle (device/drive), favorite folders. Props receive the loaded file list and callback for track selection. Approximately 500 lines extracted.
- [ ] TASK-5.2: Extract `src/lib/components/views/MusicNowPlaying.svelte` — move now-playing display: current track info, album art placeholder, `PlayerControls` integration, liked status, playback speed selector. Reads from `audioService` state. Approximately 200 lines extracted.
- [ ] TASK-5.3: Extract `src/lib/components/views/MusicEqualizer.svelte` — move EQ band sliders, preset selector, AudioContext wiring. Receives `audioService.getAudioElement()` for `createMediaElementSource`. Self-contained `initAudioContext()` + cleanup. Approximately 200 lines extracted.
- [ ] TASK-5.4: Extract `src/lib/components/views/MusicDrivePicker.svelte` — move Drive folder picker, auth flow, scan progress display, `driveLoadProgress` state. Emits events when files are loaded. Approximately 300 lines extracted.
- [ ] TASK-5.5: Slim down `Mp3PlayerView.svelte` to orchestrator — import and compose the four extracted components. Handle track selection callbacks, view state management (browse vs now-playing), and coordinate between sub-components. Target: ≤400 lines.
- [ ] TASK-5.6: Verify all existing `tests/mp3-player.test.ts` tests still pass after decomposition — run full test suite. Fix any selectors or test assumptions broken by the component restructure.

## Phase 6: MediaEngine & Lock-Screen Reliability

- [ ] TASK-6.1: Fix lock-screen handler race condition in `mediaEngine.svelte.ts` — store handler references in stable variables and null-check before invoking. Use `$effect` to update `navigator.mediaSession` action handlers only when the handler function reference actually changes (not on every re-render). Guard native `MediaControls` listener callbacks with `?.()` null-safe calls.
- [ ] TASK-6.2: Fix position state throttle in `mediaEngine.svelte.ts` — replace the 1-second `setTimeout` throttle with a debounce that fires on the LAST value. When user seeks (detected by large position jumps >2s), immediately flush the position update to lock-screen. Keep the 1s throttle for normal incremental updates.
- [ ] TASK-6.3: Fix duration tracking stuck at old value — change `updateTime()` to always update `duration` (remove the `if (duration > 0)` guard). Instead, add a `isValidDuration()` check in the lock-screen sync `$effect` to skip `setPositionState` when duration is 0 or NaN.
- [ ] TASK-6.4: Add `unregisterAudioSource()` to `activeAudio.svelte.ts` (if file is still used) — OR confirm the file is now unused and delete it. If deleted, remove all imports across the codebase.
- [ ] TASK-6.5: Update `MiniPlayer.svelte` to read exclusively from `audioService` + `mediaEngine` — verify MiniPlayer doesn't need any changes, or update its reactive derivations to use the new single-source architecture.
- [ ] TASK-6.6: Write Playwright test for lock-screen behavior — test that `navigator.mediaSession.metadata` is correctly set when playing music and podcasts, and that action handlers fire correctly (mock MediaSession).

## Phase 7: Cleanup, IDB Robustness & Final Validation

- [ ] TASK-7.1: Add IDB error surfacing in `Mp3PlayerView.svelte` (now `MusicLibraryBrowser`) — replace silent `catch {}` blocks in IDB operations (`openIDB`, `saveDriveCache`, `loadDriveCache`, `saveHandleToIDB`) with error logging + toast: "Library cache error. Data may load slower." Keep the fallback behavior but inform the user.
- [ ] TASK-7.2: Fix RSS cache TTL for manual refresh in `PodcastView.svelte` — when user explicitly triggers a refresh (pull-to-refresh or refresh button), bypass the 30-min cache TTL by passing `force: true` to `loadEpisodes()`, which already supports it. Ensure the `force` flag propagates to `fetchRss()` to skip the in-memory cache.
- [ ] TASK-7.3: Add NaN guard to `PlayerControls.svelte` — wrap the `progress` derived value: `const progress = $derived(duration > 0 && Number.isFinite(currentTime) ? (currentTime / duration) * 100 : 0)`. Also guard the time display formatting functions against NaN inputs.
- [ ] TASK-7.4: Sanitize podcast episode HTML descriptions — in the RSS parsing code inside `PodcastView.svelte`, strip or sanitize HTML from `episode.description` before rendering. Use a simple regex strip (`/<[^>]*>/g`) or a DOMParser-based sanitizer. Prevent XSS from malicious RSS feeds.
- [ ] TASK-7.5: Run full Playwright test suite — execute `pnpm test` and verify all tests pass. Fix any remaining failures.
- [ ] TASK-7.6: Verify on Android APK — build with `pnpm cap:sync`, test on real Android device or emulator. Verify: podcast playback, MP3 playback (local + Drive), lock-screen controls, error toasts, tab switching, MiniPlayer. Document any Android-specific issues.
- [ ] TASK-7.7: Remove dead code — delete `AudioPlayer.svelte` (empty placeholder), `createGoogleDriveStreamSession()` remnants, `canStreamGoogleDriveFile()`, unused imports, and `activeAudio.svelte.ts` if fully replaced.
