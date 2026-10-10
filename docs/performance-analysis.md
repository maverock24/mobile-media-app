# Performance analysis

Date: 2026-10-10
Tree: `269e185` plus the uncommitted edits to `+layout.svelte` and `screen-dim`
Reference: Google's Android performance guidance (startup latency, scroll jank, transitions, power/allocation)

## What this is, and what it is not

This is a static analysis. Nobody ran a device, a Perfetto trace, or a profiler, so there is not a
single millisecond or megabyte in this document. Every finding is a mechanism read out of the code
plus a magnitude estimate. The measurement plan says how to turn each one into a number, and I would
not promise any UI outcome until the first of those numbers exists.

Five readers worked in parallel (native shell and startup, web boot, scroll and transitions,
long-running flows, measurement infrastructure). I re-checked the load-bearing claims by hand and
found one the readers missed: a document-level capture-phase `scroll` listener that a literal
`grep "addEventListener('scroll'"` cannot see, because it is registered from a loop over an array of
event names. That is finding J7.

The severity scale below is about the primary product target, the Android APK. A cost that only
exists on the web build is marked as such, because Playwright does not ship.

## How the guidance maps to this app

The app is a Capacitor WebView holding a SvelteKit SPA, so the guidance splits in two and neither
half is the whole story.

**The native shell** (Activity, playback Service, plugins, R8, ART, notifications) takes the doctrine
close to literally. Trampoline activities, DEX class loading on `onCreate`, shrinker config,
`profileable`, `reportFullyDrawn`, on-device compilation: all of it applies as written.

**Inside the WebView** the advice about ART allocations still lands, because a V8 GC pauses the main
thread the same way, but the budget that matters is the frame budget: 11.1 ms at 90 Hz, 16.7 ms at
60 Hz. There is no `Choreographer.doFrame()` cadence to inspect and no Compose composition tracing.
The analogues are a Svelte reactive scope re-deriving a list, and a DOM patch over hundreds of rows.

**On the allocation doctrine**, I took the document at its word. Ordinary short-lived objects are not
flagged here. The two allocation-shaped things I do flag are steady churn, because repeated GC every
few seconds during playback is exactly the signature the guidance describes: the notification rebuilt
every 3 s (L1) and the web-only canvas redraw per frame (J6).

## Summary

| # | Finding | Severity | Platform |
|---|---|---|---|
| S1 | Boot route eagerly imports every view and fully hydrates | P1 | APK |
| S2 | `mediaEngine` makes ~4 bridge round-trips at module import | P1 | APK |
| S3 | 8 persisted stores read storage and clone at import, ~32 listeners | P2 | APK |
| S4 | Plugin/config/asset I/O on main thread before `loadUrl`, no R8, no baseline profile | P1 | APK |
| S5 | Splash theme half-wired, blank-frame window before first paint | P2 | APK |
| S6 | `largeHeap="true"` | P2 | APK |
| S7 | No `reportFullyDrawn`, startup completion invisible to tooling | P2 | APK |
| S8 | Default tab paints, then the saved tab swaps in | P2 | APK |
| S9 | Both decks mount and restore the whole library at boot | P1 | APK |
| J1 | Podcast episode list re-derives every row at 4 Hz during playback | P1 | APK |
| J2 | One `ResizeObserver` plus rAF layout read per episode row | P1 | APK |
| J3 | 500-row music list recomputes per-row parses and favourite scans on every update | P2 | APK |
| J4 | Whole-library sort parses filenames inside the comparator | P1 | APK |
| J5 | `blur-2xl` layer per new-episode row, list not culled | P2 | APK |
| J6 | Full-screen canvas redraw per frame | P2 | web only |
| J7 | Document capture-phase `scroll` listener calls a bridge method | P2 | APK |
| J8 | Nested vertical scrollers on Weather and Settings | P2 | APK |
| J9 | MiniPlayer animates `width`; `will-change` on the wrong element | P3 | APK |
| J10 | `backdrop-filter` on cards and overlays | P3 | APK |
| L1 | Notification, 3 PendingIntents and `startForeground` rebuilt every 3 s | P1 | APK |
| L2 | Wake lock acquire/release race can leak a screen lock | P1 | web only |
| L3 | Persistent toasts accumulate with no cap | P1 | APK |
| L4 | `rssCache` TTL is checked but never swept | P2 | APK |
| L5 | SAF scan copies the whole array per batch | P2 | APK |
| L6 | Weather refetches on every tab visit | P2 | APK |
| L7 | Four small leaks and one dead code path | P3 | mixed |
| M0-M6 | The repo cannot currently measure anything on Android | P1 | CI |

