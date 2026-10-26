# Work tree: ab-pairings

- **Slug**: ab-pairings
- **Worktree**: `/home/maverock24/github/mobile-media-app-pairs`
- **Branch**: `qrspi/ab-pairings`, from `main` at `0d76e3a`
- **Commit trailer**: `QRSPI: ab-pairings`
- **Gate per task**: `pnpm check && pnpm test`; `pnpm test:e2e` once before the final commit
- No Java or `android/` work in this effort.

One task per plan phase, one commit per task.

| Task | Phase | Files | Blocked by |
|---|---|---|---|
| T1 | S1 per-queue loop mode | `src/lib/audio/player.svelte.ts`, its test | none |
| T2 | S4 pairings store + refs | new `src/lib/pairs/*.ts` (store, resolve, name), tests | none |
| T3 | S5 Pairs sub-tab shell | `src/routes/+page.svelte`, new `src/lib/components/views/PairsView.svelte`, `mediaEngine` view type if forced | none |
| T4 | S2 start at a position | `src/lib/audio/player.svelte.ts`, its test | T1 |
| T5 | S6 rows, delete, empty state | `PairsView.svelte`, its test seam | T2, T3 |
| T6 | S3 deck command registry | new `src/lib/stores/deckCommands.svelte.ts`, `Mp3PlayerView.svelte`, `player.svelte.ts` (`setLoop`) | T1, T4 |
| T7 | S7 start a scene | `PairsView.svelte`, `deckCommands`, `resolvePairingTrack` | T6, T2 |
| T8 | S8 position writer | new `src/lib/pairs/positionWriter.ts`, `Mp3PlayerView.svelte`, tests | T6, T7 |
| T9 | S9 save semantics | `pairs` store (`upsertPairing`, `derivePairingName`), `PairsView.svelte` | T2, T5, T6 |

## Waves (no two workers on one file at once)

- **Wave 1**: T1, T2, T3 (disjoint: player, new pairs modules, shell).
- **Wave 2**: T4 (player), T5 (panel, after T2/T3).
- **Wave 3**: T6 (registry plus the view).
- **Wave 4**: T7.
- **Wave 5**: T8 and T9 (disjoint: position writer versus store and save button).

## Risk

T1 is the riskiest: the loop mode lives in the shared advance path that both decks and the MiniPlayer depend on. T6 is the largest: a new registry plus the 2,500-line view.
