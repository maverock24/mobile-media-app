# PRD: Audio Playback Reliability & Simplification

## Executive Summary

The Media Hub app suffers from two classes of critical playback failures: **podcast episodes failing to play** and **MP3 file playback instability**. Root cause analysis reveals 28 distinct bugs spanning silent error handling, race conditions in async audio operations, Google Drive token expiration mid-stream, concurrent state mutations, and memory leaks from unmanaged blob URLs.

This PRD defines a focused refactoring plan to **fix all critical playback bugs, simplify the audio pipeline, and improve reliability** — without introducing new features. The guiding principle is **simplification**: reduce code volume, eliminate duplicated audio management patterns, and make error states visible to the user.

### Primary Target
- **Android APK (Capacitor)** is the primary deployment target.
- Web preview is secondary, used for Playwright tests only.

---

## Current Architecture Assessment

### File Complexity (Lines of Code)

| File | Lines | Concern |
|------|-------|---------|
| `Mp3PlayerView.svelte` | 2,623 | MP3 browsing, playback, EQ, Drive, native files |
| `PodcastView.svelte` | 819 | Discovery, subscription, RSS, playback |
| `google-drive.ts` | 523 | OAuth, file listing, MSE streaming |
| `mediaEngine.svelte.ts` | 469 | Global playback state, MediaSession, native controls |
| `activeAudio.svelte.ts` | 19 | Audio exclusivity coordination |
| **Total** | **4,453** | |

### Architectural Problems

1. **Mp3PlayerView.svelte is a 2,623-line god component** mixing file browsing, folder navigation, Google Drive auth, audio playback, EQ, preloading, caching, and settings UI. This is the single biggest source of bugs.

2. **Each view manages its own `<audio>` element independently**. PodcastView and Mp3PlayerView each create and manage a raw `<audio>` HTMLElement — duplicating error handling, event binding, seek/resume logic, and MediaSession sync.

3. **No user-facing error feedback**. Audio errors are logged to `console.error()` only. The user sees a silent failure with no indication of what went wrong.

4. **Race conditions in every async path**. Episode loading, track switching, Drive streaming, and audio exclusivity all have unguarded concurrent execution.

5. **Google Drive streaming uses MediaSource API unnecessarily for simple MP3 files**. The MSE-based chunked streaming approach (`createGoogleDriveStreamSession`) is complex and fragile. For audio/mpeg files, a direct `alt=media` URL with a valid token as a query parameter (or a simple fetch→blob→objectURL) is far simpler and more reliable.

---

## Identified Bugs (Prioritized)

### Critical (Playback Broken)

| ID | Bug | File | Impact |
|----|-----|------|--------|
| B1 | Silent audio error — no UI feedback | PodcastView, Mp3PlayerView | User doesn't know playback failed |
| B2 | Episode `audioUrl` empty — silent play failure | PodcastView | Clicking play does nothing |
| B3 | Race condition: concurrent `loadEpisodes()` calls | PodcastView | Episode list corrupted/reverted |
| B4 | Google Drive token expires mid-stream (no refresh) | google-drive.ts | Long tracks fail halfway with 401 |
| B5 | Object URL memory leak + preload cleanup race | Mp3PlayerView | Audio cuts out, DOMException on skip |
| B6 | `appendBuffer()` errors not caught | google-drive.ts | Drive stream crashes silently |

### High (Playback Degraded)

| ID | Bug | File | Impact |
|----|-----|------|--------|
| B7 | Rapid track switch race (`isChangingTrack` timing) | Mp3PlayerView | Concurrent play attempts, double loads |
| B8 | Failed podcast resume — invalid duration fallback | PodcastView | Episodes always restart from beginning |
| B9 | Drive stream disposal race on skip | Mp3PlayerView + google-drive.ts | Stuttering/buffering errors |
| B10 | Stop callback not awaited — audio overlap | activeAudio.svelte.ts | Two sources play briefly simultaneously |
| B11 | Lock-screen handler race (null callbacks) | mediaEngine.svelte.ts | Lock-screen skip buttons fail silently |
| B12 | Per-track position saved by index (not key) | Mp3PlayerView | Wrong position after sort |
| B13 | iTunes lookup fails with no retry | PodcastView | Can't load episodes, no recovery |
| B14 | IDB transaction errors silently ignored | Mp3PlayerView | Library loads slowly without explanation |
| B15 | Google Drive API rate limiting not handled | google-drive.ts | Large library scans fail with 403 |