## Startup

### S1. The boot route imports every view, then hydrates all of it. P1, APK

`src/routes/+page.svelte:3-25` statically imports `Mp3PlayerView` (2559 lines), `PodcastView`,
`RadioView`, `WeatherView`, `SettingsView`, `MiniPlayer`, `YoutubePanel`, `ToastContainer`, plus
`lucide-svelte` and seven stores. There is no lazy boundary anywhere on the boot route. The only
dynamic `import()` in the whole client is `youtubei.js` (`src/lib/youtube/client.ts:115`).

`prerender = true` and no `ssr = false` means `adapter-static` ships prerendered HTML that is then
hydrated. The prerendered page carries no server-fetched data, so hydration buys nothing except the
cost of executing roughly 8,000 lines of app code before the shell is interactive. On a cold WebView
on a low-end device that is the whole startup story.

The fix is not "make Svelte faster". It is to stop paying for `SettingsView` (1292 lines) on a cold
start whose default tab is Music.

### S2. `mediaEngine` talks to the native bridge at module import. P1, APK

`src/lib/stores/mediaEngine.svelte.ts:562` and `:673` run two `$effect.root` blocks during bundle
evaluation, before any component mounts. The second one attaches `document` pause/resume listeners,
calls `MediaControls.addListener('mediaAction')` at `:792`, and runs three effects whose first
execution each make a Capacitor round-trip: `MediaControls.clear()` at `:837`,
`setTransportAvailability` at `:852`, `updatePlaybackState` at `:878`.

So four async bridge calls race the first paint, on the thread that has to produce that paint. That
is the shape of a jank source rather than a startup source, and it belongs in an explicit `init()`
that runs after the shell is on screen.

### S3. Eight persisted stores read storage and clone at import. P2, APK

`src/lib/persisted.svelte.ts:26` reads `localStorage`, and `:34` runs `structuredClone` synchronously
during module evaluation. `src/lib/stores/settings.svelte.ts` creates eight of these
(`:8,25,33,72,110,143,162,196`), and `:143-156` reads `mp3-track-positions` only to clear it. Each
store then opens a `$effect.root` with four window/document listeners
(`persisted.svelte.ts:79-106`), so about 32 listeners are attached before the first paint. Small
each, but it is all on the critical path.

### S4. Everything the bridge needs happens on the main thread before `loadUrl`. P1, APK

The order in `android/app/src/main/java/com/maverock24/mobilemediaapp/MainActivity.java:11-15` is:
register five plugins, then `super.onCreate`. `BridgeActivity` sets the content view, reads
`capacitor.plugins.json` from assets and `Class.forName`s those classes, `Bridge` reads
`capacitor.config.json`, parses `config.xml`, registers all plugins, then `loadWebView` reads
`native-bridge.js` (53 KB), `cordova.js` and `cordova_plugins.js` out of assets, runs a synchronous
WebView package query, and only then calls `loadUrl`. Every one of those milliseconds is added to
navigation start.

Twelve plugin handles get built by reflection on that path: four core, three from config, five custom.
Each constructor does an annotation lookup and a `getMethods()` scan, each instance is
`getDeclaredConstructor().newInstance()`, and each activity-launcher initialisation re-walks the
superclass chain.

Separately, `android/app/build.gradle:73` sets `minifyEnabled false`. There is no `shrinkResources`,
no `profileinstaller`, and no baseline profile anywhere in the repo. R8 never runs, so the release DEX
is the full unoptimised dependency graph: more classes to load and verify, no class merging, no
inlining, and no AOT hint for the `onCreate` path.

### S5. The splash theme is half-wired. P2, APK

`android/app/src/main/res/values/styles.xml:19` declares `AppTheme.NoActionBarLaunch` with parent
`Theme.SplashScreen`, and `core-splashscreen` is a dependency, but there is no `postSplashScreenTheme`
item and no `installSplashScreen()` call anywhere. `BridgeActivity` swaps the theme immediately. On
Android 12+ that leaves the window before Chromium's first paint unguaranteed, so the user may see a
blank frame where the splash drawable was supposed to be. That reads as a slow launch even when the
launch was fine.

`res/layout/activity_main.xml` is dead: it declares a bare `WebView` that nothing references.

### S6. `largeHeap="true"`. P2, APK

