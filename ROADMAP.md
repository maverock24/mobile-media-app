# Media Hub — Comprehensive Implementation Plan

This roadmap is aligned to the current state of the application rather than the intended end state. Today, the app already has working Music, Podcasts, Weather, Settings, and Drive/Login views, with tab persistence in the root shell, view-level audio ownership for Music and Podcasts, Playwright coverage for the existing flows, and partially scaffolded Essays work that is not yet integrated.

The goal of this plan is to move from the current architecture to a more maintainable media app without breaking the working playback and navigation behaviors already present.

## Current Baseline

### 8
*   `src/routes/+page.svelte` mounts Music and Podcasts permanently and hides them with CSS so playback survives tab switches.
*   `src/lib/stores/activeAudio.svelte.ts` only coordinates exclusivity by stopping the other audio source; it is not yet a full playback engine.
*   `Mp3PlayerView.svelte`, `PodcastView.svelte`, `WeatherView.svelte`, `SettingsView.svelte`, and `LoginView.svelte` are implemented and already part of the tab shell.
*   `EssayCard.svelte`, `EssayListView.svelte`, `EssayPlayerView.svelte`, `AudioPlayer.svelte`, and `PlayerControls.svelte` are currently stubs.
*   `src/routes/essays/+page.svelte` is also a stub.
*   Essay data currently exists in two places: `static/data/essays.json` and `public/data/essays.json`. That duplication should be resolved before the Essays feature is expanded.
*   Existing Playwright coverage already targets navigation, music, podcasts, weather, settings, Google Drive, and audio exclusivity.

### Constraints that should drive sequencing
*   The current always-mounted tab strategy is preserving working playback. Any audio refactor must preserve that behavior until replacement coverage is in place.
*   The codebase does not yet include dependencies for wake lock, metadata extraction, or richer native media integration, so those should be introduced only after the shared audio contract is stable.
*   The current roadmap should treat Essays as a partially started feature, not a greenfield feature.

## Delivery Principles

### Non-negotiable rules
*   Preserve current playback continuity across tab switches until the replacement media architecture is fully verified.
*   Avoid simultaneous architecture and feature expansion in the same milestone where possible.
*   Every phase should end with explicit acceptance criteria and matching Playwright coverage.
*   New persistence must be versioned so stored settings and playback state can evolve safely.

### Recommended workstreams across all phases
*   Testing: keep Playwright coverage up to date as tabs, playback, and Essays evolve.
*   Data contracts: define and reuse TypeScript models before wiring new views.
*   Fallback behavior: specify what the app does when Drive auth, podcast fetches, essay fetches, or weather APIs fail.
*   Observability: add lightweight debug logging around playback source changes, sync progress, and fetch failures during development.

---

## Phase 0: Baseline Hardening
*Reduce ambiguity before larger refactors start.*

### 0.1 Confirm source-of-truth data and routes
*   **Context:** Essays scaffolding exists, but data ownership and routing are still ambiguous.
*   **Implementation:**
    *   Pick a single canonical essays dataset location and remove the duplicate file.
    *   Decide whether Essays should live as a top-level tab, a nested route, or both. The current root shell only supports the existing five-tab model.
    *   Document whether the route should remain `src/routes/essays/+page.svelte` or whether Essays will render entirely inside the root tab shell.
*   **Exit criteria:** There is one essays data source, one routing approach, and a clear ownership decision documented in this file.

### 0.2 Define domain contracts before UI work
*   **Context:** `essay.ts` and `essayPlayer.svelte.ts` are not implemented, which makes later UI work drift-prone.
*   **Implementation:**
    *   Add concrete `Essay`, `EssayTopic`, `EssayCollection`, and player-state interfaces.
    *   Define a shared `MediaItem` or equivalent normalized type for music tracks, podcast episodes, and essays so the future player layer has a stable contract.
*   **Exit criteria:** Essays and shared media types exist and are referenced by the roadmap as the contract for future work.

### 0.3 Add protection for current behavior
*   **Context:** Existing tests cover current flows, but the roadmap currently has no explicit migration safety net.
*   **Implementation:**
    *   Add or update Playwright tests for tab persistence, cross-tab playback survival, and future Essay shell navigation.
    *   Identify one smoke test per implemented tab and one regression test for audio exclusivity.
