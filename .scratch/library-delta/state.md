# library-delta

- **Slug**: library-delta
- **Stage**: Plan (done, awaiting release) → Implement
- **Critical**: no
- **Done**: Questions, Research (42/42), Design (D1 to D13), Structure (S1 to S10), Plan (P1 to P10)
- **Blocked**: release answer (`qrspi_release`) before any code is written

## Where the work stands

- The design needed one correction: "always full on Rescan" (your answer) and "a rescan walks only new or unknown directories" cannot both hold while Rescan is the only trigger. Fixed by adding the warm-start delta trigger and keeping Rescan a full walk. Recorded under D1 in `tree.md`.
- The Plan subagent returned no output and wrote nothing; `plan.md` was written in the main window from `outline.md`.
- Native code has no automated check available: no Java test target exists, so the Java half of P1/P3/P7 leans on the gradle compile, the CI dex assertion, and the P7 on-device probe.

## Next

On release: create `.worktrees/library-delta` from `main` at `1c4347e` on branch `qrspi/library-delta`, copy `.scratch/library-delta/` in, then implement P1 to P10 one worker per phase, gate `pnpm check && pnpm test` per commit, `pnpm test:e2e` before the final one.