`AndroidManifest.xml:8`. The WebView renderer is a separate process, so the page-holding process gains
nothing from a bigger ceiling. It delays OOM and can lengthen GC pauses. Worth testing with it off.

### S7. Nothing reports startup completion. P2, APK

No `reportFullyDrawn` call exists in `android/`. Until something calls it, neither Macrobenchmark nor
a Play Console vitals view can tell "startup finished" from "startup gave up". The web layer already
publishes the signal: `+layout.svelte` sets `document.body.dataset.hydrated = '1'`.

### S8. The default tab flashes. P2, APK

`activeTab` starts at `'music'` and is only corrected to the saved tab in `onMount`, after the
prerendered HTML has painted. A user whose last tab was Settings sees the music chrome first. Cosmetic,
but it is a flicker, and the transitions doctrine is about exactly that.

### S9. Both decks mount and both restore the whole library. P1, APK

`src/routes/+page.svelte:231,234` mounts `Mp3PlayerView` twice, once per deck, and both stay alive
behind `class:hidden`. The mount effect runs `loadHandleFromIDB()` and `loadDeviceCachedLibrary()`,
then `restoreStoredFilesFromCache` and `hydrateTracksFromLibrary`, which sorts the whole library.
`openIDB()` is called for both decks. So startup does two IndexedDB reads and two full-library sorts.
It is async, so the first frame is spared, but two long tasks land right after it, and deck B is
hidden the entire time on a device that will never switch decks.

### Already fine on the startup path

No trampoline. The launcher goes straight to `MainActivity` (`AndroidManifest.xml:24`, `singleTask`),
and `MediaControlsReceiver.onReceive` only dispatches an action, never starts an activity. The
notification's content intent is the launcher intent, so a notification tap is one activity start with
frames between. Android 12+ has nothing to block here.

No boot-started service. No `BOOT_COMPLETED` permission or receiver. `MediaPlaybackService` starts
lazily from the plugin on first update. `MediaSessionCompat` is created in service `onCreate`
(`MediaPlaybackService.java:74`), which first runs on playback or Android Auto bind, not on cold start.

No App Links. There is no `VIEW`/`BROWSABLE`/`autoVerify` filter, so there is no verification to fail
and no subdomain or redirect in scope. `custom_url_scheme` is declared and unused.

No web fonts, so no FOUT or FOIT. No blocking script in `app.html`. `fast-xml-parser` is server-only.
`bits-ui` is a declared dependency with zero references in `src/`.

## Scrolling and jank

### J1. The podcast episode list re-derives every row at 4 Hz while audio plays. P1, APK

`src/lib/components/views/PodcastView.svelte:423` renders `{#each selectedPodcast.episodes as episode}`
with no key and no windowing. Every row runs two `{@const}` helpers that read `currentTime`:

```
424:  {@const activeEpisode = isActiveEpisode(episode, currentEpisode)}
425:  {@const episodeProgress = getEpisodeProgressPercent(episode, currentEpisode, currentTime, duration)}
426:  {@const episodeProgressLabel = getEpisodeProgressLabel(episode, currentEpisode, currentTime, duration)}
```

`currentTime` is a `$state` at `PodcastView.svelte:98`, written through the setter at `:157` by
`src/lib/podcast/podcastPlayer.ts:206`. That write is throttled to 250 ms (`podcastPlayer.ts:199`),
which is 4 Hz by design. Svelte re-derives each item's scope when a dependency changes, so all
episodes re-derive four times a second, for as long as playback lasts. A 200-episode feed is roughly
2,400 helper calls per second plus a spread of the current episode object on every tick.

This is the clearest jank finding in the app, and it is worst during the exact journey the app exists
for. The fix is to read `currentTime` in one place instead of N: compute progress for the active
episode only, or move the progress element into a child component that subscribes to the clock.

### J2. One `ResizeObserver` and one rAF layout read per episode row. P1, APK

`PodcastView.svelte:457` puts `use:marqueeTitle` on every episode row. The action
(`src/lib/actions/marqueeTitle.ts:7,23-24`) creates a `ResizeObserver` per row, and `check()` reads
`node.scrollWidth` and `node.clientWidth` inside a `requestAnimationFrame` (`:11-12`), which is a
forced layout read. A typical feed is 50 to 300 rows, so that is 50 to 300 observers and a burst of
layout reads on first paint.

While I was in there: `Mp3PlayerView.svelte:33` imports `marqueeTitle` and never uses it, so the
`title-marquee` class on song rows never gets `is-active` and song titles never scroll. That is a
functional bug hiding behind a performance one, and it is why the 500-row music list avoids this cost.

