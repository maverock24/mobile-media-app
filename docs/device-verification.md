# Native device verification pass

Every test here runs against fakes. The 704 unit tests and 9 e2e tests never load
a SAF folder, play a podcast, resume from the background, take a wakelock or
transfer a file; the native paths are verified by reading the code and by unit
tests of isolated logic. This pass turns the device run into evidence: for each
item, what proves it works and what a failure looks like. Work top to bottom and
record every case. Where a step rests on reading, not a test, the case says so.

## Before you start

The commands come from `package.json` and `.github/workflows/quality.yml`. The
install step depends on the local Android toolchain (SDK, Gradle, adb); confirm
on the machine doing the testing that `adb` sees the device and `./gradlew`
resolves, since CI never runs this part.

```sh
pnpm cap:sync:android   # pnpm build:mobile (BUILD_TARGET=mobile vite build) + cap sync android
cd android && ./gradlew installDebug
```

Or run the `app` configuration from Android Studio. `pnpm android:doctor`
(`pnpm repo:check` is the strict run) checks the toolchain first. A `.env` with
`PUBLIC_GOOGLE_CLIENT_ID` is required for the Drive cases. `pnpm test` and
`pnpm test:e2e` are the hermetic gates and are not part of this pass.

Tail the app's logs in a second terminal:

```sh
adb logcat -v time | grep -Ei "capacitor|mediaEngine|podcast|chromium|MediaControls|MediaPlaybackService"
```

The `[mediaEngine]` lines matter most. Console errors and unhandled rejections
are also recorded to Settings > Data & Storage, so a crash leaves a trace after
the toast is gone.

## 1. Load a local folder through the SAF picker

