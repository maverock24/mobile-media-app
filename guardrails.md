# Guardrails — Audio Reliability Refactor

## Coding Standards

### Svelte 5 Conventions
- Use `$state()`, `$derived()`, `$effect()` runes exclusively — no legacy `$:` reactive statements.
- Use `$state.raw()` for complex objects that don't need deep reactivity (e.g., audio element references).
- Prefer `$derived.by(() => { ... })` for multi-line derivations over complex ternaries.
- Cleanup effects with return functions inside `$effect()` — don't rely on component destruction alone.

### TypeScript
- Strict mode (`strict: true` in tsconfig) — no `any` types without explicit justification.
- All public function signatures must have explicit return types.
- Use discriminated unions for variant types (e.g., `StoredAudioFile` with `source` discriminant).
- Prefer `interface` over `type` for object shapes unless union types are needed.

### File Organization
- Components: `src/lib/components/views/` for full-page views, `src/lib/components/ui/` for reusable UI primitives.
- Stores: `src/lib/stores/` — one store per concern, named `*.svelte.ts` for rune-based stores.
- Models: `src/lib/models/` — pure TypeScript interfaces, no runtime code.
- Utilities: `src/lib/utils/` for shared helpers, `src/lib/utils.ts` for small one-off functions.
- Native plugins: `src/lib/native/` — Capacitor plugin wrappers only.

### Import Ordering
1. Svelte/SvelteKit imports
2. Third-party library imports
3. `$lib/stores/` imports
4. `$lib/models/` imports
5. `$lib/components/` imports
6. `$lib/utils/` and `$lib/native/` imports
7. Relative imports

### Naming
- Stores: `camelCase` (e.g., `audioService`, `mediaEngine`, `toastStore`).
- Components: `PascalCase.svelte` (e.g., `MusicNowPlaying.svelte`).
- Event handlers: `on` prefix for props (e.g., `onPlayToggle`), `handle` prefix for internal (e.g., `handleSeek`).
- Constants: `UPPER_SNAKE_CASE` for module-level constants (e.g., `RSS_CACHE_TTL`, `DRIVE_SCAN_CONCURRENCY`).

### Formatting
- Tailwind CSS classes via `class` attribute — no CSS modules or `<style>` blocks unless scoped behavior is required.
- Use `clsx()` + `tailwind-merge` (existing `cn()` utility) for conditional classes.

---

## Forbidden Patterns

### Audio Management
- **NEVER create a raw `<audio>` element in a view component.** All audio playback MUST go through `audioService`. The only exception is `audioService.svelte.ts` itself.
- **NEVER call `claimAudio()` or `registerAudioSource()` directly.** Audio exclusivity is now handled by the single `<audio>` element in `audioService`. The old `activeAudio.svelte.ts` pattern is deprecated.
- **NEVER set `audioEl.src` directly in a view.** Use `audioService.load(item, source, startAt)`.
- **NEVER create `URL.createObjectURL()` without tracking it for revocation.** Use the `urlTracker` utility or `audioService`'s built-in URL management.
- **NEVER swallow audio errors silently.** Every `catch` block that handles a user-facing audio operation must call `addToast()` with a descriptive message.

### Async / Concurrency
- **NEVER use a boolean flag as a mutex for async operations.** Boolean flags (`isChangingTrack = true`) are checked synchronously but the operations are async — the flag can be stale when the next microtask runs. Use a Promise-chain lock or similar async mutex.
- **NEVER fire-and-forget async stop/cleanup operations.** Always `await` cleanup before starting a new operation. E.g., `await previousStream.dispose()` before creating a new stream.
- **NEVER call `fetch()` without an `AbortController` signal in cancellable contexts.** Episode loading, Drive scanning, and track URL generation must be cancellable.

### State Management
- **NEVER identify a track by its array index for persistence.** Indices change when the list is sorted, filtered, or re-scanned. Use a stable key derived from the file identity (path, Drive ID, or filename hash).
- **NEVER mutate `podcastData.podcasts` from multiple concurrent async operations.** Use the loading lock pattern from TASK-2.1.
- **NEVER store sensitive tokens in `localStorage` as plaintext outside of the existing `googleDriveSession` pattern.** Tokens should go through the session store with expiry tracking.

### Google Drive
- **NEVER use MediaSource/SourceBuffer for simple audio/mpeg files.** The fetch→blob→objectURL pattern is simpler and more reliable. MSE is only justified for adaptive bitrate streaming (HLS/DASH), not for static MP3 files.
- **NEVER make unbounded concurrent API calls to Google Drive.** Always respect `DRIVE_SCAN_CONCURRENCY` (≤3) and use `fetchWithBackoff()` for retries.
- **NEVER assume a Drive access token is valid at time of use.** Always check `hasValidToken()` or call `ensureAccessToken()` before API calls.

### Testing
- **NEVER skip writing a Playwright test for a user-facing behavior change.** Every AC in the PRD must have at least one test.
- **NEVER test implementation details.** Tests should verify user-visible behavior (element visibility, text content, playback state) not internal state variable values.

---

## Architecture Boundaries

### Module Import Rules

```
+page.svelte
  ├── can import: views/*, ui/*, stores/*
  └── must NOT import: native/*, google-drive.ts directly

views/* (Mp3PlayerView, PodcastView, etc.)
  ├── can import: ui/*, stores/*, models/*, utils/*, native/*
  └── must NOT import: other views

ui/* (PlayerControls, MiniPlayer, Button, etc.)
  ├── can import: other ui components, utils
  └── must NOT import: stores/*, views/*, native/*, models/*
  └── exception: MiniPlayer can import mediaEngine (read-only)

stores/* (audioService, mediaEngine, settings, etc.)
  ├── can import: other stores, models/*, native/*, utils/*
  └── must NOT import: components (views or ui)

models/*
  ├── can import: nothing (pure type definitions)
  └── must NOT import: anything

native/*
  ├── can import: @capacitor/* only
  └── must NOT import: stores/*, components/*, models/*
```

### Data Flow Rules
- **Views → audioService → mediaEngine → MiniPlayer/MediaSession**: Unidirectional flow for playback state.
- **Settings stores are independent**: `musicSettings`, `podcastSettings`, `podcastData` are read by views and audioService, not written by audioService.
- **toastStore is fire-and-forget**: Any module can call `addToast()`. ToastContainer reads the store. No bidirectional coupling.

---

## Lessons Learned

_This section is populated by the Ralph Orchestrator during execution._

<!-- 
Format:
- [TASK-X.Y] <lesson description>
-->