### J3. The 500-row music list recomputes per-row work on every state change. P2, APK

`Mp3PlayerView.svelte:1944` renders up to 500 rows (`BROWSE_RENDER_LIMIT` at `:325`, slice at `:328`),
unkeyed. Each row calls `parseFilename(entry.name)` three times (`:2123` twice, `:2124`) and
`favoriteTracks.isFavoriteTrack(entry.file)` four times (`:2135,2140,2141,2143`).

Neither is free. `parseFilename` (`src/lib/models/music.ts:185-190`) runs two regex replaces, a
`replace` and an `indexOf` on every call. `isFavoriteTrack`
(`src/lib/favorites/favoriteTracks.ts:197-202`) is an `Array.some` scan over the favourites array. So a
play/pause or track change re-evaluates roughly 1,500 parses and 1,500 scans.

To be fair to the code: this is update cost, not scroll cost. The rows carry
`content-visibility: auto` with `contain-intrinsic-size` (`:2541-2542`) and the container has
`contain: layout style` (`:2546`), so pure scrolling runs no JavaScript and off-screen paint is culled.
The music list's deriveds depend on the browse entries and the search query, not on `currentTime`
(`:304-329`, debounced 200 ms). That part was done properly.

### J4. The library sort parses filenames inside the comparator. P1, APK

`src/lib/models/music.ts:219-227`:

```
220:  return [...files].sort((a, b) => {
222:      return parseFilename(a.name).title.localeCompare(parseFilename(b.name).title);
224:      return parseFilename(a.name).artist.localeCompare(parseFilename(b.name).artist);
```

`parseFilename` is not a property read. It does regex work. The comparator runs O(n log n) times, so a
5,000-track library is on the order of 60,000 parses per sort, and `sortFiles` is called from several
places: `hydrateTracksFromLibrary`, `loadBrowseEntries` (`browseNavigation.svelte.ts`), and the search
index effect at `Mp3PlayerView.svelte:255`, which additionally maps `parseFilename` over the full
library and lowercases every name.

That effect is a synchronous long task right after the cache restore. It is a frozen frame the user
will feel, just not during scroll. Precomputing the parse key once per file removes most of it.

### J5. A blur layer per new-episode row. P2, APK

`PodcastView.svelte:440` paints `blur-2xl` on a strip inside every "new" episode row. Blur is raster
work, the layer is static so it is painted once, but the episode list has no `content-visibility` and
no windowing, so every new-episode row holds an offscreen buffer at once.

### J6. The Aurora canvas redraws every frame. P2, web only

`src/lib/components/AuroraBackground.svelte` runs a `frame()` that reschedules itself and, each frame,
clears a full-viewport 2D canvas and redraws the stars (200 on mobile), the clouds, and four aurora
bands of 100 line segments with fresh gradient objects.

It is switched off on the target platform: `onMount` returns early when `Capacitor.isNativePlatform()`.
So the APK does not pay for it. The web build does, it eats the frame budget before scroll even
starts, and any Playwright-based perf measurement will be dominated by it. If that guard is ever
removed, this becomes the top finding.

### J7. A document scroll listener calls the native bridge. P2, APK

This is the one the readers missed. `src/routes/+layout.svelte` builds an array of event names and
registers one handler for all of them:

```
const ACTIVITY_EVENTS = ['pointerdown', 'touchstart', 'keydown', 'keyup',
  'beforeinput', 'input', 'compositionupdate', 'wheel', 'scroll'];
document.addEventListener(type, reportScreenDimActivity, { capture: true, passive: true });
```

The handler throttles the bridge call to 250 ms, and it registers only on native, so the cost is
bounded: one `Date.now()` and a comparison per event, and at most four `ScreenDim.notifyActivity()`
bridge calls per second. During a fling the scroll listener itself fires at display rate.

I am not calling this a problem, because it is passive, capture-phase, and cheap. I am recording it
because it is registered from a loop, so the obvious grep for a scroll listener returns zero, and a
later reader would conclude there is no scroll listener on the hot path. There is one.

### J8. Nested vertical scrollers. P2, APK

`+page.svelte:257,261` wrap Weather and Settings in `absolute inset-0 overflow-y-auto`, and both views
scroll internally as well (`WeatherView.svelte:340`, `SettingsView.svelte:458` and again at `:1254`).
The outer container has nothing to scroll because its child is `h-full`, so this is a redundant
scroller rather than a double-scroll bug. It is still two nested same-direction vertical scroll
containers, which is the documented lazy-layout mistake, and it invites scroll chaining and overscroll
oddities on touch. Worth removing, cheap to verify on a device.