Goal: a folder of MP3s becomes the device library.
Steps: from the welcome screen ("Your Music") tap **Open Folder**; in the system
picker choose a folder with MP3s. The browse header's **Local folder** icon runs
the same flow.
Expected: the button spins through **Loading…**, then the browse list shows the
folder's files and sub-folders; a bar reads `Indexing library… N% · N files
found` while the index builds; the breadcrumb shows the folder name.
Failure: "No MP3 files were found in the selected folder.",
"Unable to open a folder on this device. Please try again.", or an empty list.
Evidence: screenshot of the list and index bar; logcat for
`Unable to persist tree URI permission.` (a warning, not fatal).
Code: `src/lib/device/deviceLibrary.svelte.ts:310` (`openFolder`),
`src/lib/browse/folderScan.ts:108` (`pickNativeAudioDirectory`).

## 2. The folder choice survives an app restart

Goal: no re-pick after a cold start.
Steps: with the folder loaded, force-stop the app from Settings, then relaunch.
Expected: the Music tab opens on the browse list for the same folder without a
picker. A warm cache populates the list immediately; without one the index bar
runs. The tree URI is read from persisted `musicSettings.nativeTreeUri`,
permission from `DirectoryReader.rememberTreeUri`.
Failure: the welcome screen reappears, the picker is shown again, or the list is
empty with no index bar.
Evidence: screenshot after relaunch.
Code: `src/lib/components/views/Mp3PlayerView.svelte:1509` (mount restore),
`src/lib/device/deviceLibrary.svelte.ts:239`,
`src/lib/stores/settings.svelte.ts:41`.

## 3. Play a local file

Goal: a local MP3 actually plays in the WebView.
Steps: in the browse list tap a file row (label **Play <name>**).
Expected: the player view replaces the list; title, artist and art appear; the
MiniPlayer shows the track; the time advances past 0:00 and the seek bar moves.
Failure: the time stays at 0:00, **Loading track…** never clears, or a decode
error lands in the console. This exercises the deck element, a detached
`new Audio()`, not an in-DOM `<audio>` (see the closing section).
Evidence: screenshot with the time advanced; logcat around the play.
Code: `src/lib/components/views/Mp3PlayerView.svelte:1211` (`playBrowseFile`),
`:1081` (`startPlayback`), `src/lib/audio/player.svelte.ts:146`.

## 4. Both music decks play at once

Goal: Deck A and Deck B are independent.
Steps: play a track on sub-tab **A**; switch to **B** (the A / B / YouTube bar);
open that deck's library and play a different track; lower the Deck B volume
slider (Deck A has none, it is fixed at 100%).
Expected: two tracks audible at once; each row shows **Playing**; the A/B switch
changes which deck the MiniPlayer describes (`Deck A` / `Deck B`).
Failure: starting the second deck stops the first, or one flag drops.
Evidence: screenshot of both rows; logcat.
Code: `src/lib/stores/mediaEngine.svelte.ts:41` (sibling deck skipped),
`src/routes/+page.svelte:192` (sub-tabs), `:214` (both decks mounted,
`class:hidden` only).

## 5. Music and podcast or radio are exclusive

Goal: one audio channel, in the directions the engine enforces.
Steps, both orders: (1) with a deck playing, start a podcast episode, then a
radio station; (2) with a podcast or radio playing, return to Music and play on
Deck A.
Expected: a podcast or radio claim stops the music decks; a Deck A claim stops a
podcast or radio. Confirm, do not assume: a **Deck B** claim does **not** stop a
podcast or radio (`claimAudio` skips them, and skips the stream). Case 20 covers
that direction; the code does not make Deck B exclusive.
Failure: sources of different types audible together after a claim that should
have stopped one, or a flag left true after a stop.
Evidence: screenshot of the stopped source; logcat.
Code: `src/lib/stores/mediaEngine.svelte.ts:41`; stop callbacks at
`Mp3PlayerView.svelte:586`, `PodcastView.svelte:166`, `RadioView.svelte:34`.

## 6. Podcast episode: play, pause, resume

Goal: the podcast transport works end to end, which no test executes.
Steps: on Podcasts, use **Subscribed** or search **Discover** and subscribe,
open the podcast, then tap an episode row (or its round play button).
Expected: a spinner on the row, then a Pause icon; the MiniPlayer shows the
episode; the time advances. Tap again to pause, then play to resume at the same
position. Each new episode resets speed to 1.0, so MiniPlayer **1.5x** is off
until tapped.
Failure: "Playback failed." (the `safePlay` failure path), "This episode has no
playable audio URL." (no enclosure), or a Pause icon with no sound.
Evidence: screenshot of the row and MiniPlayer; logcat.
Code: `src/lib/podcast/podcastPlayer.ts:372` (`playEpisode`), `:439`
(`pausePlayback`), `:450` (`resumePlayback`), `PodcastView.svelte:423`.

## 7. Podcast seek

Goal: seek moves the position, not a restart.
Steps: with an episode playing, drag the MiniPlayer slider (label **Seek**).
Expected: the position jumps and playback continues. `handleSeekSeconds` writes
`currentTime` straight to the element with no suppression guard.
Failure: the episode restarts, or the slider snaps back.
Evidence: before/after on-screen times.
Code: `src/lib/podcast/podcastPlayer.ts:485`, `:129` (`claimPodcastControls`
registers the handler).

## 8. Podcast previous and next

Goal: episode stepping and its boundaries.
Steps: with an episode playing, tap **Previous** then **Next** in the
MiniPlayer; repeat to the first and last episode of the feed.
Expected: each moves one episode and starts it. Next at the last, and Previous
at the first, do nothing.
Failure: a step skips two, wraps, or plays another feed.
Evidence: titles before and after; logcat.
Code: `src/lib/podcast/podcastPlayer.ts:476` (`nextEpisode`), `:467`
(`prevEpisode`).

## 9. The end of an episode stops

Goal: no auto-advance at the end.
Steps: seek an episode near its end and let it finish.
Expected: playback stops; the row shows **Played** with a full bar; the
MiniPlayer clears; the next episode does not start (`onEnded` marks it played
and sets `mediaEngine.item = null`).
Failure: the next episode starts on its own.
Evidence: screenshot of the **Played** badge and stopped player.
Code: `src/lib/podcast/podcastPlayer.ts:289` (`onEnded`).

## 10. Resume position survives killing and relaunching

Goal: the saved position is restored after a process kill.
Steps: play an episode for over a minute, pause it, swipe the app from recents,
relaunch, open Podcasts.
Expected: the last episode is loaded, paused, at the saved position (mount
restore). Play resumes near the saved point. A kill mid-play loses up to 20s
(`PROGRESS_PERSIST_MS`); a pause flushes exactly.
Failure: the episode reloads from 0:00, or nothing is restored.
Evidence: screenshot of the restored row and time, against the position before
the kill.
Code: `PodcastView.svelte:285` (restore effect),
`src/lib/podcast/podcastPlayer.ts:247` (flush on pause),
`src/lib/podcast/progress.ts:165` (`getEpisodeResumePosition`).

## 11. Network loss during a podcast, and reconnect

Goal: the reconnect path, which tests exercise only through mocks.
Steps: play an episode; turn on airplane mode (or disable Wi-Fi) mid-play; wait;
turn the network back on.
Expected: the stall surfaces as `stalled` or `MEDIA_ERR_NETWORK` (code 2);
playback pauses and a toast reads "Connection lost — will resume when
reconnected." On reconnect the `online` listener rebuilds the source, seeks to
the saved position (only if over 1s in), claims audio and plays. A failed resume
toasts "Reconnected but failed to resume. Tap play to retry."
Failure: it stops silently with no toast, or resumes from 0:00.
Evidence: the toast text; logcat around the drop and the `online` event.
Code: `src/lib/podcast/podcastPlayer.ts:316` (`onStalled`), `:300` (`onError`),
`:171` (`scheduleReconnectResume`).

## 12. Leaving the app: notification, lock-screen controls, return

Goal: playback and control survive backgrounding.
Steps: play a local file (repeat for a podcast); press Home (do not force-stop);
expand the media notification; lock the screen and use its controls; reopen the
app.
Expected: audio continues; a "Media playback" notification shows title and
artist and responds to play/pause, next/previous, seek; the lock screen matches;
reopening continues playback (the `document` `resume` handler disarms recovery).
Android 13+ prompts for notification permission on first run; grant it.
Failure: audio stops on backgrounding, no notification appears, its buttons do
nothing, or a stalled "Connecting…" on return.
Evidence: notification and lock-screen screenshots; logcat for
`[mediaEngine] document pause: arming background resume` and, if the OS paused,
`[mediaEngine] background resume attempt` / `background watchdog: resuming
playback`.
Code: `src/lib/stores/mediaEngine.svelte.ts:674` (`handleDocumentPause`), `:637`
(`armBackgroundResume`), `:650` (5s watchdog), `:756`, `:793`;
`android/app/src/main/java/com/maverock24/mobilemediaapp/MediaPlaybackService.java:215`.

## 13. Screen off and lock

Goal: playback continues with the screen off, and a deliberate pause survives.
Steps: with a file playing, press power to turn the screen off and lock; wait;
turn it on. Repeat with a podcast. Then press Pause first, lock, and check it
stays stopped.
Expected: audio continues. The lock/screen-off transition pauses the WebView
element; the `document` `pause` event arms a 180ms then 250ms retry loop and a 5s
watchdog that plays again while the user still wants playback. A deliberate
pause sets `markUserPaused()` and the recovery bails out, so a paused player
stays paused and the sleep timer is not undone.
Failure: audio dies on lock and never returns, or a paused player restarts.
OEM battery optimisation and Doze can suppress the watchdog: test once with the
app excluded and once without, and record both, since the code cannot guarantee
the second.
Evidence: logcat for the arming and resume lines; a screenshot of a paused
player that stayed paused.
Code: `src/lib/stores/mediaEngine.svelte.ts:674`, `:637`, `:650`;
`src/lib/podcast/podcastPlayer.ts:247`; `android/app/src/main/AndroidManifest.xml`
(`WAKE_LOCK`, `FOREGROUND_SERVICE_MEDIA_PLAYBACK`).

## 14. Drive: connecting

Goal: the native Google consent flow returns to the app.
Steps: from the welcome screen tap **Connect Google Drive** (or the **Google
Drive** cloud icon in the browse header); complete consent.
Expected: the button shows **Connecting…** and clears on return. With no folder
chosen the **Choose a folder** sheet opens; with one saved the library loads
without asking.
Failure: **Connecting…** stays forever; an error line from `driveSession.error`.
Evidence: screenshot of the sheet; logcat.
Code: `src/lib/drive/driveLibrary.ts:296` (`connectGoogleDrive`), `:319`
(`openDriveSourceButton`).

## 15. Drive: choosing a folder

Goal: a Drive folder becomes the library.
Steps: in the **Choose a folder** sheet navigate into a folder and tap
**Select "<name>"** (or **Select all**, which searches the whole Drive); star a
folder to favorite it.
Expected: the sheet closes; the list loads the folder's audio; the header shows
**Google Drive** and the folder; favorites reappear in the strip.
Failure: "Failed to list Drive folders.", an empty sheet, or a load that never
completes.
Evidence: screenshot of the list and favorites strip.
Code: `src/lib/drive/driveLibrary.ts:308` (`changeDriveFolder`),
`src/lib/drive/folderPicker.svelte.ts:178`, `Mp3PlayerView.svelte:992`.

## 16. Drive: restoring a pending folder choice after a restart

Goal: the OAuth hand-off survives the app being killed behind the consent
screen.
Steps: start the connect/change flow so the native consent screen takes over,
kill the app from recents before approving, relaunch.
Expected: the intent is a localStorage flag (`google-drive-folder-picker-
pending`); on mount the view retries the restore and the **Choose a folder**
sheet reopens once a token is available; the Connect control is never left
wedged.
Failure: the sheet never reopens and Connect stays disabled, or the flag is left
behind so the sheet reopens every launch.
Evidence: whether the sheet reappears; the localStorage key if inspectable;
logcat.
Code: `Mp3PlayerView.svelte:1428` (mount restore), `:1474` (focus/visibility),
`src/lib/drive/folderPicker.svelte.ts:117`, `:33`.

## 17. Transfer: download a Drive file to a local folder

Goal: a Drive file lands in a chosen SAF folder.
Steps: with Drive loaded, swipe a Drive file row left and tap **Download**. With
no local folder chosen yet the picker opens first and the download follows;
otherwise the **Download to phone** screen opens, so navigate and tap **Save
here**.
Expected: a row reads `Downloading <name> · N%`, then `Saving <name>`, then the
toast `Downloaded "<name>" to phone.` The file appears in the local list (in
Drive view the source row keeps its Download action instead).
Failure: "Please re-select your music folder to grant write permission.",
"Download failed.", or a bar stuck before 100%.
Evidence: screenshot of the progress and the new file.
Code: `src/lib/device/deviceLibrary.svelte.ts:593` (web), `:509` (native),
`Mp3PlayerView.svelte` (row Download action).

## 18. Transfer: upload a local file to Drive

Goal: a local file lands in a Drive folder.
Steps: with a local library loaded and Drive connected, swipe a local file row
left and tap **Upload**; in the **Upload to Google Drive** screen navigate and
tap a folder.
Expected: after a short wait, the toast `Uploaded "<name>" to Drive.`
Failure: "Connect to Google Drive first.", "Upload failed.", or a screen that
never closes.
Evidence: screenshot of the toast; the file in the Drive folder.
Code: `src/lib/drive/driveLibrary.ts:400` (`openDriveUploadFolderPicker`),
`:412` (`selectDriveFolderAndUpload`).

## 19. File operations: move, copy, delete

Goal: the SAF file operations, which only unit tests cover.
Steps: with a local library loaded, swipe a file row left and tap **Delete**,
confirming with the toast's **Delete**. Repeat for **Move** and **Copy**,
choosing a destination and tapping **Move here** or **Copy to folder**.
Expected: delete shows `Delete <name>?` with a **Delete** action, then
`Deleted "<name>".`; move and copy show `Moved "<name>".` / `Copied "<name>".`
and the file appears in the destination; the list refreshes.
Failure: a `Delete failed.` / `Move failed.` / `Copy failed.` toast, or a file
that stays in place.
Expected, not a failure: on a **folder** row the same icons show
`Move on folders is not wired yet.` (`folderOpNotice`); folder ops are a
follow-up.
Evidence: screenshots before and after in the list.
Code: `src/lib/files/fileOps.ts:104`, `:122`, `:152`, `:158`, `:174`.

## 20. Podcast or radio while a music deck is active

Goal: the mix direction the engine allows, and who owns the transport.
Steps: play a podcast episode (or a radio station), then switch to Music and
start a track on Deck B.
Expected: the deck plays without stopping the podcast or radio (Deck B's claim
skips them). Because the deck only claims the global transport when no podcast
or radio is playing (`musicOwnsDisplay`), the MiniPlayer and lock-screen
controls may still drive the podcast, not the deck. Record what the MiniPlayer
shows and what its play/pause affects: this is a read-only observation and the
code does not decide it for you.
Failure: the podcast or radio is stopped by Deck B (it should not be), or the
deck's own play control stops working while mixing.
Evidence: screenshots of the MiniPlayer with the podcast and the Deck B row;
logcat.
Code: `src/lib/stores/mediaEngine.svelte.ts:41`, `Mp3PlayerView.svelte:690`
(`claimMusicControls` gate), `:617`.

## What is most likely to fail, and why

Drawn from the code and the follow-ups in `docs/refactoring-plan.md`. None is
verified; the cases above are how you would check each, and none should be
marked passed until the device says so.

- **The detached `new Audio()` with `preload = 'none'`.** The music deck's
  element is created by `new Audio()` (`src/lib/audio/player.svelte.ts:146`), not
  an in-DOM `<audio>`. Its Android WebView behaviour (autoplay policy, duration
  reporting, background handling) is unverified without a device; this underlies
  cases 3, 4 and 12.
- **No `unregisterAudioSource` in `mediaEngine`.** Views register a stop-callback
  in an effect with no teardown (`Mp3PlayerView.svelte:586`,
  `PodcastView.svelte:166`, `RadioView.svelte:34`). The views stay mounted, so
  the callbacks outlive the effect run, but there is no unregister: watch for a
  stale callback stopping the wrong source after repeated tab or deck switching.
- **SAF playback.** Local files are read through the native directory plugin and
  turned into a File/blob before playback. Cases 1 and 2 cover the picker and the
  restart; case 3 is the first decode of a SAF-backed track.
- **Background resume.** The BG_RECOVERY loop and the 5s watchdog
  (`src/lib/stores/mediaEngine.svelte.ts:637`, `:650`) are the guard against the
  lock/screen-off pause. They depend on the WebView delivering the `document`
  `pause` event and on the process staying alive. Cases 12 and 13 test it.
- **The wakelock and the foreground service.** The native service holds a
  `PARTIAL_WAKE_LOCK` while playing (`MediaPlaybackService.java:215`) and the
  foreground notification keeps the process alive. Both depend on runtime
  permissions and OEM battery policy; the Doze case in 13 can fail for reasons
  outside the code.
- **The podcast transport.** No test plays a podcast. Element events, the
  network-loss reconnect, the OS-initiated pause and the MediaSession metadata
  are verified only by reading and by unit tests of the isolated modules
  (`src/lib/podcast/podcastPlayer.ts`). Cases 6 to 11 are its first real run.
