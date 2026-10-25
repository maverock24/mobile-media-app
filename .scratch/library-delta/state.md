# library-delta

- **Slug**: library-delta
- **Stage**: PR (branch ready, awaiting the human)
- **Critical**: no
- **Done**: Questions, Research, Design, Structure, Plan, Work Tree, Implement, PR review and two fix rounds

## Gate

- `pnpm check`: 0 errors, 0 warnings
- `pnpm test`: 809 passed, 9 skipped
- `pnpm test:e2e`: 12 passed, 5 skipped
- Branch `qrspi/library-delta`, worktree `/home/maverock24/github/mobile-media-app-delta`, 18 commits on top of `main` at `1c4347e`.

## What the two review rounds changed

First review found: the warm-start delta never ran on the mount path (A1 failed), a flat library could never delta, the merge used a stale snapshot, a skipped-count-without-paths walk pruned anyway, `completed` was hardcoded. Second review found: the full-walk branch still trusted unverified walks and recorded unreadable directories as walked.

All fixed in T11 to T16, each with tests and, where the worker could manage it, a mutation check that reinstates the bug and watches the test fail.

## Known limitations, stated plainly

1. **The mtime assumption is unproven on real hardware.** Android documents `COLUMN_LAST_MODIFIED` as nullable and only optionally updated, and no Android doc promises a directory's mtime tracks its children. The conservative rule (skip only on a known, unchanged mtime) plus the 7-day full walk plus Rescan is the mitigation. `docs/device-verification.md` section 21 is the probe that settles it.
2. **No Java test exists** (the repo has no Java test target), so the skip rule, the root-row read and the probe are verified by source reading, the CI compile plus dex assertion, and the device run.
3. **A delete that lands in the same microtask window as a delta publish** can resurrect one row until the next walk.
4. **A rename is still removed-plus-added**, because identity is `relativePath` (out of scope).

## Next

The human reads the diff. Nothing is pushed and `main` is untouched.
