# Android performance measurement

This is the timing pass. `docs/device-verification.md` is the functional pass: 20 cases about whether
a feature works, with no numbers in it. This document is the other half, the procedure that
`docs/performance-analysis.md` sets out in its measurement plan (M0 to M6). Read the report for the
findings; run this to give them numbers.

None of this runs in CI, and none of it has been run for this repository yet. The commands come from
the Android, Perfetto and Simpleperf documentation, checked against the code in this tree. The values
are yours to produce.

## What CI already proves, and what it does not

`.github/workflows/quality.yml` has a second job, `android-release-compile`, that runs on every pull
request and on every push to `main`. It:

- runs `./gradlew assembleRelease`, so the release variant compiles with R8 and resource shrinking
  on. This is the only automated guard against a shrinker or native regression merging silently;
- runs `./gradlew :app:assembleBenchmark :benchmark:assembleBenchmark`, so the benchmark build type
  and the benchmark module compile;
- unzips `android/app/build/outputs/apk/benchmark/app-benchmark.apk`, reads the minified DEX with
  `dexdump` and fails the job unless `DirectoryReaderPlugin`, `GoogleDriveNativePlugin`,
  `MediaControlsPlugin`, `ScreenDimPlugin` and `YoutubeAudioPlugin` are all present, each with a
  no-arg constructor, and all 26 `@PluginMethod` names survive;
- uploads the benchmark APK as the `app-benchmark-apk` artifact, because the unsigned release APK
  built without signing secrets is not installable.

The DEX step is the automated guard for the one known R8 risk: Capacitor builds plugins with
`getDeclaredConstructor().newInstance()`, and the shrinker is free to drop a constructor the class
keeps. It is not a substitute for the device run. It proves the class is in the DEX, not that the app
starts, and it says nothing about timing.

The other Android workflows prove nothing about performance: `android-release.yml` builds and
publishes the signed release on a `v*` tag and uploads `mapping.txt`; `netlify-deploy.yml` publishes
a release on a push to `main` when the signing secrets are present, and otherwise publishes the debug
build as `latest-debug.apk` without touching `latest.apk` or `latest.json`; `android-build.yml` is the
manual debug-APK button.

No job in this repository attaches a device, an emulator or a benchmark run, and GitHub-hosted runners
have neither. Everything below is a manual run on your hardware.

## Before you start

You need a physical device with USB debugging enabled, `adb` on the path, an Android SDK that can
compile this project (platform 36) and a Java 21 toolchain, which `android/app/build.gradle` pins.
Confirm the device is visible and that Gradle resolves before going further:

```sh
adb devices
cd android && ./gradlew --version
```

Record the device and the OS build. A number without them is not a measurement:

```sh
adb shell getprop ro.product.model
adb shell getprop ro.build.version.release
adb shell getprop ro.build.fingerprint
```

### Calibration and the A/B rule

- An A/B comparison happens on the same device and the same OS build. A number from a different
  device, or from the same device after an OS update, is a new baseline rather than a delta.
- Run the device off the charger or on it consistently, and say which. Charging changes the thermal
  and frequency behaviour.
- `lockClocks` exists for microbenchmarks, where a single CPU-bound block is timed in isolation.
  Macrobenchmark deliberately does not expose it. Do not lock clocks for a launch, a
  duration-of-use or a jank test: it pins a device state no user is in, and the benchmark guidance
  says the same.
- The benchmark's own run configuration is part of the baseline. Record the `CompilationMode` and the
  iteration count with the number (section 1).

### Put the app in a known compile state

```sh
adb shell cmd package compile -m speed -f com.maverock24.mobilemediaapp
```

This precompiles the installed package ahead of time, which is what makes two manual runs
comparable. It matters for the Perfetto, Simpleperf and Memory Profiler sections, which reset
nothing. It does not matter for the macrobenchmark run in section 1: that run applies its own
`CompilationMode`, which resets compilation first and recompiles according to the mode.

## 1. Startup: the macrobenchmark

