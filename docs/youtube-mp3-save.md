# YouTube → MP3 save

Save a YouTube track from the panel's list to an MP3 file on the device.

## Flow (`src/lib/youtube/save.ts`)

1. **Pick a folder** — `FilePicker.pickDirectory()` opens the Android SAF folder
   picker. The returned `path` is the tree URI.
2. **Resolve** — `resolveYoutubeAudio(videoId)` returns a fresh googlevideo URL
   (URLs are IP-bound and short-lived, so a new one is fetched per save).
3. **Download** — `CapacitorHttp.get` in 512 KB byte ranges. The stream host
   sends no CORS headers, so a WebView `fetch` is blocked. Ranges matter twice
   over: a single binary response is handed to JS as one base64 string over the
   Capacitor bridge, and for a whole song that call never settles (the spinner
   hangs with no error), and the `Content-Range` header of each 206 gives the
   total size for a real progress percentage. On Android the bridge returns the
   payload as `Base64.DEFAULT` (line-wrapped); `bytesFromBase64` strips
   whitespace before decoding. Each request carries a 15 s connect and 30 s read
   timeout so a stalled chunk fails loudly instead of hanging.
4. **Decode** — `AudioContext.decodeAudioData`, bounded by a 120 s timeout.
   YouTube serves AAC (`audio/mp4`).
5. **Encode** — LAME compiled to WASM (`wasm-media-encoders`), configured as VBR
   quality 2. The encoder is imported dynamically so its WASM stays out of the
   startup bundle, and PCM is fed in 1152×32-sample chunks with a `setTimeout(0)`
   yield between chunks so the UI keeps painting. Progress is reported per chunk.
6. **Write** — `DirectoryReader.writeFile` writes the base64 payload into the
   SAF tree (`rememberTreeUri` persists the permission first).

## Where it lives in the UI

`YoutubePanel.svelte` renders a download button on every list row. It is
disabled on the web build (the feature is native-only): the web `CapacitorHttp`
shim uses a normal `fetch`, which cannot read the CORS-less stream.

## Not verified on device

The decode + encode + SAF write path is covered only up to the point the tests
can reach: the pure helpers and the WASM encoder are unit-tested, and the web
build is exercised in Playwright. The `CapacitorHttp` base64 download and the
SAF `writeFile` need a real device pass.

## Dependency

`wasm-media-encoders` (MIT) inlines its ~130 KB LAME WASM as base64, so Vite
needs no asset loader. Do not swap it for `lamejs`: that is pure JS and roughly
an order of magnitude slower, which matters when re-encoding a full track.
