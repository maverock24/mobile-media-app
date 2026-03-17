# sv

Everything you need to build a Svelte project, powered by [`sv`](https://github.com/sveltejs/cli).

## Creating a project

If you're seeing this, you've probably already done this step. Congrats!

```sh
# create a new project
npx sv create my-app
```

To recreate this project with the same configuration:

```sh
# recreate this project
pnpm dlx sv@0.12.7 create --template minimal --types ts --install pnpm mobile-media-app
```

## Developing

Once you've created a project and installed dependencies with `npm install` (or `pnpm install` or `yarn`), start a development server:

```sh
npm run dev

# or start the server and open the app in a new browser tab
npm run dev -- --open
```

## Google Drive MP3 playback

The music view can now sign in with Google and load MP3 files from the signed-in user's Google Drive.

Setup:

1. Create an OAuth client for a web application in Google Cloud.
2. Enable the Google Drive API for that project.
3. Add your local and deployed origins to the OAuth client.
4. Set `PUBLIC_GOOGLE_CLIENT_ID` before running or building the app.

Example:

```sh
PUBLIC_GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com pnpm dev
```

Typical authorized JavaScript origins:

- `http://localhost:5173`
- Your production Netlify URL
- Any custom domain serving this app

The app requests the readonly Drive scope and downloads MP3 blobs directly in the browser for playback.

## Building

To create a production version of your app:

```sh
npm run build
```

You can preview the production build with `npm run preview`.

## Netlify deployment

This project is configured for Netlify with `@sveltejs/adapter-netlify`.

Build locally:

```sh
pnpm build
```

Deploy on Netlify:

```sh
Build command: pnpm build
Publish directory: build
```

The repo includes a root `netlify.toml`, so Netlify should pick up the correct build settings automatically.

## Android app with Capacitor

This project now includes a Capacitor setup for Android while keeping the existing Netlify web deployment path.

Build the mobile web assets:

```sh
pnpm build:mobile
```

Sync the latest web bundle into the Android project:

```sh
pnpm cap:sync:android
```

Open the generated Android project in Android Studio:

```sh
pnpm cap:open:android
```

Notes:

- The Capacitor config is in `capacitor.config.ts`.
- The Android project lives in the `android/` folder.
- Mobile builds use a dedicated static SvelteKit output in `dist-mobile/`.
- The normal `pnpm build` command still targets the Netlify deployment.

## Netlify-hosted APK updates

The production Netlify deployment can also host the latest Android APK so the web app can offer installs from the Settings view.

How it works:

- The `Publish Android APK Assets` GitHub Actions workflow builds an Android APK on each push to `main`.
- The workflow commits `static/releases/android/latest.apk` and `static/releases/android/latest.json` back into the repository.
- Before committing, the workflow deletes any older APK or manifest files from `static/releases/android`, so only the latest published APK remains in the repo tree.
- Netlify picks up that GitHub commit through its existing repository integration, so GitHub does not deploy to Netlify directly.
- The Settings screen reads that manifest and shows a `Download Latest Android APK` action when a build is available.

Recommended GitHub secrets for repeatable installs and upgrades:

- `ANDROID_KEYSTORE_BASE64`
- `ANDROID_KEYSTORE_PASSWORD`
- `ANDROID_KEY_ALIAS`
- `ANDROID_KEY_PASSWORD`

Repository settings required for the workflow:

- GitHub Actions must be allowed to push commits back to `main`.
- If branch protection blocks bot pushes, allow `github-actions[bot]` or route this workflow through a release branch instead.

Why the Android signing secrets matter:

- Without a stable signing key, CI can only publish debug-signed APKs.
- Debug APKs are fine for fresh installs, but they are not reliable for upgrading an already installed app across separate CI runners.
- With the signing secrets configured, the workflows produce a consistently signed release APK and increment `versionCode` from the GitHub Actions run number.

Operational note:

- This approach keeps only the latest APK file in the repository tree so Netlify serves a single current installer.
- Git history will still contain prior APK versions from older commits unless you later rewrite history.

## GitHub Actions Android artifacts

The repo includes GitHub Actions workflows for both manual Android artifacts and tagged GitHub releases.

How to use it:

Run the `Android Build` workflow manually from the GitHub Actions tab to produce an artifact without deploying.

After the workflow finishes, download the `media-hub-android-debug-apk` artifact from the workflow run page. The uploaded file is the debug APK produced from:

```text
android/app/build/outputs/apk/debug/app-debug.apk
```

Notes:

- The `Android Release` workflow builds a signed release APK when you push a `v*` tag and the Android signing secrets are configured.
- For Play Store submission, add a separate signed release workflow that builds an AAB with signing credentials stored in GitHub secrets.

> To deploy your app, you may need to install an [adapter](https://svelte.dev/docs/kit/adapters) for your target environment.
