# YouTube → file save

Save a YouTube track from the panel's list to a folder on the device. The file is
the stream exactly as YouTube serves it, which is AAC in an MP4 container, named
`.m4a`. That extension is one of `SUPPORTED_AUDIO_EXTENSIONS`, so the saved track
plays in the app's own player.

## Flow

1. **Pick a folder** — `FilePicker.pickDirectory()` opens the Android SAF folder
   picker. The returned `path` is the tree URI.
2. **Resolve** — `resolveYoutubeDownload(videoId)` returns the stream URL, its
   container MIME type, the file extension for it, and the byte size when
   YouTube reports one. It asks for the MP4 container explicitly and falls back
   to `any` for the rare video with no MP4 audio track, in which case the
   extension follows the container that was actually chosen.
3. **Download, natively** — `YoutubeAudioPlugin.download` writes the stream to a
   cache file and returns `{ path, size }`. Progress is emitted once per
   megabyte. Capacitor runs plugin methods on its own background thread, so this
   does not touch the WebView UI thread.
4. **Copy** — JS pulls the cached file in 256 KB chunks
   (`YoutubeAudio.readFileChunk`) and appends them to the SAF document
   (`DirectoryReader.appendFileChunk`, the first call creates it). The byte count
   is checked against the downloaded size and a short file is reported rather
   than left behind.
5. **Refresh the library index** — the panel calls `requestLibraryRescan()`, the
   same signal the Settings rescan button fires, and every mounted music view
   listens for it. The browse view lists from the library index rather than from
   the disk, so without this step the saved track is on disk but invisible in
   the Music tab until the user rescans by hand. Both decks rebuild their own
   copy of the index, which is what the per-deck view state requires.
6. **Clean up** — `YoutubeAudio.release` deletes the cached file.

## Why there is no transcoding

This used to produce MP3: native `MediaCodec` decode into a 42 MB PCM file in the
cache, that file read back across the Capacitor bridge as base64 to feed LAME
compiled to WASM, then the encoded result written out. For a four-minute track
that is roughly 56 MB of base64 over 288 bridge round trips, plus a scratch file
the size of the track, and it crashed on device. None of it is needed, because
the app already reads m4a: the only thing that path bought was an extension the
player does not require.

## Why the download looks the way it does

The old download was one bare `HttpURLConnection` GET with no request headers and
no range. That is not how this host is addressed, and it is the difference
between a complete transfer and a partial one. Two things were missing, both
taken from youtubei.js's own downloader
(`node_modules/youtubei.js/dist/src/utils/FormatUtils.js`):

- **The stream headers.** `accept: */*`, `origin` and `referer` of
  `https://www.youtube.com`, matching `STREAM_HEADERS`.
- **The range parameter.** This host uses the `range=<start>-<end>` *query
  parameter* rather than a `Range` header. The download walks the file in 4 MB
  windows, retries each window up to three times, and the URL's own `range`
  value, if it has one, is left alone and logged.

A window that returns anything other than exactly the requested number of bytes
ends the walk, whether short (the stream ended) or long (the parameter was
ignored). When the resolver reported a size, the total is checked against it, so
a truncated transfer fails loudly instead of producing a file that looks like a
track.

## Reading the device log

`adb logcat | grep YoutubeAudio` gives one line per window and one per download:

```
download id=dQw4w9WgXcQ host=rr1---sn-x.googlevideo.com expected=4194304 urlRange=none
range 0-4194303 + 4194304 bytes, 4194304 total
download finished: 4194304 bytes
```

`urlRange` is the part worth reading: it settles whether YouTube's own URL
already carries a range, and therefore whether a partial response is possible at
all. A window line that repeats at the same offset is the retry path working.

## UI

`YoutubePanel.svelte` renders a save button on every list row. It is disabled on
web (the feature is native-only).

## Crash breadcrumb

A native crash leaves no JS error and no toast. `saveMarker.ts` writes the
current phase to `localStorage` before each step and clears it on success or a
caught error, so a crash leaves the phase behind and the next launch reports it.

## Not verified on device

The native download has no automated coverage. Only the JS helpers are
unit-tested: file-name sanitizing, base64 round trips, the chunked copy and its
short-write guard, the save flow against mocked plugin calls, the crash marker,
and the rescan signal. `scripts/hitl-youtube-save.sh` captures the logcat and the
breadcrumb a device run needs to produce.

The last hop has no test either: that the panel dispatches the rescan signal
after a save, and that the mounted view rebuilds the index when it does. Both
sides exist and are wired, but only a device run shows the track appearing in
its folder without a manual rescan.

## Dependencies

The save path needs no encoder. `wasm-media-encoders` and the CSP
`wasm-unsafe-eval` token it required were removed with the transcode.
