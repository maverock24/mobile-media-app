# ab-pairings

- **Slug**: ab-pairings
- **Stage**: PR (branch ready, awaiting the human)
- **Critical**: no
- **Done**: Questions, Research, Design, Structure, Plan, Work Tree, Implement, PR review and two fix rounds

## Gate

- `pnpm check`: 0 errors, 0 warnings
- `pnpm test`: 868 passed, 9 skipped
- `pnpm test:e2e`: 14 passed, 5 skipped
- Branch `qrspi/ab-pairings`, worktree `/home/maverock24/github/mobile-media-app-pairs`, 13 commits on top of `main` at `0d76e3a`.

## What review caught, and what the fix round changed

1. **The branch broke the whole app at boot.** The deck registry read and wrote the same `$state` inside one effect, so Svelte threw `effect_update_depth_exceeded` and every tab click stopped working. Six E2E tests failed; unit tests could not see it. Fixed with one state slot per deck and a write that never reads, plus a regression test that registers inside a real `$effect`.
2. **Starting a scene relabelled the library.** `beginQueue('Pairings')` wrote that string into the persisted `lastFolderName`, so Settings, the reconnect banner and the cache key all said "Pairings" after one tap. Fixed by making the folder optional on `beginQueue`.
3. **A scene saved while playing never followed its position**, and **a finished book persisted position 0** at the cross-source stop seam. Both fixed, with tests for each direction (`does not persist a zero from a halt`, `persists a deliberate seek to zero`).

## Known limitations, stated plainly

1. **Deck B cannot be un-looped from the UI while a scene is playing.** A scene loads B with `loop: 'one'`, which wins over the MiniPlayer toggle by design (D2). `Player.setLoop` exists for it but has no production caller.
2. **Applying a scene writes the global `deckBVolume` and `deckBSpeed`.** That is what "remember the atmosphere" means, but it also means the sliders move.
3. **Saving from the Pairs header has no automated test.** The seam is component-local and the web build cannot start a scene; the rule inside it (`activateSavedScene`) is tested.
4. **The APK is the only place the full loop can be checked**: save a scene mid-book, close the app, reopen, tap it, confirm A resumes and B loops.

## Next

The human reads the diff. Nothing is pushed and `main` is untouched.