*   **Exit criteria:** The roadmap names the minimum regression suite that must stay green during all later phases.

---

## Phase 1: Essays Integration and Shared Presentation Layer
*Finish the partially started Essays feature without destabilizing existing playback.*

### 1.1 Integrate Essays into the app shell
*   **Context:** The root shell currently supports `music`, `podcasts`, `login`, `weather`, and `settings` only.
*   **Implementation:**
    *   Extend the `Tab` union and `tabs` derived state in `src/routes/+page.svelte` to include Essays if Essays is confirmed as a first-class tab.
    *   Keep the Essays view mounted consistently with the same shell rules used for other media views if Essay playback should persist across tab switches.
    *   Update saved navigation-state parsing so old localStorage values do not break when the tab list changes.
*   **Acceptance criteria:** Users can enter and leave Essays without breaking navigation persistence or existing media views.

### 1.2 Build the Essays UI on real data contracts
*   **Context:** The components exist only as placeholders.
*   **Implementation:**
    *   Implement `EssayCard.svelte` as the reusable list item.
    *   Implement `EssayListView.svelte` to load and render essays from the canonical JSON source.
    *   Implement `EssayPlayerView.svelte` with metadata display, transcript affordance if supported, and hooks into the current playback coordination layer.
    *   Either remove `src/routes/essays/+page.svelte` if Essays becomes shell-only, or make it delegate to the same shared view components.
*   **Acceptance criteria:** Essays can be browsed and played using the current architecture, without yet requiring the larger audio-engine rewrite.

### 1.3 Build shared presentational playback controls
*   **Context:** A shared control surface is lower risk than a full shared engine and should come first.
*   **Implementation:**
    *   Implement `PlayerControls.svelte` as a presentation component only.
    *   Keep business logic inside the current views initially; pass formatted state and callbacks into the component.
    *   If `AudioPlayer.svelte` is kept, define its scope clearly as a wrapper around UI plus an externally provided audio contract, not as a second hidden engine.
*   **Acceptance criteria:** Music, Podcasts, and Essays can render the same control UI without changing playback ownership yet.

### 1.4 Add tests for Essays and shared controls
*   **Implementation:**
    *   Add Playwright coverage for entering Essays, starting playback, and returning to another tab.
    *   Verify existing Music and Podcast tests still pass after the control refactor.
*   **Acceptance criteria:** Essays have at least one browse test and one playback test; existing media regressions remain green.

---

## Phase 2: Shared Media Runtime
*Introduce a shared media engine only after the UI contract and tests are in place.*

### 2.1 Replace exclusivity-only coordination with a normalized engine
*   **Context:** `activeAudio.svelte.ts` currently supports only `music` and `podcast` stop callbacks.
*   **Implementation:**
    *   Introduce `mediaEngine.svelte.ts` as the single source of truth for playback state.
    *   Support at least `music`, `podcast`, and `essay` source contexts from day one so the Essays feature does not become a second-class integration.
    *   Keep a migration layer so existing views can adopt the engine incrementally rather than all at once.
*   **Acceptance criteria:** Only one runtime audio source can play at a time, and all media types are coordinated through the same store.

### 2.2 Migrate one feature at a time
*   **Context:** Rewriting Music, Podcasts, and Essays simultaneously is unnecessarily risky.
*   **Implementation:**
    *   Migrate Essays first if it is the newest and smallest surface.
    *   Migrate Podcasts second because it typically has richer progress and playback settings.
    *   Migrate Music last because Drive integration and large-library behavior make it the highest-risk surface.
*   **Acceptance criteria:** Each migration step lands with passing tests before the next source is moved.

### 2.3 Add Media Session and mini-player after the engine is stable
*   **Context:** Lock-screen controls and mini-player UI should depend on one real playback source of truth.
*   **Implementation:**
    *   Add `navigator.mediaSession` integration once metadata and play-state come from `mediaEngine`.
    *   Add a `MiniPlayer.svelte` component that reads from the engine and routes users back to the owning media surface.
    *   Ensure mini-player visibility rules work with the existing fixed bottom tab bar.
*   **Acceptance criteria:** Media metadata, play/pause state, and mini-player content stay in sync for all supported media sources.

### 2.4 Add regression coverage for engine migration
*   **Implementation:**
    *   Add tests for source switching between Music, Podcasts, and Essays.
    *   Add tests for mini-player visibility and resume behavior.
