---
applyTo: "src/lib/stores/**/*.svelte.ts"
description: "Use when editing rune-based store modules. Keep stores typed, isolated from UI, and aligned with the repo's current playback and persistence patterns."
---

# Store Module Rules

- Use rune-based store modules with explicit state and derived values.
- Keep exported function signatures and shared object shapes explicit and typed.
- Avoid `any` and avoid importing UI components into stores.
- Prefer existing persistence helpers, such as `persisted(...)`, over one-off storage logic.
- `mediaEngine.svelte.ts` is the current global playback coordinator. Preserve its coordination role and verify dependent view code when changing playback behavior.
- Keep changes small and local. Do not rewrite store architecture unless the task explicitly asks for it.
- If a store change affects user-visible playback or navigation behavior, update the matching Playwright coverage.