`android/benchmark/` is a `com.android.test` module. `:app` has a `benchmark` build type that is
`initWith(release)`: same R8-minified, resource-shrunk output, but signed with the debug key so it
installs without the release keystore and is not debuggable. That is the build to measure.

### Build and install

```sh
pnpm cap:sync:android
cd android
./gradlew :app:assembleBenchmark :benchmark:assembleBenchmark
```

The APK lands at `android/app/build/outputs/apk/benchmark/app-benchmark.apk`. The run below installs
both APKs itself; install by hand only when you want to drive the app for the other sections:

```sh
adb install -r android/app/build/outputs/apk/benchmark/app-benchmark.apk
```

### Run

```sh
cd android
./gradlew :benchmark:connectedBenchmarkAndroidTest
```

A plain `connectedCheck` is not the documented path here. The module declares a `benchmark` build
type, and `connectedBenchmarkAndroidTest` is the task that targets the benchmark variant of `:app`;
`connectedCheck` would run the module's default variant instead.

### What it measures

`android/benchmark/src/main/java/com/maverock24/mobilemediaapp/StartupBenchmark.java` holds three
tests, `startupCold`, `startupWarm` and `startupHot`, each a `StartupTimingMetric` measurement over
5 iterations with `CompilationMode.DEFAULT`. Each iteration reports two numbers:

- `timeToInitialDisplayMs`: launch intent to the first frame the system draws.
- `timeToFullDisplayMs`: launch intent to the app's own `reportFullyDrawn()` call. The root layout
  fires that through `ScreenDim.reportFullyDrawn()` when the SvelteKit shell hydrates
  (`src/routes/+layout.svelte:50`), so it marks the first frame the user can interact with.

Expect TTFD to be larger than TTID. If the two are equal, the hydration signal did not fire and the
"fully drawn" number is really the first frame.

### Reading the results

The console prints the minimum, median and maximum of each metric, in lines such as:

```
StartupTimingMetric[startup=cold]
    timeToInitialDisplayMs   min 258.0,   median 267.2,   max 280.3
    timeToFullDisplayMs      min 300.1,   median 312.4,   max 331.0
```

The library computes P50, P90, P95 and P99 for every metric, but it only serialises the percentiles
for sampled metrics such as `FrameTimingMetric`. `StartupTimingMetric` is a single-value metric, so
its JSON entry carries `minimum`, `maximum`, `median`, `coefficientOfVariation` and the raw `runs`
array, and nothing else. With 5 iterations there is no meaningful P95 or P99 to read locally. Record
the median. Startup P95 and P99 are field numbers, and they come from Play Console (section 5).

If you want a local distribution, raise `ITERATIONS` in `StartupBenchmark.java`, rerun, and read the
`runs` array out of the JSON.

The JSON report and one `.perfetto-trace` per iteration are copied to the host at:

```
android/benchmark/build/outputs/connected_android_test_additional_output/benchmarkAndroidTest/connected/<device-serial>/
```

The JSON is named `com.maverock24.mobilemediaapp-benchmarkData.json`. Open the traces in the Perfetto
UI or Android Studio; the aggregate says something moved, a trace says what moved.

Two properties of the run belong next to the number:

- `CompilationMode.DEFAULT` is `Partial(baselineProfileMode = UseIfAvailable, warmupIterations = 0)`.
  This app ships no baseline profile and no `androidx.profileinstaller`, so there is nothing to
  install and the reset leaves the app with no AOT-compiled code. These are the startup numbers of a
  build without a baseline profile, which is what ships today, in the least flattering light.
- On a user build below Android 14 the profile reset reinstalls the package, which clears app data.
  Expect the welcome screen rather than your saved folder.

## 2. Perfetto: what happened inside one run

Perfetto collects a system trace across processes, which is what you need here: on Android 8.0 and
newer the WebView renderer runs in a separate sandboxed process, so the JavaScript work is not in the
app process (see the memory section below for the same split). Use it when an aggregate number moved.

The documented helper script pulls the trace and opens it for you:

```sh
curl -O https://raw.githubusercontent.com/google/perfetto/main/tools/record_android_trace
python3 record_android_trace -o trace.perfetto-trace -t 10s -b 32mb -a '*' sched freq view ss input
```

