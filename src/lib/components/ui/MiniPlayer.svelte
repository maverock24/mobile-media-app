<script lang="ts">
	import { mediaEngine } from '$lib/stores/mediaEngine.svelte';
	import {
		sleepTimer,
		SLEEP_TIMER_PRESETS,
		setSleepTimer,
		clearSleepTimer,
		formatSleepTimerRemaining,
	} from '$lib/stores/sleepTimer.svelte';
	import { Play, Pause, SkipBack, SkipForward, Moon, X } from 'lucide-svelte';

	interface Props {
		/** The currently selected tab. */
		activeTab: string;
		/** Clicking the bar body navigates back to the owning tab */
		onNavigateTo?: (tab: string) => void;
	}
	let { activeTab, onNavigateTo }: Props = $props();
	let showSleepTimerOptions = $state(false);

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
	const sleepTimerLabel = $derived(
		sleepTimer.isActive ? formatSleepTimerRemaining(sleepTimer.remainingMs) : 'Off'
	);

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

	function applySleepTimer(minutes: number) {
		setSleepTimer(minutes);
		showSleepTimerOptions = false;
	}

	function toggleSleepTimerOptions() {
		showSleepTimerOptions = !showSleepTimerOptions;
	}

	function clearSleepTimerFromMiniPlayer() {
		clearSleepTimer();
		showSleepTimerOptions = false;
	}
</script>

{#if visible}
	<div
		class="mini-player-root border-t bg-background/95 backdrop-blur-sm shrink-0"
		role="region"
		aria-label="Mini player — {mediaEngine.item?.title}"
	>
		<div class="mini-player-main flex items-center gap-3 px-3 py-3">
			<!-- Artwork -->
			{#if mediaEngine.item?.artworkUrl}
				<img
					src={mediaEngine.item.artworkUrl}
					alt=""
					class="w-11 h-11 rounded-xl object-cover shrink-0"
				/>
			{:else}
				<div class="w-11 h-11 rounded-xl bg-muted shrink-0"></div>
			{/if}

			<!-- Track info — tapping navigates back to the player -->
			<button
				class="flex-1 min-w-0 text-left"
				onclick={() => ownerTab && onNavigateTo?.(ownerTab)}
				aria-label="Return to {ownerTab} player"
			>
				<p class="mini-player-info-title text-sm font-semibold truncate">{mediaEngine.item?.title}</p>
				<p class="mini-player-info-subtitle text-xs text-muted-foreground truncate">{mediaEngine.item?.subtitle}</p>
			</button>

			<div class="flex items-center gap-1.5 shrink-0">
				<button
					class="mini-player-action mini-player-sleep w-11 h-11 flex items-center justify-center rounded-full hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
					onclick={toggleSleepTimerOptions}
					aria-label="Sleep timer"
					title={sleepTimer.isActive ? `Sleep timer ${sleepTimerLabel}` : 'Set sleep timer'}
				>
					<Moon class="w-5 h-5 {sleepTimer.isActive ? 'text-primary' : ''}" />
				</button>

				{#if canSkipPrevious}
					<button
						class="mini-player-action w-11 h-11 flex items-center justify-center rounded-full hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
						onclick={skipPrevious}
						aria-label="Previous"
					>
						<SkipBack class="w-5 h-5" />
					</button>
				{/if}

				<button
					class="mini-player-action mini-player-primary w-14 h-14 flex items-center justify-center rounded-full bg-primary/10 hover:bg-primary/20 text-primary transition-colors"
					onclick={togglePlayback}
					aria-label={mediaEngine.isPlaying ? 'Pause' : 'Play'}
				>
					{#if mediaEngine.isPlaying}
						<Pause class="w-7 h-7" />
					{:else}
						<Play class="w-7 h-7 ml-1" />
					{/if}
				</button>

				{#if canSkipNext}
					<button
						class="mini-player-action w-11 h-11 flex items-center justify-center rounded-full hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
						onclick={skipNext}
						aria-label="Next"
					>
						<SkipForward class="w-5 h-5" />
					</button>
				{/if}
			</div>
		</div>

		{#if sleepTimer.isActive || showSleepTimerOptions}
			<div class="px-3 pb-2 space-y-2">
				<div class="flex items-center justify-between text-[11px] text-muted-foreground">
					<span>Sleep timer {sleepTimer.isActive ? `in ${sleepTimerLabel}` : 'off'}</span>
					{#if sleepTimer.isActive}
						<button
							class="mini-player-chip inline-flex items-center gap-1 rounded-full px-2 py-1 hover:bg-accent transition-colors"
							onclick={clearSleepTimerFromMiniPlayer}
							aria-label="Clear sleep timer"
						>
							<X class="w-3 h-3" />
							Off
						</button>
					{/if}
				</div>

				{#if showSleepTimerOptions}
					<div class="flex flex-wrap gap-2">
						{#each SLEEP_TIMER_PRESETS as minutes}
							<button
								class="mini-player-chip px-3 py-1.5 rounded-full text-xs border transition-colors {sleepTimer.isActive && sleepTimer.lastDurationMin === minutes ? 'border-primary bg-primary/10 text-primary font-medium' : 'border-border hover:bg-accent'}"
								onclick={() => applySleepTimer(minutes)}
							>
								{minutes}m
							</button>
						{/each}
					</div>
				{/if}
			</div>
		{/if}

		{#if canSeek}
			<div class="px-3 pb-2">
				<input
					class="mini-player-seek w-full h-2 rounded-full appearance-none cursor-pointer bg-muted accent-primary"
					type="range"
					min="0"
					max="100"
					value={progress}
					oninput={handleSeekInput}
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
