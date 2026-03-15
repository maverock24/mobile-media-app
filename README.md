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

> To deploy your app, you may need to install an [adapter](https://svelte.dev/docs/kit/adapters) for your target environment.
