<script lang="ts">
	import Button from '$lib/components/ui/Button.svelte';
	import { Layers } from 'lucide-svelte';

	// A "scene" (pair) remembers an audiobook on deck A together with the music
	// on deck B, so both can be resumed as one thing. Saving is not wired up yet
	// — this panel only owns the empty state; the list and the write path land
	// in later phases, so there is no store import here on purpose.
</script>

<div class="flex flex-col h-full bg-background/85">
	<!-- ── Header ───────────────────────────────────────────────── -->
	<div class="shrink-0 flex items-center justify-between gap-3 px-4 py-3 border-b">
		<h2 class="text-sm font-semibold">Pairs</h2>
		<Button variant="outline" size="sm" disabled>Save</Button>
	</div>

	<!-- ── Empty state ──────────────────────────────────────────── -->
	<div class="flex-1 overflow-y-auto">
		<div class="flex flex-col items-center justify-center h-48 gap-3 text-muted-foreground px-6 text-center">
			<Layers class="w-10 h-10 opacity-30" />
			<p class="text-sm">No pairings yet.</p>
			<p class="text-xs">A scene saves an audiobook on deck A together with music on deck B so you can resume both at once.</p>
		</div>
	</div>
</div>
