<script lang="ts">
	import { mediaEngine } from '$lib/stores/mediaEngine.svelte';
	import { Play, Pause, X, Music2, Mic2 } from 'lucide-svelte';
	import { fade, fly } from 'svelte/transition';

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
		class="relative border-t bg-background/80 backdrop-blur-xl shrink-0 safe-area-inset-bottom shadow-[0_-8px_30px_rgb(0,0,0,0.12)] overflow-hidden"
		role="region"
		aria-label="Mini player — {mediaEngine.item?.title}"
		in:fly={{ y: 20, duration: 400 }}
		out:fade={{ duration: 200 }}
	>
		<!-- Progress bar -->
		<div class="h-0.5 bg-primary/10 overflow-hidden">
			<div class="h-full bg-primary transition-all duration-300 shadow-[0_0_10px_rgba(var(--primary),0.5)]" style="width:{progress}%"></div>
		</div>

		<div class="flex items-center gap-3 px-4 py-3">
			<!-- Artwork -->
			<div class="relative shrink-0">
				{#if mediaEngine.item?.artworkUrl}
					<img
						src={mediaEngine.item.artworkUrl}
						alt=""
						class="w-11 h-11 rounded-xl object-cover shadow-md ring-1 ring-white/10"
					/>
				{:else}
					<div class="w-11 h-11 rounded-xl bg-gradient-to-br from-primary/20 to-primary/5 flex items-center justify-center text-primary shadow-inner">
						{#if mediaEngine.source === 'music'}
							<Music2 class="w-6 h-6" />
						{:else}
							<Mic2 class="w-6 h-6" />
						{/if}
					</div>
				{/if}
				{#if mediaEngine.isPlaying}
					<div class="absolute -top-1 -right-1 flex gap-0.5 items-end h-3 px-1 rounded-full bg-primary text-[6px] text-primary-foreground shadow-sm animate-pulse">
						<span class="w-0.5 h-1.5 bg-current rounded-full animate-bounce"></span>
						<span class="w-0.5 h-2.5 bg-current rounded-full animate-bounce [animation-delay:0.2s]"></span>
						<span class="w-0.5 h-1 bg-current rounded-full animate-bounce [animation-delay:0.4s]"></span>
					</div>
				{/if}
			</div>

			<!-- Track info — tapping navigates back to the player -->
			<button
				class="flex-1 min-w-0 text-left group"
				onclick={() => ownerTab && onNavigateTo?.(ownerTab)}
				aria-label="Return to {ownerTab} player"
			>
				<h4 class="text-sm font-bold truncate group-hover:text-primary transition-colors">{mediaEngine.item?.title}</h4>
				<p class="text-xs text-muted-foreground truncate font-medium">{mediaEngine.item?.subtitle}</p>
			</button>

			<div class="flex items-center gap-1 shrink-0">
				<!-- Play/Pause -->
				<button
					class="w-10 h-10 flex items-center justify-center rounded-full bg-primary/10 hover:bg-primary/20 text-primary transition-all active:scale-90"
					onclick={() => mediaEngine.toggle()}
					aria-label={mediaEngine.isPlaying ? 'Pause' : 'Play'}
				>
					{#if mediaEngine.isPlaying}
						<Pause class="w-5 h-5" fill="currentColor" />
					{:else}
						<Play class="w-5 h-5 ml-0.5" fill="currentColor" />
					{/if}
				</button>

				<!-- Close -->
				<button
					class="w-8 h-8 flex items-center justify-center rounded-full text-muted-foreground/50 hover:text-muted-foreground hover:bg-muted transition-colors"
					onclick={() => mediaEngine.clear()}
					aria-label="Stop playback"
				>
					<X class="w-4 h-4" />
				</button>
			</div>
		</div>
	</div>
{/if}

