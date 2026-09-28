# ADR-0003: Play YouTube audio on-device through a scoped CapacitorHttp fetch

- Status: Accepted
- Date: 2026-09-28
- Deciders: maintainer, via feature request ("simple way to integrate YouTube search… only interesting in playing the audio track… integrated with loop, favorites")

## Context

We wanted search-and-play for YouTube audio inside the MP3 player view, with the
constraint that it must not create running costs, must not depend on a
third-party service, and must reuse the app's existing loop/favorites plumbing.

Facts established while investigating (all verified, sources noted):

- **The APK has no server.** `svelte.config.js` builds the mobile target with
  `adapter-static`; `/api/*` routes exist only on the hosted Netlify origin.
  Anything server-side is therefore a hosted service, not part of the APK.
- **Stream URLs are IP-bound.** googlevideo URLs carry an `ip=` parameter and are
  short-lived. A server that resolves the URL cannot hand it to the phone.
- **Datacenter IPs are blocked.** youtubei.js's FAQ: *"The most common one is
  that the server's IP address is blocked by YouTube. Unfortunately, there is no
  known solution to this problem."* Netlify/Lambda run on AWS IPs.
- **InnerTube sends no CORS headers.** Probed from `Origin: https://localhost`:
  `POST /youtubei/v1/player` → 403 with no `access-control-allow-origin`.
- **The API landscape narrowed.** `@distube/ytdl-core` was archived 2025-08-16
  and its README now says to use youtubei.js. yt-dlp for YouTube now requires
  `yt-dlp-ejs` plus a JS runtime (deno/node/bun/QuickJS), so it is not
  serverless-friendly. cobalt has no publicly pre-hosted API. NewPipeExtractor is
  GPL-3.0, which would make a distributed APK GPL-3.0. The official YouTube Data
  API returns an embed iframe and metadata but no stream URL, and its OAuth
  cannot authenticate InnerTube (youtubei.js: OAuth2 "now only works with the TV
  Innertube client", using Google TV's own credentials).
- **YouTube's ToS forbids circumventing access restrictions and automated
  access.** Personal use only; not for distribution or store submission.

## Decision

Extract and play on the device, inside the WebView, with a scoped native fetch.

- **Library: `youtubei.js` (MIT).** Loaded lazily via dynamic `import()` so its
  646 KB browser bundle stays out of the startup chunk — verified absent from the
  prerendered HTML, loaded via `import()` on demand.
- **Two clients, per endpoint.** Session runs as `WEB`; player requests override
  to `VISIONOS` per call. `ANDROID_VR` cannot be the session client
  (`search()` throws `ParsingError: Cannot cast SearchMobileHeader to one of
  SearchHeader`), and `WEB`/`ANDROID` return no per-format URLs at all — only
  `serverAbrStreamingUrl` and an `attestation` marker.
- **`VISIONOS`, not `ANDROID_VR`.** Both return plain URLs, but ANDROID_VR's
  URLs answer a request without a *bounded* byte range with `403 text/plain`:
  `bytes=0-` → 403, `bytes=0-4095` → 206. An `<audio>` element's first probe is
  `Range: bytes=0-`, so Chromium's Opaque Response Blocking drops the text/plain
  403 and playback never starts, silently. VISIONOS serves `200 audio/mp4` with
  no range and `206 audio/mp4` for `bytes=0-`.
- **`getBasicInfo`, never `getInfo`.** `getInfo` also requests `/next`, which
  youtubei.js 18.1.0 fails to parse (`TypeError: Cannot read properties of null
  (reading 'as')` in `VideoInfo`), rejecting even though the player response
  arrived intact.
- **`retrieve_player: false`.** The player script is only needed to decipher
  ciphered URLs, and VISIONOS returns plain ones. Session setup drops from
  3.35 MB to 89 KB and from ~2 s to ~200 ms, and no multi-megabyte string crosses
  the Capacitor bridge.
- **No `Platform.shim.eval` shim, therefore no CSP `unsafe-eval`.** The browser
  default evaluator throws a clear "provide your own JavaScript evaluator" error
  if YouTube ever starts ciphering these formats.
- **A scoped fetch injected into `Innertube.create({ fetch })`**, built on
  `CapacitorHttp.request()`, rather than enabling `CapacitorHttp: { enabled: true }`
  in `capacitor.config.ts`. The global patch repatches `window.fetch` app-wide
  and would touch the working Drive, podcast and radio fetch paths.
  `options.fetch` is threaded through `Session`, `HTTPClient` and `Player`.
- **The panel is rendered once, from `+page.svelte`.** `Mp3PlayerView` is mounted
  twice (one instance per music deck) and stays alive while hidden, so mounting
  the panel there would create two YouTube audio elements. Its `<audio>` sits
  outside the `{#if open}` block so playback survives closing the panel.
- **Favorites share the existing list.** A `youtube` variant is added to
  `FavoriteTrack`, stored in the same persisted `musicSettings.favoriteTracks`
  array. The favorite key and the `MediaItem` id are both `youtube:<videoId>`, so
  identity is a direct comparison.
- **Loop/shuffle reuse the music settings.** Shuffle reads
  `musicSettings.isShuffle`, repeat-one reads `isRepeat`, queue wrap is a new
  `musicSettings.youtubeQueueLoop`, and navigation delegates to the same
  `getNextTrackIndex()` the MP3 deck uses.
- **Android only.** The web build shows the panel with a note that playback
  requires the Android build.
- **No equalizer.** Web Audio cannot process cross-origin media without CORS
  headers and googlevideo sends none, so YouTube bypasses the EQ for the same
  reason radio does.

## Consequences

- No server, no third-party dependency, no recurring cost, and no GPL obligation.
- Two device-only failure modes had to be corrected in the CapacitorHttp
  adapter, both pinned by tests that fail if reverted:
  - CapacitorHttp ignores the requested `responseType` for JSON replies and
    returns a parsed **object**; passing it to `new Response()` stringifies to
    `[object Object]` and every `res.json()` fails. The adapter re-serialises.
  - `CapacitorHttpUrlConnection.setRequestBody()` returns early when no
    `Content-Type` is present, silently dropping the body. InnerTube's `/config`
    POST sends a JSON body with no `Content-Type`, so the adapter adds one.
- The feature is coupled to YouTube's private API and will break when YouTube
  changes it. The blast radius is contained: `VISIONOS` is a one-line constant,
  `PLAYBACK_CLIENT` in `src/lib/youtube/client.ts`, and `resetYoutubeSession()`
  clears the cached session.
- Live streams are unsupported (no per-format URL) and are filtered out of search
  results; any entry that still fails to resolve is skipped rather than stalling
  the queue.
- An on-device dependency appears that cannot be tested in CI: the native HTTP
  hop. Covered by unit tests against the native sources plus a browser E2E that
  proxies InnerTube from Node and plays real googlevideo audio. That E2E is
  **opt-in** (`pnpm test:e2e:live`), because CI runs on datacenter IPs, which
  YouTube blocks — the same constraint that forced on-device extraction. Leaving
  it in the default run would red-line `quality.yml` on every push to main.
  Device-only steps live in `docs/youtube-device-checklist.md`.
- `FavoriteTrack` became a real discriminated union and moved into
  `models/music.ts`; `settings.svelte.ts` imports it instead of duplicating the
  shape.
- Runtime states are specified in `docs/state/youtube-playback.md` (6 states, 17
  transitions, plus the panel-visibility axis), and the engine-level flag is
  reflected in `docs/state/audio-playback-lifecycle.md`.
