# Mobile Media App — Agent Context

SvelteKit + Capacitor mobile media hub: local MP3 playback, podcasts, radio, weather, Google Drive music libraries, Android APK packaging.

## Source of truth

The live code in `src/` is authoritative. Planning docs (`01_PRD.md`, `PROGRESS.md`, `ROADMAP.md`, `guardrails.md`) are historical — if they disagree with code, follow the code. **Do not read them unless explicitly asked.**

## Architecture map

| Area | Path |
|---|---|
| SvelteKit app shell | `src/app.html`, `src/app.d.ts`, `src/app.css` |
| Routes / API endpoints | `src/routes/` (`api/podcast/{feed,search,lookup}`, `api/radio/search`, `essays`) |
| Svelte 5 rune stores | `src/lib/stores/*.svelte.ts` — `mediaEngine` (playback core, 821L), `library`, `settings`, `googleDriveSession`, `sleepTimer`, `toastStore`, `runtimeDiagnostics`, `driveConfigSync`, `history`, `mixerShared` |
| UI components | `src/lib/components/views/*` (feature screens), `src/lib/components/ui/*` (primitives) |
| Google Drive | `src/lib/google-drive.ts` (API), `src/lib/google-drive-native.ts` (Android bridge), `src/lib/drive-config.ts`, `src/lib/google-drive-auth-error.ts` |
| Audio | `src/lib/audio/fileResolver.ts`, `src/lib/audio/equalizer.ts` |
| Native bridges (Android/Capacitor) | `src/lib/native/*` (`haptics`, `directory-reader`, `media-controls`) |
| Models | `src/lib/models/` (`media`, `music`, `browse`) |
| Utils | `src/lib/utils/`, `src/lib/persisted.svelte.ts` |
| Android project | `android/` (Capacitor + native plugins) |
| Tests (Playwright E2E) | `tests/` (~3,173 lines; `*.test.ts`) |
| CI | `.github/workflows/` (`quality`, `android-build`, `android-release`, `netlify-deploy`) |

## Conventions

- **Svelte 5 runes only**: `$state`, `$derived`, `$derived.by`, `$effect`, `$props`. No legacy `export let` / `$:` / `beforeUpdate` / `afterUpdate`.
- **TypeScript strict**: no `any` unless no practical alternative; exported functions get explicit return types; discriminated unions for source/persisted models.
- **Imports**: `$lib/...` for internal modules.
- **File org**: views → `src/lib/components/views/`, UI primitives → `src/lib/components/ui/`.
- **Commits**: small, single-purpose, Conventional Commit style (`feat:`, `fix:`, `docs:`, `chore:`).

## Commands

```sh
pnpm dev           # dev server (Node 22, pnpm 10)
pnpm check         # Svelte + TypeScript validation
pnpm test          # Playwright E2E
pnpm validate      # typecheck + E2E (single entry point)
pnpm build         # web build → build/
pnpm build:mobile  # mobile static build → dist-mobile/
pnpm android:doctor  # Java/toolchain + Android OAuth fingerprints
pnpm repo:check      # fail if Drive/APK setup incomplete
```

**Primary product target: Android APK.** Web is secondary (local preview + Playwright coverage).

## Ignore lists (avoid reading/grepping)

- **Build/output** (gitignored): `android/app/build`, `.gradle`, `.svelte-kit`, `.netlify`, `dist-mobile`, `build`, `playwright-report`, `test-results`, `tmp-test-files`
- **VS Code Copilot agent defs** (not used by Pi): `.github/agents/*.md`, `.github/instructions/*.instructions.md`, `.github/copilot-instructions.md`
- **Historical planning docs**: `01_PRD.md`, `PROGRESS.md`, `ROADMAP.md`, `guardrails.md` — read only on explicit request.

## Google Drive / Android auth

Drive playback in the APK uses a native Google Play Services bridge (not WebView OAuth). Requires an Android OAuth client in Google Cloud for package `com.maverock24.mobilemediaapp` with the APK signing key's SHA-1/SHA-256. `pnpm android:doctor` prints the fingerprints. Web OAuth needs `PUBLIC_GOOGLE_CLIENT_ID`.