### J9 and J10. Small rendering costs. P3, APK

`MiniPlayer.svelte:446` animates `width`, a layout property, at 4 Hz with `transition: width 250ms
linear`, so it is layout plus paint instead of a transform. `app.css` puts `will-change: transform` on
`.mini-player-seek`, which is the deck B volume range input (`MiniPlayer.svelte:452`), not the progress
fill it was meant to promote.

`app.css` defines `.ui-panel-surface` with `backdrop-filter: blur(18px) saturate(125%)`, applied by
`ui/Card.svelte` and by several fixed dialog backdrops (`Mp3PlayerView.svelte:2413`,
`SettingsView.svelte:1238`) and the buffering overlay (`:2202`). Each forces an offscreen raster of the
backdrop, but they appear one at a time and none of them is inside a scrolling list. Credit where it
is due: the codebase already stripped `backdrop-filter` from the MiniPlayer and the tab bars, with a
comment explaining why. That is the right instinct.

### Already fine while scrolling

No scroll handler on the music list, and none on any list. No `onscroll`, no IntersectionObserver
scanning per frame. Images across Podcast, Radio and YouTube carry `width`/`height` plus
`loading="lazy"` and `decoding="async"`, so there is no layout shift and no decode jank; none of them
uses a blob URL. Radio and YouTube lists are keyed on stable ids (`stationuuid`, `videoId`). No Svelte
`transition:`, `in:` or `out:` on any list item or view container; the only transition in the repo is
`ToastContainer.svelte:26`. No `transition: all` on rows, only color transitions.

## Transitions

This journey is in better shape than the others.

The switching mechanism is a state write, not a remount. Music, Podcast and Radio stay mounted and are
toggled with `class:hidden`, so those three tabs cost one `$state` assignment plus a haptic tick
(`+page.svelte:35-37`). Weather and Settings are conditionally mounted (`+page.svelte:256-262`), so
they build their DOM fresh, but nothing synchronous runs in the click handler: `SettingsView`'s mount
does an async network call, and `WeatherView`'s effect starts an async fetch. No parse, sort or
IndexedDB read blocks the tap.

That is the doctrine's "tab switches animate without delay" satisfied, mostly by accident of keeping
the three heavy views alive.

Two things follow. First, keeping the views alive is what makes switching cheap, but it also means both
decks keep running their effects while hidden (S9, J3). Second, the only flicker is Weather and
Settings showing a loading state and then content on first visit, which is network-bound and not a
stall. Neither is worth a change on its own; S9 is.

## Long-running flows, leaks and power

### L1. The notification is rebuilt every 3 seconds for the whole session. P1, APK

`src/lib/stores/mediaEngine.svelte.ts:890-897` arms a 3 s interval whenever audio is playing, and each
tick calls `MediaControls.updatePlaybackState`. On the Java side that reaches
`MediaControlsPlugin.java:265` → `MediaPlaybackService.updateNotification` (`:250-301`), which builds
`MediaMetadataCompat` and `PlaybackStateCompat`, creates three `PendingIntent.getBroadcast` objects,
calls `getPackageManager().getLaunchIntentForPackage` (`:284`, a PackageManager IPC) and re-promotes
with `startForeground` (`:299`).

The comment in the Java already notes position pushes fire 4×/sec. The plugin methods run on
Capacitor's `CapacitorPlugins` HandlerThread, so this is not UI jank. It is steady binder traffic and
allocation churn for hours, which is the "frequent GC during long operations" signature in the
guidance. The metadata changes only when the track or play state changes; the notification should be
rebuilt then, and nothing else should touch it.

### L2. The wake lock acquire/release race. P1, web only

`mediaEngine.svelte.ts:638-668`: `acquireWakeLock` overwrites the module-level `_wakeLock` with a new
sentinel, and `releaseWakeLock` reads it, awaits `release()`, then sets it to `null`. The effect at
`:901-906` calls both with `void`, so there is no ordering. A rapid play/pause can leave an old
sentinel untracked and unreleased, and the trailing `= null` clobbers the new one. Each lost sentinel
holds a screen lock. Native returns early at `:639` and is unaffected. Web only, but "the screen never
sleeps" is a bug worth fixing rather than a performance nicety.

### L3. Persistent toasts accumulate without a cap. P1, APK

