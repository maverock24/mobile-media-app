# YouTube → MP3 save

Save a YouTube track from the panel's list to an MP3 file on the device.

## Flow

1. **Pick a folder** — `FilePicker.pickDirectory()` opens the Android SAF folder
   picker. The returned `path` is the tree URI.
2. **Resolve** — `resolveYoutubeAudio(videoId)` returns a fresh googlevideo URL
   (URLs are IP-bound and short-lived, so a new one is fetched per save).
3. **Download and decode, natively** — `YoutubeAudioPlugin.preparePcm` streams the
   URL to a cache file with `HttpURLConnection`, then decodes it to 16-bit PCM
   with `MediaExtractor` + `MediaCodec`, and returns
   `{ path, sampleRate, channels, samples }`. Download progress is emitted as a
   `progress` event. Capacitor runs plugin methods on its own background thread,
   so neither step touches the WebView UI thread.
4. **Encode** — JS pulls the PCM file in bounded chunks
   (`YoutubeAudio.readPcmChunk`), converts each interleaved Int16 chunk to planar
   floats and feeds LAME compiled to WASM (`wasm-media-encoders`), configured as
   VBR quality 2. The encoder is imported dynamically, so its inlined WASM stays
   out of the startup bundle.
5. **Write** — `DirectoryReader.appendFileChunk` in 256 KB chunks (the first call
   creates the file, the rest append). `rememberTreeUri` persists the SAF
   permission first.
6. **Clean up** — `YoutubeAudio.release` deletes the cache files.

## Why the decode is native

The first implementation fetched the stream into JS and called
`AudioContext.decodeAudioData`. It crashed the app on device. Two reasons:

- `decodeAudioData` has to materialise the whole track as PCM (tens to hundreds
  of MB for a few minutes), inside the WebView.
- It runs through the WebView's media decoder, which can die on a stream the
  platform's own `MediaCodec` handles fine.

Native download and decode remove both, and keep JS memory to a chunk at a time
plus the growing MP3.

## UI

`YoutubePanel.svelte` renders a download button on every list row. It is
disabled on web (the feature is native-only).

## CSP

The WASM encoder only compiles if `script-src` includes `'wasm-unsafe-eval'`
(or `'unsafe-eval'`). It is set in `svelte.config.js`; removing it makes
`createMp3Encoder()` throw at runtime. Confirm it in the mobile build's
`dist-mobile/index.html` meta tag.

## Crash breadcrumb

A native crash leaves no JS error and no toast. `saveMarker.ts` writes the
current phase to `localStorage` before each step and clears it on success or a
caught error, so a crash leaves the phase behind and the next launch reports it.

## Not verified on device

The native download and `MediaCodec` decode have no automated coverage; only the
JS helpers (filename sanitizing, base64, Int16 → planar floats, the LAME encode
against a mocked PCM read, chunked write) are unit-tested. The first real device
save is the actual test.

## Dependency

`wasm-media-encoders` (MIT) inlines its ~130 KB LAME WASM as base64, so Vite
needs no asset loader. Do not swap it for `lamejs`: that is pure JS and roughly
an order of magnitude slower.