*   **Acceptance criteria:** Cross-source playback switching is covered by automated tests, not just manual checks.

---

## Phase 3: Reliability, Offline Behavior, and Search
*Improve real-world usability after the core runtime is stable.*

### 3.1 Add wake lock and background behavior carefully
*   **Context:** Keep-awake behavior is a platform concern and should not be mixed into early UI work.
*   **Implementation:**
    *   Introduce a Capacitor keep-awake dependency only after the shared engine exists.
    *   Define exact expected behavior for Android foreground playback, screen-off playback, and browser-only fallback.
    *   Document what is unsupported on iOS or constrained in web-only environments.
*   **Acceptance criteria:** Background behavior is explicit, dependency-backed, and tested manually on target devices.

### 3.2 Add service-worker-aware media caching
*   **Context:** Cached streaming is useful, but range requests and remote source behavior can break playback if added too early.
*   **Implementation:**
    *   Confirm the current PWA/service-worker setup and whether custom range handling belongs in generated PWA config or a maintained worker file.
    *   Start with cacheable essay assets or explicitly supported podcast sources before attempting Google Drive media caching.
    *   Add error handling for partial content, cache corruption, and unsupported origins.
*   **Acceptance criteria:** Supported media sources play correctly from cache without breaking streaming or seek behavior.

### 3.3 Add search and list management
*   **Context:** Search is useful now and does not require the later native integrations.
*   **Implementation:**
    *   Add feed and episode search to `PodcastView`.
    *   If Essays becomes non-trivial in size, add topic/tag filtering there too.
*   **Acceptance criteria:** Search is fast, local, and does not mutate the underlying fetched dataset.

### 3.4 Add explicit sync and offline ownership
*   **Context:** Offline behavior touches Drive auth, filesystem storage, and cache invalidation.
*   **Implementation:**
    *   Decide whether offline media is managed by service worker cache, Capacitor filesystem, IndexedDB metadata, or a combination.
    *   Version the local manifest that maps remote IDs to local artifacts.
    *   Define quota and eviction behavior before exposing an offline toggle.
*   **Acceptance criteria:** Offline downloads have a clear storage model, deletion model, and recovery path.

---

## Phase 4: Feature Expansion and Native Enhancements
*Only after the foundations above are stable.*

### 4.1 ID3 album art extraction
*   **Implementation:**
    *   Evaluate a lightweight metadata parser and confirm Google Drive and local-file range access behavior before choosing the library.
    *   Cache extracted artwork metadata so repeated list renders do not re-parse headers.
*   **Acceptance criteria:** Artwork extraction improves the UI without introducing significant startup or scroll latency.

### 4.2 Weather expansion
*   **Implementation:**
    *   Expand `weatherSettings` to support multiple saved locations.
    *   Add hourly forecast rendering only after confirming the current weather view data flow and storage model.
*   **Acceptance criteria:** Multi-location weather works without regressing the current single-location flow.

### 4.3 Android widget and deeper native playback features
*   **Implementation:**
    *   Treat the widget as a separate native milestone with its own technical design, because it depends on stable playback metadata and app-to-native communication.
    *   Decide whether widget actions can safely reopen the webview and rehydrate playback state, or whether the widget should remain read-only at first.
*   **Acceptance criteria:** Native widget work begins only after playback metadata, routing, and persistence contracts are proven stable.

---

## Suggested Additions To Keep This Plan Executable

### Decision log to add directly in this document
*   Essays entry point: shell tab, route, or both.
*   Canonical essays dataset location.
*   Shared `MediaItem` contract fields.
*   Offline storage strategy per media source.
*   Minimum supported background playback behavior on Android web, Android Capacitor, and desktop web.

### Missing test milestones to add to implementation tickets
*   Navigation-state migration when the tab list changes.
*   Essay playback plus cross-tab persistence.
*   Source switching between all three media types.
*   Offline failure and retry behavior for cached content.
*   Drive sync progress and recovery after expired auth.

### De-scoping suggestions if delivery needs to stay tight
*   Keep Essays read-only first and defer transcript support.
*   Defer Google Drive offline caching until after essays and podcasts prove out with a simpler source.
*   Defer Android widget work until after Media Session, mini-player, and stable engine migration are complete.
