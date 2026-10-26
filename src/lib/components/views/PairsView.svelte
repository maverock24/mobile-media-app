<script lang="ts">
	import Button from '$lib/components/ui/Button.svelte';
	import { Layers, Trash2 } from 'lucide-svelte';
	import {
		derivePairingName,
		findPairing,
		pairings,
		removePairing,
		setActivePair,
		upsertPairing,
	} from '$lib/pairs/pairings';
	import { activateSavedScene } from '$lib/pairs/activeScene';
	import { startPairing } from '$lib/pairs/startPairing';
	import { formatVolume } from '$lib/pairs/format';
	import { formatClock } from '$lib/models/music';
	import { toTrackRef } from '$lib/pairs/resolve';
	import { getDeckCommands } from '$lib/stores/deckCommands.svelte';
	import { musicSettings } from '$lib/stores/settings.svelte';
	import { addToast } from '$lib/stores/toastStore.svelte';
	import type { AbPairing } from '$lib/pairs/types';

	// A "scene" (pair) remembers an audiobook on deck A together with the music
	// on deck B, so both can be resumed as one thing. The list renders
	// `pairings.pairs` in array order, which the store keeps newest first.
	// Tapping a row starts the scene (S7) and deliberately changes no tab state,
	// so the human stays on this panel while both decks start behind it. Save (S9)
	// reads both decks through their command seam and keeps one row per pair.

	// D6: Save is live only while deck A has a track, and this is reactive because
	// `capture()` reads the deck's own `$state` (its queue, time and duration).
	const captureA = $derived(getDeckCommands('A')?.capture() ?? null);
	const captureB = $derived(getDeckCommands('B')?.capture() ?? null);

	// The save (D6): deck A's file and position, deck B's file when it has one,
	// and the current background volume and speed. `upsertPairing` decides whether
	// this updates the existing row or adds one; the panel writes both top-level
	// keys it returns, because `persisted()` tracks one read per key.
	function save(): void {
		const a = captureA;
		if (!a) return;

		const savedAt = Date.now();
		const aRef = toTrackRef(a.source);
		const bRef = captureB ? toTrackRef(captureB.source) : null;
		const next = upsertPairing(pairings, {
			a: aRef,
			b: bRef,
			positionSec: Math.floor(a.positionSec),
			durationSec: Math.round(a.durationSec),
			bVolume: musicSettings.deckBVolume,
			bSpeed: musicSettings.deckBSpeed,
			savedAt,
		});
		pairings.pairs = next.pairs;
		pairings.nextId = next.nextId;

		// D3: a scene saved while it is playing is the one deck A holds, so the
		// save marks it active. Without this the new row was never the active
		// scene, and its position did not follow playback until a tap started it.
		activateSavedScene({
			savedPair: findPairing(next.pairs, aRef, bRef),
			deckA: getDeckCommands('A'),
			setActivePair,
		});

		addToast({ message: `Saved "${derivePairingName(aRef, bRef, savedAt)}"`, type: 'info' });
	}

	// D5's toasts are raised inside `startPairing`, so this is only the tap. The
	// promise is not awaited in the markup: the row is not a navigation.
	function start(pair: AbPairing): void {
		void startPairing(pair);
	}

	// The active-scene marker is no longer maintained here: its rule (a scene stays
	// active while deck A still holds its audiobook, and is cleared when deck A
	// loads another track or both decks empty) lives in `$lib/pairs/activeScene.ts`
	// and is driven by deck A, so it is unit tested with fake deck commands. This
	// panel only reads the marker, to mark the row.

	// D9: the existing two-tap confirmation, the same shape as the file delete in
	// `$lib/files/fileOps.ts:140-147` — a sticky warning toast with the action.
	// Not `window.confirm`, which the web shell and the WebView both render badly.
	function confirmDelete(pair: AbPairing): void {
		addToast({
			message: `Delete ${pair.name}?`,
			type: 'warning',
			autoDismissMs: 0,
			action: { label: 'Delete', handler: () => removePairing(pair.id) }
		});
	}
</script>

<div class="flex flex-col h-full bg-background/85">
	<!-- ── Header ───────────────────────────────────────────────── -->
	<div class="shrink-0 flex items-center justify-between gap-3 px-4 py-3 border-b">
		<h2 class="text-sm font-semibold">Pairs</h2>
		<Button variant="outline" size="sm" disabled={!captureA} onclick={save}>Save</Button>
	</div>

	<div class="flex-1 overflow-y-auto">
		{#if pairings.pairs.length === 0}
			<!-- ── Empty state ──────────────────────────────────────── -->
			<div class="flex flex-col items-center justify-center h-48 gap-3 text-muted-foreground px-6 text-center">
				<Layers class="w-10 h-10 opacity-30" />
				<p class="text-sm">No pairings yet.</p>
				<p class="text-xs">A scene saves an audiobook on deck A together with music on deck B so you can resume both at once.</p>
			</div>
		{:else}
			<!-- ── Saved scenes, newest first ───────────────────────── -->
			{#each pairings.pairs as pair (pair.id)}
				<!-- The active scene is marked the way PodcastView marks the playing
				     episode: a left accent bar and a faint tint, no extra text, so the
				     row's accessible name stays the scene's name. -->
				<div
					class="flex items-center gap-2 p-3 pl-4 border-b border-l-4 {pairings.activePairId === pair.id
						? 'border-l-primary bg-primary/5'
						: 'border-l-transparent'}"
				>
					<!-- The tap target: a real button, so starting a scene is reachable by
					     role. The content is phrasing-only (spans), since a div inside a
					     button is invalid HTML. -->
					<button
						type="button"
						class="flex flex-1 min-w-0 items-center gap-3 text-left"
						aria-current={pairings.activePairId === pair.id ? 'true' : undefined}
						onclick={() => start(pair)}
					>
						<span class="w-10 h-10 rounded-xl bg-gradient-to-br from-violet-500 to-fuchsia-600 flex items-center justify-center shrink-0">
							<Layers class="w-5 h-5" />
						</span>
						<span class="flex-1 min-w-0">
							<span class="block font-semibold text-[0.95rem] leading-tight truncate">{pair.name}</span>
							<span class="block text-xs text-muted-foreground truncate">
								{formatClock(pair.positionSec)}{pair.durationSec > 0 ? ` / ${formatClock(pair.durationSec)}` : ''}
								· {formatVolume(pair.bVolume)}
								· {pair.b ? pair.b.name : 'no background track'}
							</span>
						</span>
					</button>
					<!-- A sibling, never a child, of the row button: nesting buttons is
					     invalid and would hide the delete from getByRole. -->
					<Button
						variant="ghost"
						size="icon"
						class="w-8 h-8 shrink-0 text-destructive hover:text-destructive"
						aria-label={`Delete ${pair.name}`}
						onclick={() => confirmDelete(pair)}
					>
						<Trash2 class="w-4 h-4" />
					</Button>
				</div>
			{/each}
		{/if}
	</div>
</div>
