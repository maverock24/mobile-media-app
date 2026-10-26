<script lang="ts">
	import Button from '$lib/components/ui/Button.svelte';
	import { Layers, Trash2 } from 'lucide-svelte';
	import { pairings, removePairing } from '$lib/pairs/pairings';
	import { formatPosition, formatVolume } from '$lib/pairs/format';
	import { addToast } from '$lib/stores/toastStore.svelte';
	import type { AbPairing } from '$lib/pairs/types';

	// A "scene" (pair) remembers an audiobook on deck A together with the music
	// on deck B, so both can be resumed as one thing. The list renders
	// `pairings.pairs` in array order, which the store keeps newest first.
	// Saving is not wired up yet (the header button stays disabled) and a row
	// tap does nothing until S7 starts playback.

	/** The date a scene was last saved, in the user's locale. */
	function savedOn(savedAt: number): string {
		return new Date(savedAt).toLocaleDateString();
	}

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
		<Button variant="outline" size="sm" disabled>Save</Button>
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
				<div class="flex items-center gap-2 p-3 pl-4 border-b">
					<!-- The tap target: a real button so S7 can wire playback to it. The
					     content is phrasing-only (spans), since a div inside a button is
					     invalid HTML. -->
					<button type="button" class="flex flex-1 min-w-0 items-center gap-3 text-left">
						<span class="w-10 h-10 rounded-xl bg-gradient-to-br from-violet-500 to-fuchsia-600 flex items-center justify-center shrink-0">
							<Layers class="w-5 h-5" />
						</span>
						<span class="flex-1 min-w-0">
							<span class="block font-semibold text-[0.95rem] leading-tight truncate">{pair.name}</span>
							<span class="block text-xs text-muted-foreground truncate">
								{formatPosition(pair.positionSec)}{pair.durationSec > 0 ? ` / ${formatPosition(pair.durationSec)}` : ''}
								· {formatVolume(pair.bVolume)}
								· {pair.b ? pair.b.name : 'no background track'}
							</span>
							<span class="block text-xs text-muted-foreground">{savedOn(pair.savedAt)}</span>
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
