# Contributing

## Workflow

- Keep `main` stable.
- Prefer short-lived feature or fix branches over long-running branches.
- Merge only after validation passes.
- Keep each commit atomic: one concern per commit.

## Commit Messages

Use Conventional Commit style when possible:

- `feat: add Google Drive folder switching`
- `fix: prevent stale mini-player metadata`
- `docs: refresh repository setup guide`
- `chore: tighten gitignore for local artifacts`

## Validation Before Opening A PR

Run:

```sh
pnpm validate
```

If you touched Android-only code, also validate the Android build path locally when your environment has Java 21 and Android tooling installed.

## Repository Layout

- `src/` for application code
- `tests/` for end-to-end tests
- `android/` for Capacitor Android code
- `docs/research/` for exploratory notes and research artifacts
- root docs only for project entry points and core governance files

## Do Not Commit

- generated build output
- Playwright reports or test results
- local logs and scratch JSON files
- IDE-specific personal settings
- secrets, tokens, or signing material

## Review Standard

- prefer minimal, targeted changes
- remove dead code instead of commenting it out
- add comments only where logic is genuinely non-obvious
- update docs when commands, workflow, or structure change

## AI Context Upkeep

- If you change architecture, playback flow, persistence patterns, validation commands, or folder conventions, update the matching AI guidance in the same PR.
- Start with `.github/copilot-instructions.md` for repo-wide rules.
- Update the relevant scoped file in `.github/instructions/` when the change is specific to Svelte components, stores, or Playwright tests.
- Keep `guardrails.md` aligned with the code if it is still being used as an active planning document.
- Treat `01_PRD.md` and `PROGRESS.md` as campaign artifacts unless the current work is explicitly using them.
- The repo ships `.mcp.json` with the official Svelte MCP server. Keep secret-bearing or user-specific MCP servers out of git.