Start it, then launch the app while the ten seconds run.

The on-device binary is the same capture without the helper:

```sh
adb shell perfetto -o /data/misc/perfetto-traces/trace.perfetto-trace -t 10s -b 64mb \
  sched freq idle am wm gfx view dalvik input
adb pull /data/misc/perfetto-traces/trace.perfetto-trace
```

If that output path is not writable, write to `/data/local/tmp/` and pull from there. Open the file
at `ui.perfetto.dev`.

Where to look, following `docs/performance-analysis.md`:

- the app process main thread during the first second or two, which covers the plugin registration
  and the asset reads that run before the first `loadUrl` (S4) plus the import-time bridge calls
  (S2);
- the renderer process, for the boot-route hydration work (S1);
- the `MediaPlaybackService` and its background thread over a minute of playback, where the
  notification path repeats every 3 seconds (L1).

## 3. Simpleperf: where the CPU time goes

Simpleperf samples the process you name. Two documented paths.

The NDK scripts handle the binary, the ABI and the report:

```sh
# from $ANDROID_NDK_HOME/simpleperf/
python3 app_profiler.py -p com.maverock24.mobilemediaapp -a .MainActivity -r "-g --duration 10"
python3 report_html.py
```

`app_profiler.py` starts the activity, records, and copies `perf.data` to the host;
`report_html.py` writes a browsable report.

The device's own binary is the smaller path:

```sh
adb shell simpleperf record -g --app com.maverock24.mobilemediaapp --duration 10 \
  -o /data/local/tmp/perf.data
adb pull /data/local/tmp/perf.data
adb shell simpleperf report -g -i /data/local/tmp/perf.data
```

Requirements: Android 10 or newer, the `<profileable android:shell="true" />` element in the
manifest (added by M0), and Simpleperf present on the device. Check it with
`adb shell simpleperf --help`; if it is missing, use the NDK copy instead. With `-g` on Android 9 and
newer the call graph includes interpreted and JITed Java frames, which matters because most of this
app is Java and WebView glue.

One caveat that shapes what you can see. `-p` and `--app` select a process, and the WebView renderer
is a separate sandboxed process, so a recording of the app package covers the Java and glue work and
misses the JavaScript. Recording the renderer needs a device-wide recording, which needs root; on an
unrooted device use Perfetto for that half.

## 4. Memory Profiler

This app is a WebView, so memory splits across two processes and the split decides the tool. Read the
architecture first, because it changes what a heap dump can tell you:

- The host (browser) process is the app process. Your Activity and Java code run here.
- The isolated renderer process, a sandboxed `SandboxedProcessService`, parses HTML and CSS, runs
  JavaScript and renders. Most WebView memory, including the DOM tree, rendered graphics and the
  JavaScript runtime, is native memory in that process.
- A Java heap dump (`.hprof`) shows a lightweight Java wrapper object for a WebView and does not
  capture the real web content memory. Use it for Java-side leaks, not for the renderer.

### The renderer process, from the command line

```sh
adb shell dumpsys activity processes com.maverock24.mobilemediaapp | grep "Isolated.*SandboxedProcessService"
adb shell dumpsys meminfo <renderer-pid>
adb shell dumpsys meminfo com.maverock24.mobilemediaapp
```

The first command prints the isolated process record including its PID. The second reports the
renderer's memory, the third the host. For the anonymous allocation tags behind the numbers:

```sh
adb shell "cat /proc/$(pidof com.maverock24.mobilemediaapp)/maps" | grep "anon:"
```

### The Java heap, through Android Studio

`Android Studio > Profiler` can attach to a running profileable app on Android 10 or newer for the
low-overhead memory timeline. A heap dump and allocation recording need a debuggable app, which the
benchmark build is not:

```sh
pnpm cap:sync:android
cd android && ./gradlew installDebug
```

Then start the debug build with `Profile 'app' with complete data`, open the Memory tab, play for the
length of the journey you care about, and capture a heap dump. Export the recording and convert it
with the platform-tools tool if you take it to another analyzer:

