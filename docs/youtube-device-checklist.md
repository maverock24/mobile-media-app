# YouTube audio — first device run checklist

The one thing CI cannot cover is the native HTTP hop: CapacitorHttp going out
through Android's OkHttp. Everything else (extraction, the adapter contract, the
UI flow, real playback) is covered by `pnpm test`, `pnpm test:live`, and
`tests/e2e/youtube.test.ts`.

Work through this on a device and you should be able to tell, without guessing,
whether the feature works.

## Before you start

```sh
pnpm validate          # typecheck + unit + E2E (hermetic)
pnpm test:live         # real YouTube extraction (vitest), opt-in
pnpm test:e2e:live     # real YouTube playback in a browser, opt-in
pnpm cap:sync:android  # mobile build + sync into android/
```

Both live suites are opt-in on purpose: CI runs on datacenter IPs, which YouTube
blocks, so leaving them ungated would make `quality.yml` red on every push.

Then run the `app` configuration from Android Studio, or:

```sh
cd android && ./gradlew installDebug
```

Tail the log while you test, in a second terminal:

```sh
adb logcat -v time | grep -Ei "capacitor|youtube|chromium|media"
```

## 1 — The panel is reachable with no music library

Open the app without loading any folder. **Play from YouTube** should be on the
empty state next to Open Folder / Connect Google Drive.

Tap it. You should get a full-height panel: back arrow, "Audio only", Search and
Favorites tabs, and a search field.

> Deliberate: YouTube audio needs no local MP3s, so the panel must not be gated
> behind loading a library.

## 2 — Search works (this is the CapacitorHttp test)

Type `top hits 2024` and tap the search button.

Expected: a list of ~20 results with thumbnails, titles, channel names and
durations, within a second or two.

This is the step that exercises CapacitorHttp end to end. Thumbnails come
straight from `i.ytimg.com` over the normal WebView fetch, so if thumbnails load
but the list stays empty, the problem is specifically the native HTTP path.

## 3 — First play (the critical step)

Tap any result.

Expected, in order:
1. A brief spinner on the row while the stream URL is resolved (~0.2–1 s).
2. The now-playing bar appears at the bottom with artwork, title, channel, and a
   `1 / N` queue counter.
3. **The time counter starts advancing past 0:00.** This is the pass/fail line.

If the time never leaves 0:00, the audio element received a URL it could not
use — see the table below.

## 4 — Failure signatures

| What you see | Most likely cause | What to check |
|---|---|---|
| "Could not reach YouTube. Check your connection." but the device has internet | CapacitorHttp rejected, not a real network problem | `adb logcat` for a CapacitorHttp exception. This is the untested hop. |
| Search results list stays empty, thumbnails load | InnerTube POST failing | logcat; confirm requests go to `www.youtube.com/youtubei/v1/search` |
| Track resolves, `src` is set, but the time stays at 0:00 and there is no error | The unbounded-range / Opaque Response Blocking problem (see ADR-0003) | In logcat, find the `videoplayback` URL and confirm `c=VISIONOS`. If it says `ANDROID_VR`, `PLAYBACK_CLIENT` was changed. |
| "This video has no playable audio stream (live streams are not supported)." | Live stream or a SABR-only player response | Expected for live content; search filters those out, so reaching this means a non-live video returned no URL |
| "YouTube is asking for sign-in for this video." | Bot detection on your network | Try another network; note it, it is an operational problem, not a code bug |
| "YouTube changed its URL encoding. The app needs an update." | YouTube started ciphering these formats, so the missing `Platform.shim.eval` matters | This is the designed loud failure. Do **not** "fix" it by adding `unsafe-eval` to the CSP without revisiting ADR-0003. |
| "Playback failed. The audio link may have expired — tap the track again." | The resolved URL aged out (~6 h) or the IP changed (network switch) | Re-tapping should re-resolve and work |

## 5 — Integration checks

Each of these is wired to existing behaviour. Confirm them on the device:

- **Next / previous.** Use the panel's arrows and then the same buttons in the
  MiniPlayer. Both should move the queue, the counter should increment, and a
  new track should start.
- **Loop.** Toggle the loop button in the panel header off, play the last item,
  and let it finish — playback should stop. Turn it on and it should wrap.
- **Shuffle.** Toggle shuffle in the panel, skip a few times, and confirm the
  order is not sequential. The toggle is the same setting the music player uses,
  so it should be on if you left it on there.
- **Repeat-one.** With `isRepeat` enabled in the music player, a YouTube track
  should restart rather than advance.
- **Favorites.** Star a track, close the panel, reopen it, open the Favorites
  tab, and confirm it is there. Then go to the music tab's favorite list (star
  icon in the browse header): the YouTube entry should appear with a "· YouTube"
  suffix. Tapping it should reopen the panel and play that video. Force-quit and
  relaunch — it must survive.
- **MiniPlayer.** With a YouTube track playing, close the panel. Playback must
  **keep going**, and the MiniPlayer must show the track with a working seek
  slider. It should say YouTube, not the music deck. Tap it — the panel should
  reopen.
- **Seek.** Drag the slider. It should jump, not restart.
- **Background playback.** Lock the screen. Audio should continue, and the
  notification controls should show the track and respond to play/pause/skip.
- **Sleep timer.** Set a short timer with YouTube playing. It should pause when
  it fires.
- **Exclusivity, both directions.** Play a YouTube track, then start a radio
  station or an MP3 — YouTube must stop. Then go back to the YouTube panel: its
  now-playing bar still shows the track, but the element's `src` was released, so
  tapping play must **re-resolve and start playing**. If you instead get a "Could
  not start playback" toast, `SUSPENDED → RESOLVING` (T7 in
  `docs/state/youtube-playback.md`) has regressed.

## 6 — Regression check

The adapter is scoped to the YouTube client and `window.fetch` is **not**
globally patched. Confirm the existing paths still work after this change:

- Google Drive: browse, play a track, download a file.
- Podcasts: search and play an episode.
- Radio: search and play a station.

If any of these broke, the likely cause is someone enabling
`CapacitorHttp: { enabled: true }` in `capacitor.config.ts`. Don't; see
ADR-0003.

## 7 — Report back

Worth capturing so it can be folded into the ADR or memory:

- Device model, Android version, and Android System WebView version.
- Which of sections 1–6 passed.
- For any failure: the exact on-screen message and the matching logcat lines.
- The resolved URL's `c=` and `itag=` parameters (tells us which client and
  format was used).
