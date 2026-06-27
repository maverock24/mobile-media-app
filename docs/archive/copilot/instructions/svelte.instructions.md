---
applyTo: "src/**/*.svelte"
description: "Use when editing Svelte components in src/. Prefer Svelte 5 runes, TypeScript, $lib imports, and the repo's current media playback patterns."
---

# Svelte Component Rules

- Use `<script lang="ts">` in components.
- Use Svelte 5 runes for new logic: `$state`, `$derived`, `$effect`, `$props`, and `$bindable` when binding is intentional.
- Do not introduce legacy `export let`, `$:`, `beforeUpdate`, or `afterUpdate` in new code.
- Prefer `$derived.by(...)` for multi-step derivations and return cleanup functions from `$effect`.
- Use `$lib/...` imports for internal modules when practical.
- Keep styles in markup with Tailwind utility classes unless a scoped `<style>` block is genuinely the better fit.
- Follow the existing boundaries in `src/lib/components/views/` and `src/lib/components/ui/` rather than creating hybrid files.
- If you touch playback UI, preserve the current architecture: views still own local audio elements and coordinate shared playback state through `mediaEngine`.
- Pair user-visible behavior changes with focused Playwright coverage when practical.