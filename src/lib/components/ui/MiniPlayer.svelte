<script lang="ts">
	import { mediaEngine } from '$lib/stores/mediaEngine.svelte';
	import { Play, Pause, SkipBack, SkipForward } from 'lucide-svelte';

	interface Props {
		/** The currently selected tab. */
		activeTab: string;
		/** Clicking the bar body navigates back to the owning tab */
		onNavigateTo?: (tab: string) => void;
	}
	let { activeTab, onNavigateTo }: Props = $props();

	const ownerTab = $derived.by(() => {
		switch (mediaEngine.source) {
			case 'music':   return 'music';
			case 'podcast': return 'podcasts';
			case 'radio':   return 'radio';
			default:        return null;
		}
	});

	const visible = $derived(
		mediaEngine.item !== null &&
		ownerTab !== null
	);

	const progress = $derived(
		mediaEngine.duration > 0
			? (mediaEngine.currentTime / mediaEngine.duration) * 100
			: 0
	);

	const canSeek = $derived(mediaEngine.source === 'music' || mediaEngine.source === 'podcast');
	const canSkipPrevious = $derived(mediaEngine._onPrev !== null);
	const canSkipNext = $derived(mediaEngine._onNext !== null);

	function formatTime(seconds: number): string {
		if (!seconds || seconds < 0) return '0:00';
		const hours = Math.floor(seconds / 3600);
		const minutes = Math.floor((seconds % 3600) / 60);
		const secs = Math.floor(seconds % 60);
		if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
		return `${minutes}:${String(secs).padStart(2, '0')}`;
	}

	function seekTo(time: number) {
		const target = Math.max(0, Math.min(time, mediaEngine.duration || 0));
		mediaEngine._onSeek?.(target) ?? mediaEngine.seek(target);
	}

	function handleSeekInput(event: Event) {
		const nextProgress = Number((event.target as HTMLInputElement).value);
		seekTo(mediaEngine.duration > 0 ? (nextProgress / 100) * mediaEngine.duration : 0);
	}

	function togglePlayback() {
		if (mediaEngine.isPlaying) {
			mediaEngine._onPause?.() ?? mediaEngine.pause();
			return;
		}

		mediaEngine._onPlay?.() ?? mediaEngine.resume();
	}

	function skipPrevious() {
		mediaEngine._onPrev?.() ?? mediaEngine.prev();
	}

	function skipNext() {
		mediaEngine._onNext?.() ?? mediaEngine.next();
	}
</script>

{#if visible}
	<div
		class="border-t bg-background/95 backdrop-blur-sm shrink-0"
		role="region"
		aria-label="Mini player — {mediaEngine.item?.title}"
	>
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

			<div class="flex items-center gap-1 shrink-0">
				{#if canSkipPrevious}
					<button
						class="w-9 h-9 flex items-center justify-center rounded-full hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
						onclick={skipPrevious}
						aria-label="Previous"
					>
						<SkipBack class="w-4 h-4" />
					</button>
				{/if}

				<button
					class="w-10 h-10 flex items-center justify-center rounded-full bg-primary/10 hover:bg-primary/20 text-primary transition-colors"
					onclick={togglePlayback}
					aria-label={mediaEngine.isPlaying ? 'Pause' : 'Play'}
				>
					{#if mediaEngine.isPlaying}
						<Pause class="w-5 h-5" />
					{:else}
						<Play class="w-5 h-5 ml-0.5" />
					{/if}
				</button>

				{#if canSkipNext}
					<button
						class="w-9 h-9 flex items-center justify-center rounded-full hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
						onclick={skipNext}
						aria-label="Next"
					>
						<SkipForward class="w-4 h-4" />
					</button>
				{/if}
			</div>
		</div>

		{#if canSeek}
			<div class="px-3 pb-2">
				<input
					type="range"
					min="0"
					max="100"
					value={progress}
					oninput={handleSeekInput}
					class="w-full h-2 rounded-full appearance-none cursor-pointer bg-muted accent-primary"
					aria-label="Seek"
					aria-valuenow={Math.round(progress)}
				/>
				<div class="flex justify-between text-[10px] text-muted-foreground mt-0.5">
					<span>{formatTime(mediaEngine.currentTime)}</span>
					<span>{mediaEngine.duration > 0 ? formatTime(mediaEngine.duration) : '--:--'}</span>
				</div>
			</div>
		{/if}
	</div>
{/if}
