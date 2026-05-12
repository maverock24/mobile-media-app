---
applyTo: ".github/**/*.md"
description: "Use when editing GitHub Copilot instructions, custom agents, PR templates, or other markdown governance files under .github/. Keep them aligned with the live repo and avoid generic autonomous-workflow drift."
---

# AI Governance Rules

- Treat the live codebase and current repo docs as the source of truth, not older aspirational plans.
- Keep agent descriptions narrow and repo-specific. Do not describe generic full-stack or autonomous workflows unless the file is explicitly meant for that purpose.
- Do not instruct agents to use destructive git commands, unconditional commits, or unconditional pushes.
- When editing agent or instruction files, make sure the behavior they prescribe matches the current stack: SvelteKit, Svelte 5 runes, Playwright, Capacitor Android, and the current playback architecture.
- Prefer concise instructions that reduce ambiguity instead of large generic templates.
- If you demote a planning file to historical status, update nearby discovery surfaces such as `README.md`, `CONTRIBUTING.md`, PR templates, or agent descriptions so contributors are not told conflicting things.
- Keep secrets, personal machine configuration, and user-specific MCP servers out of repo-tracked governance files.