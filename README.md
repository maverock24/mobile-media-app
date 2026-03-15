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

## GitHub Actions Android artifacts

The repo now includes a GitHub Actions workflow that builds a debug Android APK and uploads it as a workflow artifact.

How to use it:

```sh
git push origin main
```

Or run the `Android Build` workflow manually from the GitHub Actions tab.

After the workflow finishes, download the `media-hub-android-debug-apk` artifact from the workflow run page. The uploaded file is the debug APK produced from:

```text
android/app/build/outputs/apk/debug/app-debug.apk
```

Notes:

- This workflow produces a debug APK for easy device installs and testing.
- For Play Store submission, add a separate signed release workflow that builds an AAB with signing credentials stored in GitHub secrets.

> To deploy your app, you may need to install an [adapter](https://svelte.dev/docs/kit/adapters) for your target environment.