`toastStore.svelte.ts:57` pushes every toast. Only `dismissToast` (`:69-74`) removes one, and a toast
with `autoDismissMs: 0` never gets a timer (`:60`). Radio stream loss emits one, and so do the delete
confirmation and the update prompt. A repeated failure stacks another message and another DOM node
that stays until it is tapped. The array has no cap and no dedupe.

### L4. `rssCache` is never swept. P2, APK

`src/lib/rss.ts:13` is a module-level `Map` keyed by feed URL and page. `fetchRss` (`:100-105`) honours
the 30-minute TTL on read but never deletes a stale entry, and only an explicit `clearRssCache` prunes
anything. Each entry holds a parsed feed of up to 50 episodes with 200-character descriptions, so tens
to hundreds of KB per entry, growing with every distinct podcast page browsed in a session.

### L5. The SAF scan copies the whole array per batch. P2, APK

`deviceLibrary.svelte.ts:211-216` does `view.allFiles = [...view.allFiles, ...mappedBatch]` plus a
`bumpBrowseVersion()` per batch. A 10,000-track library at 500 per batch is 20 full-array copies and 20
reactive invalidations. Transient cost during a scan, not a leak.

### L6. Weather refetches on every tab visit. P2, APK

The cache is component-local (`WeatherView.svelte:69`) and the view unmounts when the tab changes, so
the cache dies with it and the active-city effect refetches. Network plus JSON parse per navigation, for
data that has not changed.

### L7. Small ones. P3, mixed

The background watchdog keeps ticking with no item (`mediaEngine.svelte.ts:730-748`) until the app is
resumed or paused. The Drive `folderHasSubFolders` map is merged into and never pruned
(`folderPicker.svelte.ts:185-195`). The Drive retry loop sleeps up to 30 s without consulting the
caller's `AbortSignal` (`google-drive.ts:88-99`). `swipeItem.ts:93` schedules a 250 ms timer that
`destroy` does not clear. `fileResolver.ts:54-86` is dead code that creates object URLs and expects the
caller to revoke them; nothing calls it today, so it leaks nothing, but it is a trap for whoever wires
it up.

### Already fine over long sessions

Object URL lifecycle is bounded, and this is the one that usually bites a media app. The only live
create site is `Mp3PlayerView.svelte:1055`, revoked through `live.cleanup` (`:1071`), which
`player.releaseUrl` and `revokeAll` invoke. The queue holds the current track plus one preload. The
three other object URL sites are the dead function above.

The equalizer does not churn. `Mp3PlayerView.svelte:843-856` creates the `MediaElementSource` and the
filter chain once per deck behind a `filters.length > 0` guard, even though `applyEqualizer` is called
on every track start, and closes the `AudioContext` on unmount (`:1599`). No per-track or per-seek node
churn.

Progress persistence is coarse by design. Podcast `timeupdate` is throttled to 250 ms in memory and
persisted every 20 s, with an exact flush on pause and end; MP3 `timeupdate` is throttled the same way.
Nothing writes IndexedDB per tick.

There is no polling loop. Drive tokens refresh on demand with a 60 s margin, YouTube caches its
session, podcast refresh is user-triggered with bounded concurrency. The sleep timer ticks once a
second but writes an unchanged `endsAt`, so it does not flush the store. The Java service has no
repeating `Handler`; its only `postDelayed` is the one-shot 10-minute wakelock and it is removed on
hold and release.

Action listener lifecycles are balanced: `swipeItem` destroy, `marqueeTitle` disconnect, the Aurora
cancel, the podcast `online` listener, the YouTube audio progress listener, the `mediaEngine`
document pause/resume listeners, the navigation listeners.

## Measurement plan

Start here, because none of the above can be verified or closed without it. The repo currently cannot
produce a valid Android performance number, and one workflow actively produces an invalid one.

### M0. Make a build worth measuring. Do this first.

- Add `<profileable android:shell="true" tools:targetApi="29" />` to the release manifest. Without it,
  no `am profile`, Perfetto or simpleperf run against a release build on API 29+, and the only
  profileable variant is debug, which the guidance forbids for benchmarking.
- Turn on R8 for release in `android/app/build.gradle:68-74` (`minifyEnabled true`,
  `shrinkResources true`) and keep it on. Every measurement taken with `minifyEnabled false` is a
  measurement of a build nobody ships.
- Stop shipping the debug variant as the default artifact. `.github/workflows/netlify-deploy.yml:84`
  falls back to `variant=Debug` when the signing secrets are absent, and that is the APK a reader of
  `latest.apk` would download and benchmark.