```sh
$ANDROID_HOME/platform-tools/hprof-conv heap-original.hprof heap-converted.hprof
```

The debug build is slower than what ships, so treat these numbers as directional. That is enough for
the suspected Java-side suspects: the toast array (L3), `rssCache` (L4) and the Drive folder map (L7).
Look for an object count that climbs and never falls across a three-hour playback journey, and for
the interval between GCs, not for a single heap size.

### The wakelock check

```sh
adb shell dumpsys batterystats --charged com.maverock24.mobilemediaapp
```

The L2 finding is a screen wakelock held while playback is paused. Play, pause, lock the screen, wait,
then read the wakelock section and look for a lock still held.

## 5. Play Console field baseline: not filled in

This slot is empty on purpose. No agent can authenticate to Play Console, and no repository automation
can read it, so these values can only come from the account holder. Fill them in by hand, once per
release, and commit the result.

Where to read: Play Console, select the app, then `Monitor and improve > Android vitals`, on the
startup page for the startup rows and the rendering page for the frame row. Take one data window and
write the window next to the numbers.

| Metric | Value |
|---|---|
| Data window (dates) and release version | **not filled in** |
| Cold start time, median (ms) | **not filled in** |
| Cold start time, P90 (ms) | **not filled in** |
| Cold start time, P95 (ms) | **not filled in** |
| Cold start time, P99 (ms) | **not filled in** |
| Warm start time, median / P95 / P99 (ms), if shown | **not filled in** |
| Hot start time, median / P95 / P99 (ms), if shown | **not filled in** |
| Frame render time, P50 / P90 / P95 / P99 (ms), if shown | **not filled in** |

Two notes for whoever fills this in:

- Play Console does not show every percentile for every metric, and the startup page may show a single
  high percentile rather than the full set. Record what the page shows and write "not shown" in the
  rest. Do not guess a value.
- These are the only real-user P95 and P99 startup numbers available. The local macrobenchmark in
  section 1 runs 5 iterations and cannot stand in for them.

## 6. Retracing an obfuscated crash (R8)

R8 is on for release, so a stack trace from a shipped build names obfuscated classes. The mapping file
is the key, and the release workflows now keep it. On a `v*` tag, `android-release.yml` uploads
`android/app/build/outputs/mapping/release/mapping.txt` as the `mapping.txt` artifact; on a push to
`main`, `netlify-deploy.yml` does the same, guarded so the debug fallback does not try. A local
benchmark build writes its own mapping to
`android/app/build/outputs/mapping/benchmark/mapping.txt`.

Retrace locally with the SDK's tool, installed with the command-line tools at
`cmdline-tools/<version>/bin/retrace`:

```sh
retrace mapping.txt obfuscated-trace.txt --verbose
```

With no trace file on the command line, `retrace` reads the trace from standard input, and writes the
retraced trace to standard output. Open the artifact from the tag run, or the file in `build/outputs`,
and pick the one that matches the version that crashed.

For the Play Console side, upload `mapping.txt` for each released version under the app's version in
`Test and release > App bundle explorer` (see Play Console Help, "Deobfuscate or symbolicate crash
stack traces"). Only crashes that happen after the upload are deobfuscated, so the mapping file has to
go up with the release, not with the bug report.

The repo's own `android/app/proguard-rules.pro` has no `-keepattributes` rule of its own, and the
`SourceFile,LineNumberTable` line in it is commented out. If a retraced trace needs line numbers,
add that rule in the same commit that changes any release and upload the new mapping file.

## 7. What this procedure cannot do

Stated plainly, because it is the honest limit of the whole effort:

- The macrobenchmark run needs an Android device that this repository's automation does not have.
  Nothing in CI runs `connectedBenchmarkAndroidTest`, and no runner has a device. Running it is
  yours.
- The Play Console baseline needs account access that no agent here has, so section 5 stays empty
  until a human fills it in.
- The measured build has no baseline profile, so these startup numbers are the no-baseline-profile
  case.
- Jank measurement (M2) and the memory instrumentation (M4) are separate workstreams. This document
  only gives the tools for them; it does not add either.
