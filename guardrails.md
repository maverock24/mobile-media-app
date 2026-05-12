# Guardrails — Current Working Rules

This file captures the repo's current implementation boundaries. If it ever disagrees with the live code in `src/`, update this file or treat it as stale until reconciled.

## Coding Standards

### Svelte 5 Conventions
- Use `$state()`, `$derived()`, `$effect()`, and `$props()` for new Svelte logic.
- Do not introduce legacy `export let`, `$:`, `beforeUpdate`, or `afterUpdate` in new code.
- Prefer `$derived.by(() => { ... })` for multi-step derivations.
- Return cleanup functions from `$effect()` when wiring DOM or media listeners.

### TypeScript
- Keep strict typing. Avoid `any` unless there is no practical typed alternative.
- Give exported functions explicit return types.
- Prefer discriminated unions for source-specific models and persisted data shapes.

### File Organization
- Views live in `src/lib/components/views/`.
- Reusable UI primitives live in `src/lib/components/ui/`.
- Rune-based stores live in `src/lib/stores/*.svelte.ts`.
- Pure data models live in `src/lib/models/`.
- Capacitor wrappers live in `src/lib/native/`.

### Imports And Formatting
- Prefer `$lib/...` imports for internal modules when practical.
- Keep Tailwind classes in markup unless a scoped `<style>` block is the clearer choice.
- Use the existing `cn()` utility for conditional class composition when needed.

## Current Architecture

### Playback
- `src/lib/stores/mediaEngine.svelte.ts` is the shared playback coordination layer.
- View components currently own their own `<audio>` elements.
- Cross-source exclusivity currently depends on `claimAudio()` and `registerAudioSource()`.
- Do not assume a shared `audioService` exists. Introducing one is an architectural refactor, not a routine maintenance change.

### Persistence And Networking
- Use existing persisted stores and helpers instead of ad hoc `localStorage` access.
- Use `AbortController` for cancellable fetch-heavy flows such as podcast loading and Drive operations.
- Google Drive playback should continue to use the simpler fetch or blob URL approach rather than reintroducing MSE complexity.

## Forbidden Patterns

### Audio Management
- Do not add a second global playback abstraction beside `mediaEngine` unless the task explicitly requires a redesign.
- Do not introduce unmanaged `URL.createObjectURL()` usage; every object URL must have a cleanup path.
- Do not swallow user-facing playback failures; surface them through `addToast()` when appropriate.

### State Management
- Do not persist playback position by array index when a stable key exists.
- Do not mutate shared podcast collections from overlapping async flows without cancellation or ordering.
- Do not store sensitive OAuth material outside the existing Drive session handling patterns.

### Testing
- Do not skip Playwright coverage for meaningful user-visible behavior changes.
- Do not assert private implementation details when the behavior can be validated through the UI.

## Architecture Boundaries

### Module Import Rules

```
+page.svelte
  ├── can import: views/*, ui/*, stores/*
  └── must NOT import: native/*, google-drive.ts directly

views/*
  ├── can import: ui/*, stores/*, models/*, utils/*, native/*
  └── should not import: other views

ui/*
  ├── can import: other ui components, utils/*
  └── should not import: views/* or native/*
  └── exception: MiniPlayer may read from mediaEngine

stores/*
  ├── can import: other stores, models/*, native/*, utils/*
  └── must NOT import: components

models/*
  └── should remain pure type or model definitions

native/*
  └── should stay limited to Capacitor-facing code and thin wrappers
```

### Data Flow Rules
- Views coordinate playback through their local audio element plus `mediaEngine`.
- `MiniPlayer` and lock-screen integration read shared playback state from `mediaEngine`.
- Settings stores remain the persistence boundary; playback coordination should not invent its own persistence layer.
- `toastStore` is fire-and-forget: modules publish toasts, `ToastContainer` renders them.

## Lessons Learned

_Update this section when architecture decisions change, not only when a bug is fixed._
