<script lang="ts">
	import { Folder, Music2 } from 'lucide-svelte';

	interface Props {
		kind?: 'folder' | 'file' | 'random';
	}
	let { kind = 'random' }: Props = $props();

	// If random, decide once on mount to avoid flickering
	const actualKind = $derived(kind === 'random' ? (Math.random() > 0.4 ? 'file' : 'folder') : kind);
</script>

<div class="flex items-center gap-3 px-4 py-3 border-b animate-pulse">
	<!-- Icon skeleton -->
	<div class="w-9 h-9 rounded-lg bg-muted flex items-center justify-center shrink-0">
		{#if actualKind === 'folder'}
			<Folder class="w-4 h-4 text-muted-foreground/30" />
		{:else}
			<Music2 class="w-4 h-4 text-muted-foreground/30" />
		{/if}
	</div>

	<!-- Text skeleton -->
	<div class="flex-1 min-w-0 space-y-2">
		<div class="h-4 bg-muted rounded-md w-3/4"></div>
		<div class="h-3 bg-muted/60 rounded-md w-1/2"></div>
	</div>

	<!-- Action skeleton (optional) -->
	<div class="w-9 h-9 rounded-full bg-muted/40 shrink-0"></div>
</div>

<style>
	/* Subtle gradient pulse for higher-end feel */
	.animate-pulse {
		background: linear-gradient(
			90deg,
			transparent 0%,
			rgba(var(--muted), 0.1) 50%,
			transparent 100%
		);
		background-size: 200% 100%;
		animation: shimmer 2s infinite linear;
	}

	@keyframes shimmer {
		0% { background-position: -200% 0; }
		100% { background-position: 200% 0; }
	}
</style>
