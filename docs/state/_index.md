# State Machine Inventory

| # | Machine | Purpose | States | Source | Spec |
|---|---------|---------|--------|--------|------|
| 1 | Audio Playback Lifecycle | Now-playing state hub across Music, Podcast, Radio, Mixer; audio exclusivity, stream reconnect, Android background recovery, per-deck state (A/B) for simultaneous dual-deck playback | 5 | `src/lib/stores/mediaEngine.svelte.ts` | [audio-playback-lifecycle.md](./audio-playback-lifecycle.md) |
| 2 | Google Drive Auth + Config Sync | OAuth lifecycle, appdata settings sync, conflict resolution, offline queue, token refresh across two cooperating stores | 7 | `src/lib/stores/googleDriveSession.svelte.ts` + `src/lib/stores/driveConfigSync.svelte.ts` | [google-drive-auth-sync.md](./google-drive-auth-sync.md) |
| 3 | Sleep Timer | Countdown timer, auto-stop playback, lifecycle hydration from persisted endsAt | 3 | `src/lib/stores/sleepTimer.svelte.ts` | [sleep-timer.md](./sleep-timer.md) |

All specs follow **State Spec v1**: flat transition tables, closed-world contract, invariants & forbidden transitions, code-reconciled. Diagrams at bottom are for humans; LLMs should use the tables.
