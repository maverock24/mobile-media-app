# Mobile Media App Copilot Instructions

This repository uses SvelteKit 2, Svelte 5 runes, TypeScript, Tailwind CSS 4, Playwright, and Capacitor Android.

## Default Working Rules

- Prefer the live implementation in `src/` over older planning artifacts if they disagree. If `01_PRD.md`, `PROGRESS.md`, or `guardrails.md` drift from the code, follow the code and update the docs when the task naturally includes that cleanup.
- Use Svelte 5 runes for new component logic. Do not introduce legacy `export let` or `$:` syntax in new code.
- Keep TypeScript strict. Avoid `any` unless there is no practical typed alternative.
- Use `$lib/...` imports for internal modules when practical.
- Android APK is the primary product target. Web is the secondary surface used for local preview and Playwright coverage.

## Current Architecture Notes

- `src/lib/stores/mediaEngine.svelte.ts` is the global playback coordination layer.
- View components currently own their own `<audio>` elements and use `claimAudio()` and `registerAudioSource()` for cross-source exclusivity.
- Do not invent or assume a shared `audioService` abstraction unless the task explicitly requires an architectural refactor.
- Persisted browser-backed state should go through the existing persistence helpers and stores, not ad hoc `localStorage` code.

## Validation Expectations

- For code changes, prefer the narrowest validation first: `pnpm check`, then a focused Playwright file such as `pnpm exec playwright test tests/podcast.test.ts`.
- Run broader validation like `pnpm validate` only when the change spans multiple features.
- User-visible behavior changes should usually include or update a Playwright test in `tests/`.

## Agent Workflow Notes

- `.github/instructions/` contains scoped instructions for specific file types.
- `.github/agents/` contains longer planning and research workflows. Do not default to those agents for small maintenance tasks.
- Before framework-specific rewrites, fetch current documentation for Svelte or the relevant library instead of relying on stale model memory.