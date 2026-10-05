# State Machine Inventory

| # | Machine | Purpose | States | Source | Spec |
|---|---------|---------|--------|--------|------|
| 1 | Audio Playback Lifecycle | Now-playing state hub across Music, Podcast, Radio, YouTube, Mixer; audio exclusivity, stream reconnect, Android background recovery, per-deck state (A/B) for simultaneous dual-deck playback | 5 | `src/lib/stores/mediaEngine.svelte.ts` | [audio-playback-lifecycle.md](./audio-playback-lifecycle.md) |
| 2 | Google Drive Auth | Access-token lifecycle across the persistence-owning store and a per-deck session factory: hydration, the one-shot pending native authorisation, the interactive request, sign-out | 4 | `src/lib/stores/googleDriveSession.svelte.ts` + `src/lib/drive/driveSession.svelte.ts` | [google-drive-auth-sync.md](./google-drive-auth-sync.md) |
| 3 | Sleep Timer | Countdown timer, auto-stop playback, lifecycle hydration from persisted endsAt | 3 | `src/lib/stores/sleepTimer.svelte.ts` | [sleep-timer.md](./sleep-timer.md) |
| 4 | YouTube Playback Lifecycle | YouTube panel's own `<audio>` element: resolve → play → buffer, queue advance with bounded skips, src-wiped recovery, and the visibility axis that must not affect playback | 6 | `src/lib/components/ui/YoutubePanel.svelte` + `src/lib/stores/youtubePanel.svelte.ts` | [youtube-playback.md](./youtube-playback.md) |

All specs follow **State Spec v1**: flat transition tables, closed-world contract, invariants & forbidden transitions, code-reconciled. Diagrams at bottom are for humans; LLMs should use the tables.
