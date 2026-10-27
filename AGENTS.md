# Mobile Media App — Agent Context

SvelteKit + Capacitor mobile media hub: local MP3 playback, podcasts, radio, weather, Google Drive music libraries, Android APK packaging.

## Source of truth

The live code in `src/` is authoritative. Planning docs (`01_PRD.md`, `PROGRESS.md`, `ROADMAP.md`, `guardrails.md`) are historical — if they disagree with code, follow the code. **Do not read them unless explicitly asked.**

## Architecture map

| Area | Path |
|---|---|
| SvelteKit app shell | `src/app.html`, `src/app.d.ts`, `src/app.css` |
| Routes / API endpoints | `src/routes/` (`api/podcast/{feed,search,lookup}`, `api/radio/search`, `essays`) |
| Svelte 5 rune stores | `src/lib/stores/*.svelte.ts` — `mediaEngine` (playback core, 832L), `settings`, `googleDriveSession`, `musicView`, `sleepTimer`, `toastStore`, `youtubePanel`, `runtimeDiagnostics`, `library` (types only) |
| UI components | `src/lib/components/views/*` (feature screens), `src/lib/components/ui/*` (primitives) |
| Google Drive | `src/lib/google-drive.ts` (API), `src/lib/google-drive-native.ts` (Android bridge), `src/lib/google-drive-auth-error.ts`, `src/lib/drive/` (extracted modules, currently `driveSession.svelte.ts`) |
| Audio | `src/lib/audio/player.svelte.ts` (per-deck player), `src/lib/audio/fileResolver.ts`, `src/lib/audio/equalizer.ts` |
| Native bridges (Android/Capacitor) | `src/lib/native/*` (`haptics`, `directory-reader`, `media-controls`, `youtube-audio`, `screen-dim`) |
| Browse / library | `src/lib/browse/*` (`folderScan` holds the listing cascade, `libraryCache` the IndexedDB cache), `src/lib/device/*` (per-deck library state, rescan) |
| Models | `src/lib/models/` (`media`, `music`, `browse`) |
| Utils | `src/lib/utils/`, `src/lib/persisted.svelte.ts` |
| Android project | `android/` (Capacitor + native plugins) |
| Tests | `tests/` (11,859 lines: `tests/unit` is vitest, `tests/e2e` is Playwright) |
| Decisions & specs | `docs/adr/` (decisions), `docs/state/` (runtime state machines), `docs/device-verification.md` (device checks) |
| CI | `.github/workflows/` — `quality` (check + unit + E2E) runs on push and pull request; `netlify-deploy` compiles `android/` and builds the APK on every push to main; `android-release` on version tags; `android-build` is a manual debug-APK button. No workflow compiles Java on a pull request. |

## Conventions

- **Svelte 5 runes only**: `$state`, `$derived`, `$derived.by`, `$effect`, `$props`. No legacy `export let` / `$:` / `beforeUpdate` / `afterUpdate`.
- **TypeScript strict**: no `any` unless no practical alternative; exported functions get explicit return types; discriminated unions for source/persisted models.
- **Imports**: `$lib/...` for internal modules.
- **File org**: views → `src/lib/components/views/`, UI primitives → `src/lib/components/ui/`.
- **Commits**: small, single-purpose, Conventional Commit style (`feat:`, `fix:`, `docs:`, `chore:`). Push to `origin/main` in the same turn as the commit. No waiting to be asked.
- **Review: an effect must not read the state it writes.** A `$effect` or `$derived` that reads the same `$state` it writes loops until Svelte throws `effect_update_depth_exceeded`, after which every click in the app does nothing. `pnpm check` and the whole unit suite stay green; only `pnpm check:boot` fails. Look for it in the diff, not in the test output.
- **Review: a persisted write must justify its value.** Any writer that stamps a shared persisted field (`completedAt`, `lastFolderName`, a playback position) must name where that value came from. Two real bugs came from writers inventing one: a walk that never completed stamped a completion time, and starting a scene wrote the literal `"Pairings"` into the library folder label.

## Commands

```sh
pnpm dev           # dev server
pnpm check:boot    # Playwright smoke only: the per-commit gate
pnpm validate      # check + unit + E2E: the gate to run before merging to main
pnpm build:mobile  # mobile static build → dist-mobile/ (the APK target)

pnpm test:changed  # only the unit tests the current change can affect
pnpm test:e2e:warm # E2E against a preview that persists; builds only when stale
```

Every other script lives in `package.json`. Note `pnpm test` is vitest only; the
Playwright suite is `pnpm test:e2e`.

`pnpm test:changed` selects through Vite's module graph, so there is no map to
maintain. When no unit test imports the changed files it runs the full suite
rather than reporting green having executed nothing. It is an inner-loop tool:
`pnpm validate` and CI still run everything.

`pnpm test:e2e:warm` keeps a preview server between runs and rebuilds it whenever
`src/` is newer than the build, so a warm run never tests replaced code. It leaves
the server up; `pnpm test:e2e:warm --stop` ends it.

**E2E covers Music, the app shell and YouTube only** (`tests/e2e/`). Podcasts, Radio and Weather have no E2E coverage, so a change to those views needs a browser check by hand, seeded through the `persisted()` localStorage keys.

**Primary product target: Android APK.** Web is secondary (local preview + Playwright coverage).

## Ignore lists (avoid reading/grepping)

- **Build/output** (gitignored): `android/app/build`, `.gradle`, `.svelte-kit`, `.netlify`, `dist-mobile`, `build`, `playwright-report`, `test-results`, `tmp-test-files`
- **Historical**: `docs/archive/`, and the planning docs `01_PRD.md`, `PROGRESS.md`, `ROADMAP.md`, `guardrails.md`. Live material is under `docs/`, see the map above.

## Google Drive / Android auth

Drive playback in the APK uses a native Google Play Services bridge (not WebView OAuth). Requires an Android OAuth client in Google Cloud for package `com.maverock24.mobilemediaapp` with the APK signing key's SHA-1/SHA-256. `pnpm android:doctor` prints the fingerprints. Web OAuth needs `PUBLIC_GOOGLE_CLIENT_ID`.
