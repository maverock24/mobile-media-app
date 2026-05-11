# sv

Everything you need to build a Svelte project, powered by [`sv`](https://github.com/sveltejs/cli).

## Creating a project

If you're seeing this, you've probably already done this step. Congrats!

```sh
# create a new project
npx sv create my-app
```
# Mobile Media App

Mobile Media App is a SvelteKit + Capacitor media hub that combines local MP3 playback, podcast playback, radio streaming, weather, Google Drive-backed music libraries, and Android packaging in a single repository.

## What This Repo Contains

- `src/`: application code, shared UI, stores, native bridges, and routes
- `tests/`: Playwright end-to-end coverage
- `android/`: Capacitor Android project and native plugins
- `static/` and `public/`: static assets and deploy-time resources
- `docs/research/`: archived research notes and exploratory essays
- `.github/workflows/`: CI, Android build, Android release, and deployment automation

The root is intentionally reserved for entry-point project docs and core configuration such as `README.md`, `ROADMAP.md`, `01_PRD.md`, `PROGRESS.md`, `guardrails.md`, `package.json`, and deployment config files.

## Prerequisites

- Node.js 22
- pnpm 10
- Java 21 for Android builds
- Android Studio for native Android work
- Optional: a Google Cloud OAuth client if you want Google Drive playback locally

## Setup

```sh
pnpm install
pnpm dev
```

If you want Google Drive MP3 playback locally, set `PUBLIC_GOOGLE_CLIENT_ID` before starting the app:

```sh
PUBLIC_GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com pnpm dev
```

Typical Google OAuth origins:

- `http://localhost:5173`
- your Netlify production URL
- any custom domain serving this app

## Common Commands

```sh
pnpm dev            # local development server
pnpm build          # production web build
pnpm preview        # preview the web build
pnpm check          # Svelte + TypeScript validation
pnpm test           # Playwright end-to-end tests
pnpm validate       # typecheck + end-to-end tests
pnpm build:mobile   # mobile-oriented static build
pnpm cap:sync:android
pnpm cap:open:android
```

## Repository Conventions

- Source code belongs in `src/`.
- Tests belong in `tests/`.
- Research and exploratory notes belong in `docs/research/`.
- Generated output belongs in ignored directories such as `build/`, `dist-mobile/`, `test-results/`, and `playwright-report/`.
- Local-only helper scripts, logs, and run metadata must stay out of git.
- Keep commits small and single-purpose.
- Use Conventional Commit style for new commits when possible, for example `feat:`, `fix:`, `docs:`, `chore:`.

## Quality Checks

The repo now exposes a single validation entry point:

```sh
pnpm validate
```

GitHub Actions also runs repository quality checks on pushes and pull requests via `.github/workflows/quality.yml`.

## Netlify Deployment

This project uses `@sveltejs/adapter-netlify` for the web deployment path.

- Build command: `pnpm build`
- Publish directory: `build`
- Config file: `netlify.toml`

## Android Packaging

Capacitor Android support lives in `android/`.

```sh
pnpm build:mobile
pnpm cap:sync:android
pnpm cap:open:android
```

Notes:

- mobile builds output to `dist-mobile/`
- web builds output to `build/`
- CI uses Java 21 and Gradle to produce APKs

## CI And Releases

- `.github/workflows/quality.yml`: typecheck + Playwright validation
- `.github/workflows/android-build.yml`: manual debug APK artifact build
- `.github/workflows/android-release.yml`: tagged Android release build
- `.github/workflows/netlify-deploy.yml`: Netlify deployment and Android asset publishing

## Documentation

- `ROADMAP.md`: high-level project direction
- `01_PRD.md`: detailed implementation requirements used by the autonomous agent workflow
- `PROGRESS.md`: implementation ledger for the autonomous workflow
- `guardrails.md`: coding constraints and repo-specific implementation rules
- `docs/research/`: exploratory notes and research artifacts

## Contributing

See `CONTRIBUTING.md` for branch, commit, validation, and review expectations.
- `ANDROID_KEY_ALIAS`