- Compile on device to a known state before a run:
  `adb shell cmd package compile -m speed -f com.maverock24.mobilemediaapp`

### M1. Startup

Add a `com.android.test` macrobenchmark module with `androidx.benchmark:macrobenchmark` and run cold,
warm and hot `StartupTimingMetric` tests, 10 or more iterations, and report median, P95 and P99 rather
than a mean. Take field numbers from Play Console vitals for `com.maverock24.mobilemediaapp`.

The WebView needs its own completion signal, because the Activity is on screen long before the shell
is usable. Add a small plugin method that calls `reportFullyDrawn()`, and call it from the web layer
when the shell reports ready. `+layout.svelte` already sets `document.body.dataset.hydrated = '1'`,
so the signal exists and only needs wiring. After that, every S-finding and the J4 long task become
measurable as a delta against a baseline.

### M2. Jank

On the native side, add `androidx.metrics:metrics-performance` and wrap the real journeys
(shell open, podcast list scroll during playback, tab switch) in `FrameMetricsAggregator`, or use
JankStats. Report `RenderTime` percentiles, not janky-frame counts, per the guidance. Play Console
frame vitals are app-wide and cannot be scoped to a journey, which is exactly why the aggregator is
needed.

On the web side, record `PerformanceObserver` long tasks and event timing during a scripted journey,
plus `performance.mark`/`measure` around the podcast list derive and the library sort. That is how J1,
J2 and J4 get numbers today, before any native instrumentation lands.

For individual runs, Perfetto is the tool: it answers "what took 40 ms here" when the aggregate says
something regressed. Aggregates say when, traces say what. Expect to see the 3 s notification rebuild
as background HandlerThread activity (L1) and the plugin registration as main-thread work (S4).

### M3. Tracepoints

Add `androidx.tracing` and wrap the startup path in `Trace.beginSection`: `BridgeActivity` content
view, plugin registration, the asset reads, `loadUrl`, and the first navigation. Wrap the notification
rebuild too. Only chunks over 0.1 ms, per the guidance, since each section costs about 5 microseconds.

One caveat that matters here. Once R8 is on, a shrinker config can strip tracepoints. The current
`android/app/proguard-rules.pro` is entirely comments with no rules, so nothing is at risk today. When
R8 is enabled, add a keep rule for `androidx.tracing` and do not add `-dontoptimize`.

### M4. Memory

Record a three-hour playback journey in the Memory Profiler and read it for a climbing object count
followed by GCs, and for time between GCs. The suspects to look for are the notification path (L1),
`rssCache` (L4) and the toast array (L3). Sort by class for pool candidates and by callstack for the
hot allocation path.

Confirm L2 with `adb shell dumpsys batterystats` looking for a screen wakelock held with playback
paused, and read `adb shell dumpsys meminfo com.maverock24.mobilemediaapp` alongside it.

### M5. Procedure and calibration

Write the procedure down once, under `docs/`, so it can be repeated: the Perfetto config, the
`simpleperf record -g` invocation, the Memory Profiler flow, and the device used. Calibrate the device
and A/B on the same device and OS build. `lockClocks` is for microbenchmarks only; it must not be used
for launch, duration-of-use or jank tests.

Today there is no such document. `docs/device-verification.md` is a 20-case functional pass with no
timings, and the only timing assertion in the entire test suite is a 3 s upper bound guarding an
O(n^2) queue hydration in `tests/unit/models/player.test.ts`.

### M6. The CI gap

`.github/workflows/quality.yml` is the only pull-request gate and it runs JavaScript only. The three
Android workflows are tag, dispatch and main only. A pull request can change
`MediaPlaybackService.java` and merge with nothing compiling it. The instrumented tests that exist are
the Capacitor templates, one of which asserts `com.getcapacitor.app` against an app whose id is
`com.maverock24.mobilemediaapp`, so it would fail if anyone ran it. No workflow compiles Java on a
pull request at all.

Minimum viable fix: a pull-request job that compiles the release variant with R8 on, so shrinker
regressions fail fast. The real fix is a macrobenchmark run on a physical device or Firebase Test Lab,
which is a larger commitment and worth doing only after M0 to M3 exist.

## Prioritized fix plan

Effort is S (an afternoon), M (a day or two), L (a week of careful work). Payoff names the measurement
that proves it moved.

**P0**

