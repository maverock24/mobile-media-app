<script lang="ts">
	import { mediaEngine } from '$lib/stores/mediaEngine.svelte';
	import { mixerShared } from '$lib/stores/mixerShared.svelte';
	import { podcastSettings } from '$lib/stores/settings.svelte';
	import {
		sleepTimer,
		SLEEP_TIMER_PRESETS,
		setSleepTimer,
		clearSleepTimer,
		formatSleepTimerRemaining,
	} from '$lib/stores/sleepTimer.svelte';
	import { triggerToggleHaptic } from '$lib/native/haptics';
	import { formatClock as formatTime } from '$lib/models/music';
	import { Play, Pause, SkipBack, SkipForward, Moon, X, SlidersHorizontal } from 'lucide-svelte';

	interface Props {
		/** The currently selected tab. */
		activeTab: string;
		/** Whether the shared controls are rendered above or below content. */
		position?: 'top' | 'bottom';
		/** Clicking the bar body navigates back to the owning tab */
		onNavigateTo?: (tab: string) => void;
	}
	let { activeTab, position = 'bottom', onNavigateTo }: Props = $props();
	let showSleepTimerOptions = $state(false);

	const ownerTab = $derived.by(() => {
		// On the mixer tab the decks own playback; surface deck A's label and
		// navigate back to the mixer.
		if (activeTab === 'mixer' && mixerShared.anyDeckLoaded) return 'mixer';
		switch (mediaEngine.source) {
			case 'music':   return 'music';
			case 'podcast': return 'podcasts';
			case 'radio':   return 'radio';
			default:        return null;
		}
	});

	// Single rule for the play/pause button: pause icon when something is playing,
	// play icon when nothing is. mediaEngine.isPlaying covers every source —
	// music/podcast/radio via their own flags, and the mixer decks via
	// mediaEngine.mixerPlaying, which MixerView now syncs on every deck
	// play/pause/ended event (previously a natural deck pause left mixerPlaying
	// stuck true, so the button stayed on Pause after playback stopped).
	const isPlaying = $derived(mediaEngine.isPlaying);

	const onMixerTab = $derived(ownerTab === 'mixer');
	/** Title/subtitle to display: deck A's label on the mixer tab, otherwise the
	 *  main-media now-playing item. */
	const displayTitle = $derived(onMixerTab ? mixerShared.deckALabel : mediaEngine.item?.title);
	const displaySubtitle = $derived(onMixerTab ? 'Mixer · Deck A' : mediaEngine.item?.subtitle);

	const visible = $derived(
		(mediaEngine.item !== null && ownerTab !== null) ||
		(activeTab === 'mixer' && mixerShared.anyDeckLoaded)
	);

	const progress = $derived(
		mediaEngine.duration > 0
			? (mediaEngine.currentTime / mediaEngine.duration) * 100
			: 0
	);

	const canSeek = $derived(mediaEngine.source === 'music' || mediaEngine.source === 'podcast');
	const canSkipPrevious = $derived(mediaEngine._onPrev !== null);
	const canSkipNext = $derived(mediaEngine._onNext !== null);
	const showPodcastSpeedPreset = $derived(mediaEngine.source === 'podcast');
	const podcastOneAndHalfActive = $derived(showPodcastSpeedPreset && podcastSettings.playbackSpeed === 1.5);
	const sleepTimerLabel = $derived(
		sleepTimer.isActive ? formatSleepTimerRemaining(sleepTimer.remainingMs) : 'Off'
	);

	function seekTo(time: number) {
		const target = Math.max(0, Math.min(time, mediaEngine.duration || 0));
		mediaEngine._onSeek?.(target) ?? mediaEngine.seek(target);
	}

	function handleSeekInput(event: Event) {
		const nextProgress = Number((event.target as HTMLInputElement).value);
		seekTo(mediaEngine.duration > 0 ? (nextProgress / 100) * mediaEngine.duration : 0);
	}

	function togglePlayback() {
		// Single source of truth: mediaEngine.isPlaying (music/podcast/radio/mixer).
		// Pause whatever is active; if nothing is playing, start the right source.
		if (mediaEngine.isPlaying) {
			// Mixer decks take precedence when playing — pausing them frees the flag.
			if (mediaEngine.mixerPlaying) mixerShared.playBoth?.();   // toggles: playing → pauseBoth
			else mediaEngine._onPause?.() ?? mediaEngine.pause();
			return;
		}
		// Nothing is playing — start the appropriate source. On the mixer tab with a
		// deck loaded, that's the decks; otherwise resume the main media engine.
		if (activeTab === 'mixer' && mixerShared.anyDeckLoaded) {
			mixerShared.playBoth?.();
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
		void triggerToggleHaptic(true);
	}

	function toggleSleepTimerOptions() {
		showSleepTimerOptions = !showSleepTimerOptions;
	}

	function clearSleepTimerFromMiniPlayer() {
		clearSleepTimer();
		showSleepTimerOptions = false;
		void triggerToggleHaptic(false);
	}

	function setPodcastMiniPlayerSpeed() {
		const enabled = podcastSettings.playbackSpeed !== 1.5;
		podcastSettings.playbackSpeed = enabled ? 1.5 : 1.0;
		void triggerToggleHaptic(enabled);
	}
</script>

{#if visible}
	<div
		class="mini-player-root bg-background/95 backdrop-blur-sm shrink-0 {position === 'top' ? 'border-b' : 'border-t'}"
		role="region"
		aria-label="Mini player — {displayTitle}"
	>
		<div class="mini-player-main px-3 pt-3 pb-2 space-y-2.5">
			<!-- Track info — tapping navigates back to the player -->
			<button
				class="w-full min-w-0 text-left"
				onclick={() => ownerTab && onNavigateTo?.(ownerTab)}
				aria-label="Return to {ownerTab} player"
			>
				<p class="mini-player-info-title text-sm font-semibold leading-tight truncate">{displayTitle}</p>
				<p class="mini-player-info-subtitle text-xs text-muted-foreground leading-tight truncate mt-0.5">{displaySubtitle}</p>
			</button>

			<div class="relative min-h-[3.5rem]">
				<div class="absolute left-0 top-1/2 -translate-y-1/2">
					<button
						class="mini-player-action mini-player-sleep mini-player-control-surface w-9 h-9 flex items-center justify-center rounded-full text-muted-foreground hover:text-foreground"
						onclick={toggleSleepTimerOptions}
						aria-label="Sleep timer"
						title={sleepTimer.isActive ? `Sleep timer ${sleepTimerLabel}` : 'Set sleep timer'}
					>
						<Moon class="w-4 h-4 {sleepTimer.isActive ? 'text-primary' : ''}" />
					</button>
				</div>

				<div class="flex items-center justify-center gap-3">
					{#if canSkipPrevious}
						<button
							class="mini-player-action mini-player-control-surface w-9 h-9 flex items-center justify-center rounded-full text-muted-foreground hover:text-foreground"
							onclick={skipPrevious}
							aria-label="Previous"
						>
							<SkipBack class="w-4 h-4" />
						</button>
					{/if}

					<button
						class="mini-player-action mini-player-primary mini-player-control-surface mini-player-control-primary w-14 h-14 flex items-center justify-center rounded-full text-primary"
						onclick={togglePlayback}
						aria-label={isPlaying ? 'Pause' : 'Play'}
					>
						{#if isPlaying}
							<Pause class="w-7 h-7" />
						{:else}
							<Play class="w-7 h-7 ml-1" />
						{/if}
					</button>

					{#if canSkipNext}
						<button
							class="mini-player-action mini-player-control-surface w-9 h-9 flex items-center justify-center rounded-full text-muted-foreground hover:text-foreground"
							onclick={skipNext}
							aria-label="Next"
						>
							<SkipForward class="w-4 h-4" />
						</button>
					{/if}

					{#if activeTab === 'music'}
						<button
							class="mini-player-action mini-player-control-surface w-9 h-9 flex items-center justify-center rounded-full text-muted-foreground hover:text-foreground"
							onclick={() => onNavigateTo?.('mixer')}
							aria-label="Open mixer"
							title="Mixer — play two tracks at once"
						>
							<SlidersHorizontal class="w-4 h-4" />
						</button>
					{/if}
				</div>

				{#if showPodcastSpeedPreset}
					<div class="absolute right-0 top-1/2 -translate-y-1/2">
						<button
							class="mini-player-action mini-player-control-surface h-8 min-w-[3rem] px-2 inline-flex items-center justify-center rounded-full text-xs font-semibold {podcastOneAndHalfActive ? 'border-primary bg-primary/18 text-primary' : 'text-muted-foreground hover:text-foreground'}"
							onclick={setPodcastMiniPlayerSpeed}
							aria-label="Play podcast at 1.5x speed"
							aria-pressed={podcastOneAndHalfActive}
						>
							1.5x
						</button>
					</div>
				{/if}
			</div>
		</div>

		{#if sleepTimer.isActive || showSleepTimerOptions}
			<div class="px-3 pb-2 space-y-2">
				<div class="flex items-center justify-between text-[11px] text-muted-foreground">
					<span>Sleep timer {sleepTimer.isActive ? `in ${sleepTimerLabel}` : 'off'}</span>
					{#if sleepTimer.isActive}
						<button
							class="mini-player-chip mini-player-control-surface inline-flex items-center gap-1 rounded-full px-2 py-1"
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
								class="mini-player-chip mini-player-control-surface px-3 py-1.5 rounded-full text-xs {sleepTimer.isActive && sleepTimer.lastDurationMin === minutes ? 'border-primary bg-primary/18 text-primary font-medium' : 'text-foreground'}"
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