### Medium (UX Degraded)

| ID | Bug | File | Impact |
|----|-----|------|--------|
| B16 | RSS cache 30min TTL — stale episode lists | PodcastView | New episodes invisible after refresh |
| B17 | EQ filter init failure silently ignored | Mp3PlayerView | EQ doesn't work, user thinks it does |
| B18 | Position throttle misses user seeks | mediaEngine.svelte.ts | Lock-screen seek bar lags |
| B19 | Duration stuck at old value for 0-duration tracks | mediaEngine.svelte.ts | Wrong lock-screen duration |
| B20 | Stop callbacks never cleaned up | activeAudio.svelte.ts | Memory leak, double-fires |
| B21 | Blob URLs from Drive never revoked | google-drive.ts | Memory usage grows per track |
| B22 | Seek slider NaN on malformed tracks | PlayerControls.svelte | Seek bar breaks |
| B23 | Unsubscribe during active load — state corruption | PodcastView | Ghost podcasts in list |
| B24 | Native file deleted — slow error detection | Mp3PlayerView | Delayed error on play |

---

## Simplification Strategy

### Principle: Extract a Shared Audio Service

The core simplification is to **extract all audio element management into a single shared service** (`audioService.svelte.ts`) that both Mp3PlayerView and PodcastView delegate to. This eliminates:
- Duplicated `<audio>` element management (event binding, error handling, seek/resume)
- Duplicated MediaSession synchronization
- The need for the `activeAudio.svelte.ts` exclusivity coordinator (the service IS the single audio element)
- Inconsistent error handling between views

### Principle: Simplify Google Drive Playback

Replace the MediaSource/SourceBuffer streaming approach with a **simple fetch → blob → objectURL** pattern for MP3 files. This eliminates:
- `createGoogleDriveStreamSession()` and all MSE complexity
- `appendBuffer()` errors
- SourceBuffer lifecycle management
- The need for Range header handling

For files under ~50MB (typical MP3), a single `fetch()` with the Drive `alt=media` parameter is simpler and more reliable. Token refresh can happen at fetch time rather than mid-stream.

### Principle: Break Up the God Component

Split `Mp3PlayerView.svelte` (2,623 lines) into focused sub-components:
- `MusicLibraryBrowser.svelte` — folder navigation, file listing, source selection
- `MusicNowPlaying.svelte` — current track display, controls, EQ
- `MusicDriveBrowser.svelte` — Drive folder picker, auth flow
- Keep `Mp3PlayerView.svelte` as a thin orchestrator (~200 lines)

### Principle: Make Errors Visible

Add a lightweight toast/notification system so every audio error shows a user-facing message with an optional retry action.

---

## Detailed Technical Specification

### 1. Shared Audio Service (`src/lib/stores/audioService.svelte.ts`)

**Purpose**: Single `<audio>` HTMLElement managed as a Svelte 5 reactive store. All views call service methods instead of manipulating audio elements directly.

```typescript
interface AudioService {
  // State (reactive via $state)
  readonly isPlaying: boolean;
  readonly isBuffering: boolean;
  readonly currentTime: number;
  readonly duration: number;
  readonly error: AudioError | null;
  readonly source: AudioSourceId | null;
  readonly currentItem: MediaItem | null;

  // Commands
  load(item: MediaItem, source: AudioSourceId, startAt?: number): Promise<void>;
  play(): Promise<void>;
  pause(): void;
  seek(seconds: number): void;
  stop(): void;
  setPlaybackRate(rate: number): void;

  // Lifecycle
  getAudioElement(): HTMLAudioElement;  // For EQ AudioContext binding
  destroy(): void;
}
```

**Key behaviors**:
- **Single audio element**: Created once at service init, reused for all sources.
- **Automatic exclusivity**: Calling `load()` with a new source automatically stops the previous source — no separate coordinator needed.
- **Error surfacing**: All `<audio>` error events captured and exposed via `error` state property.
- **Seek guard**: `seek()` waits for `loadedmetadata` before setting `currentTime`.
- **Clean URL management**: Tracks blob URLs and revokes them on source change.

### 2. Audio Error Toast System

**Purpose**: Show user-facing error messages when audio operations fail.

**Implementation**: A simple reactive array of toast messages rendered in `+page.svelte`:

```typescript
interface AudioToast {
  id: string;
  message: string;
  type: 'error' | 'warning' | 'info';
  action?: { label: string; handler: () => void };  // e.g., "Retry"
  autoDismissMs?: number;
}
```

**Trigger points**:
- Audio element `error` event → "Playback failed. The audio file may be unavailable."
- Network fetch failure → "Network error. Check your connection."
- Drive token expired → "Google Drive session expired. Tap to reconnect."
- Empty `audioUrl` → "This episode has no audio URL available."
- RSS feed failure → "Failed to load episodes. Tap to retry."

### 3. Simplified Google Drive Audio Playback

**Replace** `createGoogleDriveStreamSession()` with:

```typescript
async function createDriveAudioUrl(
  fileId: string,
  getAccessToken: () => Promise<string>
): Promise<{ url: string; revoke: () => void }> {
  const token = await getAccessToken();
  const response = await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!response.ok) throw new DriveAudioError(response.status);
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  return { url, revoke: () => URL.revokeObjectURL(url) };
}
```

**Benefits**:
- No MediaSource/SourceBuffer complexity
- Token validated at fetch time (no mid-stream expiry)
- Blob URL is a local resource — no network dependency during playback
- Simple `revoke()` cleanup

**Tradeoff**: Entire file must download before playback starts. For a 10MB MP3 on 4G (~5 Mbps), this is ~16 seconds. Mitigate with:
- Show a progress indicator during download
- Preload next track while current is playing (already partially implemented)

### 4. Mp3PlayerView Decomposition

Split into these components:

| New Component | Responsibility | Approximate Lines |
|---------------|---------------|-------------------|
| `MusicLibraryBrowser.svelte` | Folder tree, file listing, search, sort, source toggle (device/drive) | ~500 |
| `MusicNowPlaying.svelte` | Current track display, album art, progress, PlayerControls integration | ~200 |
| `MusicEqualizer.svelte` | EQ band sliders, presets, AudioContext management | ~200 |
| `MusicDrivePicker.svelte` | Drive folder selection, auth flow, scan progress | ~300 |
| `Mp3PlayerView.svelte` | Thin orchestrator: state coordination, track selection, view switching | ~300 |

### 5. Podcast Playback Fixes

**Episode loading** — Add an `AbortController` and loading lock:
```typescript
let episodeLoadController: AbortController | null = null;

async function loadEpisodes(podcast: Podcast, force = false) {
  episodeLoadController?.abort();
  episodeLoadController = new AbortController();
  const signal = episodeLoadController.signal;
  // ... pass signal to fetch calls
}
```

**Resume position** — Fix the duration-zero fallback:
```typescript
const resumeAt = episode.positionSec > 10
  ? episode.positionSec
  : 0;  // Don't calculate from percentage if duration unknown
```

**Empty audioUrl** — Show error toast instead of silent return:
```typescript
function playEpisode(podcast: Podcast, episode: Episode) {
  if (!episode.audioUrl) {
    addToast({ message: 'This episode has no playable audio URL.', type: 'error' });
    return;
  }
  // ...
}
```

### 6. Race Condition Fixes

**Track switching mutex** — Use a proper async lock:
```typescript
let trackSwitchLock: Promise<void> = Promise.resolve();

async function selectTrack(index: number) {
  const release = await acquireLock();
  try {
    await startAudioAt(index);
  } finally {
    release();
  }
}

function acquireLock(): Promise<() => void> {
  let release: () => void;
  const prev = trackSwitchLock;
  trackSwitchLock = new Promise(r => { release = r; });
  return prev.then(() => release!);
}
```

**Audio exclusivity** — Make `claimAudio` await stop callbacks:
```typescript
export async function claimAudio(id: AudioSourceId) {
  const promises: Promise<void>[] = [];
  for (const other of Object.keys(stopFns) as AudioSourceId[]) {
    if (other !== id) {
      const result = stopFns[other]?.();
      if (result instanceof Promise) promises.push(result);
    }
  }
  await Promise.all(promises);
}
```

### 7. Google Drive Rate Limiting

Add exponential backoff to folder scanning:
```typescript
async function fetchWithBackoff<T>(
  fn: () => Promise<T>,
  maxRetries = 3
): Promise<T> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (e: any) {
      if (e?.status === 429 || e?.status === 403) {
        const delay = Math.min(1000 * 2 ** attempt, 30000);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      throw e;
    }
  }
  throw new Error('Max retries exceeded');
}
```