1. Make the release measurable. `profileable`, R8 on, never publish or benchmark the debug artifact,
   document the compile command. S. Unblocks all of M1 to M4. Until this exists, everything else here
   is an argument rather than a result.
2. Fix J1. Key the episode list, add `content-visibility` so off-screen rows are culled, and stop
   reading the 4 Hz clock in every row. M. Payoff: long-task count and `RenderTime` P95 on the podcast
   scroll journey during playback.
3. Fix L1. Rebuild the notification only when the track or play state changes, and drop the 3 s
   interval. S. Payoff: GC count over a one-hour session and `dumpsys batterystats`, plus Perfetto
   HandlerThread activity.

**P1**

4. Fix J4 and J2 together. Precompute the parse key once per file and store it on the track, reuse it
   across every sort and the search index; move the search index off the render path; drop the per-row
   `marqueeTitle` and keep one observer, or use CSS. M. Payoff: long-task duration at startup and
   after a scan.
5. Fix S1 and S9. Dynamically import the non-default views, and defer deck B's restore until it is
   first shown. M. Payoff: cold-start median and P95 from M1, and the startup long-task count.
6. Fix S2. Move the import-time bridge calls into an explicit `init()` that runs after the first
   paint. S. Payoff: startup trace, first-frame-to-interactive gap.
7. Fix L2. Serialise acquire and release rather than firing both with `void`. S. Payoff: a
   `dumpsys batterystats` check that no screen lock is held while paused.
8. Fix L3. Cap the toast array, dedupe by message, and give every toast a dismissal path. S. Payoff:
   DOM node count over a long session in the Memory Profiler.

**P2**

9. Fix L4 and L7. Sweep `rssCache` on read and cap it; prune the Drive folder map; honour the abort
   signal in the retry; clear the swipe timer; delete `fileResolver.resolveStoredFileToUrl`. S.
   Payoff: heap growth over a long browsing session.
10. Fix L5. Accumulate SAF batches and invalidate once. S. Payoff: scan-duration trace on a large
    library.
11. Fix J8, J9 and J10. Remove the outer scrollers on Weather and Settings, animate the MiniPlayer
    progress with a transform, move `will-change` to the element it was meant for. S. Payoff: a device
    check on overscroll feel; nothing measurable otherwise, which is why it is P2.
12. Fix S5, S6 and S7. Complete the splash contract with `postSplashScreenTheme` and
    `installSplashScreen()`; test with `largeHeap` off; call `reportFullyDrawn` from the hydrated
    signal. S. Payoff: perceived cold start, plus M1 gains a usable end marker.
13. Fix L6. Hoist the weather cache out of the component. S. Payoff: fewer network calls per
    navigation.
14. Add the CI compile job from M6. S. Payoff: shrinker and native regressions stop merging silently.

## What is already good, and should not regress

Worth listing, because a report full of findings reads like a bad codebase and this is not one.

The native shell avoided the classic launch mistakes: no trampoline activity, no activity started from
the media receiver, no boot-started service, no App Links to verify. The Java service creates its
`MediaSession` lazily and has no repeating handler.

The music list does its honesty work: `content-visibility` culling, `contain: layout style`, debounced
and capped deriveds that do not depend on playback time, no scroll handler, and images with declared
dimensions, lazy loading and async decoding.

The resource discipline that usually fails in a media app holds: object URLs bounded to the current
track plus one preload with a cleanup path, the equalizer built once per deck with the `AudioContext`
closed on unmount, progress persisted on a coarse cadence instead of per tick, no polling loops.

The web bundle keeps the heavy things out: `youtubei.js` behind a dynamic import, `fast-xml-parser`
server-only, no web fonts, no blocking script. And the codebase already stripped `backdrop-filter` from
the components that repaint most, with a comment explaining the reason.

## Caveats

No measurements were taken. Every magnitude here is structural.

Line numbers come from a static read of the working tree at `269e185` plus the uncommitted edits to
`+layout.svelte` and `screen-dim`. The highest-severity claims were re-checked by hand; a few of the
lower-severity ones rest on a single read.

Line numbers for `Bridge.java`, `CapConfig.java`, `PluginHandle.java` and `Plugin.java` are from the
Capacitor 8.2.0 dependency, not from this repo. `ConfigXmlParser` ships in
`org.apache.cordova:framework:14.0.1` and is not in the checkout, so its I/O cost is inferred from the
call site only.

The merged manifest was not inspected, so costs contributed by library-declared components are not
assessed. Play Console vitals configuration for this package could not be verified from the repo.
