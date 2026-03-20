<script lang="ts">
	import { mediaEngine } from '$lib/stores/mediaEngine.svelte';
	import { Play, Pause } from 'lucide-svelte';

	interface Props {
		/** The tab that currently owns playback — hide mini-player when user is on that tab */
		activeTab: string;
		/** Clicking the bar body navigates back to the owning tab */
		onNavigateTo?: (tab: string) => void;
	}
	let { activeTab, onNavigateTo }: Props = $props();

	const ownerTab = $derived.by(() => {
		switch (mediaEngine.source) {
			case 'music':   return 'music';
			case 'podcast': return 'podcasts';
			default:        return null;
		}
	});

	const visible = $derived(
		mediaEngine.item !== null &&
		ownerTab !== null &&
		ownerTab !== activeTab
	);

	const progress = $derived(
		mediaEngine.duration > 0
			? (mediaEngine.currentTime / mediaEngine.duration) * 100
			: 0
	);
</script>

{#if visible}
	<div
		class="border-t bg-background/95 backdrop-blur-sm shrink-0"
		role="region"
		aria-label="Mini player — {mediaEngine.item?.title}"
	>
		<!-- Progress bar -->
		<div class="h-0.5 bg-muted overflow-hidden">
			<div class="h-full bg-primary transition-all duration-300" style="width:{progress}%"></div>
		</div>

		<div class="flex items-center gap-3 px-3 py-2">
			<!-- Artwork -->
			{#if mediaEngine.item?.artworkUrl}
				<img
					src={mediaEngine.item.artworkUrl}
					alt=""
					class="w-9 h-9 rounded-lg object-cover shrink-0"
				/>
			{:else}
				<div class="w-9 h-9 rounded-lg bg-muted shrink-0"></div>
			{/if}

			<!-- Track info — tapping navigates back to the player -->
			<button
				class="flex-1 min-w-0 text-left"
				onclick={() => ownerTab && onNavigateTo?.(ownerTab)}
				aria-label="Return to {ownerTab} player"
			>
				<p class="text-sm font-semibold truncate">{mediaEngine.item?.title}</p>
				<p class="text-xs text-muted-foreground truncate">{mediaEngine.item?.subtitle}</p>
			</button>

			<!-- Play/Pause — this wires to the active view's audio via mediaSession or user tap -->
			<button
				class="w-10 h-10 flex items-center justify-center rounded-full bg-primary/10 hover:bg-primary/20 text-primary transition-colors shrink-0"
				onclick={() => ownerTab && onNavigateTo?.(ownerTab)}
				aria-label={mediaEngine.isPlaying ? 'Pause' : 'Play'}
			>
				{#if mediaEngine.isPlaying}
					<Pause class="w-5 h-5" />
				{:else}
					<Play class="w-5 h-5 ml-0.5" />
				{/if}
			</button>
		</div>
	</div>
{/if}