Reduce `DRIVE_SCAN_CONCURRENCY` from 5 to 3.

---

## Acceptance Criteria

### Podcast Playback
- [ ] AC-1: Clicking play on any subscribed podcast episode starts audio playback within 5 seconds (network permitting).
- [ ] AC-2: If an episode has no valid audioUrl, user sees an error toast with explanation.
- [ ] AC-3: Episode resume position works correctly — episodes resume from last position, not from beginning.
- [ ] AC-4: Rapidly clicking between episodes does not corrupt state or cause duplicate playback.
- [ ] AC-5: iTunes lookup failure shows a retry option.
- [ ] AC-6: RSS feed loading failure shows an error toast with retry option.

### MP3 Playback
- [ ] AC-7: Playing any local MP3 file starts audio within 2 seconds.
- [ ] AC-8: Playing a Google Drive MP3 file shows download progress and starts playback after download.
- [ ] AC-9: Rapidly skipping tracks does not cause audio overlap, DOMExceptions, or memory leaks.
- [ ] AC-10: EQ preset changes apply immediately to currently playing audio.
- [ ] AC-11: Track position saved by track identity (file path/id), not by list index.
- [ ] AC-12: Google Drive token expiration during a session shows a reconnect prompt (not a silent failure).

### Cross-Cutting
- [ ] AC-13: Only one audio source plays at any time — switching from music to podcast fully stops music before podcast plays.
- [ ] AC-14: Lock-screen controls (play/pause/skip) work reliably on Android.
- [ ] AC-15: MiniPlayer shows correct track info and progress when switching tabs.
- [ ] AC-16: All audio errors show user-facing toast messages with actionable guidance.
- [ ] AC-17: No console DOMExceptions, unhandled promise rejections, or silent failures in normal playback workflows.

### Simplification Metrics
- [ ] AC-18: `Mp3PlayerView.svelte` reduced from ~2,600 lines to ≤400 lines (orchestrator only).
- [ ] AC-19: No duplicated `<audio>` element management — single shared service.
- [ ] AC-20: `createGoogleDriveStreamSession` (MSE) removed in favor of simpler fetch→blob pattern.

---

## Testing Strategy

### Playwright E2E Tests

All UI-facing changes must have Playwright coverage. Tests run against `http://localhost:4173` (preview build).

**New test files**:
- `tests/audio-error-toasts.test.ts` — Verify error toasts appear for failed playback, empty URLs, network errors.
- `tests/podcast-resume.test.ts` — Verify episode resume position and mark-as-played behavior.
- `tests/drive-playback.test.ts` — Verify Drive MP3 download progress and playback (mocked Drive API).

**Updated test files**:
- `tests/podcast.test.ts` — Add coverage for retry buttons, AbortController cancellation.
- `tests/mp3-player.test.ts` — Add coverage for rapid skip, track position by key, EQ init failure.
- `tests/audio-exclusivity.test.ts` — Add coverage for async stop callback coordination.

### Test Mocking Strategy
- Mock `fetch()` for iTunes API, RSS2JSON, and Google Drive API calls via Playwright `page.route()`.
- Mock `HTMLAudioElement` behavior for events (`play`, `pause`, `error`, `loadedmetadata`, `timeupdate`, `ended`).
- Use fake MP3 buffers (existing pattern in test helpers) for file loading tests.

---

## Non-Functional Requirements

### Performance
- Track switching latency: ≤500ms for local files, ≤2s for Drive files.
- Episode list loading: ≤3s for cached feeds, ≤8s for uncached.
- Memory: No unbounded growth from blob URLs or orphaned AudioContext nodes.

### Accessibility
- All playback controls keyboard-navigable (Space for play/pause, arrow keys for seek).
- Error toasts announced to screen readers via `aria-live="polite"`.

### Security
- Google Drive tokens never persisted in plaintext localStorage (already handled via session store).
- No `eval()` or dynamic script injection from RSS feed content.
- Sanitize podcast episode descriptions (HTML from RSS feeds) before rendering.

---

## Out of Scope

The following are explicitly **not** part of this plan:
- Essays feature integration (existing ROADMAP Phase 1 covers this)
- New feature additions (wake lock, offline caching, search, widgets)
- Service worker modifications
- iOS Capacitor support
- UI redesign or theme changes
