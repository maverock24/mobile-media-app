---
applyTo: "tests/**/*.ts"
description: "Use when editing Playwright tests in this repo. Focus on user-visible behavior, stable selectors, and narrow validation runs."
---

# Playwright Test Rules

- Tests in `tests/` are end-to-end Playwright coverage, not unit tests.
- Assert user-visible behavior, persisted outcomes, and recovery paths rather than private implementation details.
- Prefer updating the narrowest relevant suite such as `tests/podcast.test.ts` or `tests/mp3-player.test.ts`.
- Reuse helpers from `tests/helpers.ts` when they fit the scenario.
- Prefer accessible roles, labels, and visible text before brittle CSS selectors.
- For audio flows, drive failures and retries through browser-observable behavior whenever possible.
- After editing a test or its covered behavior, run the narrowest relevant command first before broader suites.