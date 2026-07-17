<script lang="ts">
	import { mediaEngine } from '$lib/stores/mediaEngine.svelte';
	import { podcastSettings, musicSettings } from '$lib/stores/settings.svelte';
	import {
		sleepTimer,
		SLEEP_TIMER_PRESETS,
		setSleepTimer,
		clearSleepTimer,
		formatSleepTimerRemaining,
	} from '$lib/stores/sleepTimer.svelte';
	import { triggerToggleHaptic } from '$lib/native/haptics';
	import { formatClock as formatTime } from '$lib/models/music';
	import { Play, Pause, SkipBack, SkipForward, Moon, X, Repeat, Volume2 } from 'lucide-svelte';

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
		switch (mediaEngine.source) {
			case 'music':   return 'music';
			case 'podcast': return 'podcasts';
			case 'radio':   return 'radio';
			default: {
				// source may be null when item was cleared but a deck is still
				// playing — determine owner from the active playing flags.
				if (mediaEngine.musicPlayingA || mediaEngine.musicPlayingB) return 'music';
				if (mediaEngine.podcastPlaying) return 'podcasts';
				if (mediaEngine.radioPlaying) return 'radio';
				return null;
			}
		}
	});

	// Play/pause button: when music is the active source, reflect ONLY the
	// deck you're currently viewing — not the other deck that may be playing
	// in the background. For podcast/radio, use the global playing flag.
	const isPlaying = $derived(
		mediaEngine.source === 'music'
			? (mediaEngine.activeMusicDeck === 'A' ? mediaEngine.musicPlayingA : mediaEngine.musicPlayingB)
			: mediaEngine.isPlaying
	);

	// Which deck label to show: the one that's actually playing, or the
	// viewed deck if neither is playing.
	const activePlayingDeck = $derived(
		mediaEngine.musicPlayingA ? 'A' : mediaEngine.musicPlayingB ? 'B' : mediaEngine.activeMusicDeck
	);

	const displayTitle = $derived(
		mediaEngine.item?.title ??
		(mediaEngine.musicPlayingA || mediaEngine.musicPlayingB
			? `Deck ${mediaEngine.musicPlayingA ? 'A' : 'B'}`
			: activeTab === 'music' ? `Deck ${mediaEngine.activeMusicDeck}` : undefined)
	);
	const displaySubtitle = $derived(
		mediaEngine.item
			? (mediaEngine.source === 'music'
				? `Deck ${activePlayingDeck} · ${mediaEngine.item.subtitle ?? ''}`
				: mediaEngine.item.subtitle)
			: (mediaEngine.musicPlayingA || mediaEngine.musicPlayingB
				? `Playing on Deck ${mediaEngine.musicPlayingA ? 'A' : 'B'}`
				: activeTab === 'music' ? 'No track loaded' : undefined)
	);

	// Always visible on the music tab (so the A/B toggle, play button, and
	// volume slider are always accessible). For other tabs, only show when
	// something is playing or a track is loaded.
	const visible = $derived(
		activeTab === 'music' ||
		mediaEngine.item !== null ||
		mediaEngine.musicPlayingA ||
		mediaEngine.musicPlayingB ||
		mediaEngine.podcastPlaying ||
		mediaEngine.radioPlaying
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
		// Use the same deck-aware check as the play/pause icon
		const deckPlaying = mediaEngine.source === 'music'
			? (mediaEngine.activeMusicDeck === 'A' ? mediaEngine.musicPlayingA : mediaEngine.musicPlayingB)
			: mediaEngine.isPlaying;
		if (deckPlaying) {
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

	function toggleMusicSelectionLoop() {
		if (mediaEngine.musicSelectionLoopActive) {
			// Already looping — remove loop selection and hide the button
			mediaEngine.musicSelectionLoopActive = false;
			mediaEngine.musicHasSelectedTracks = false;
		} else {
			mediaEngine.musicSelectionLoopActive = true;
		}
		void triggerToggleHaptic(mediaEngine.musicSelectionLoopActive);
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
						{#if mediaEngine.source === 'music' && mediaEngine.musicHasSelectedTracks}
							<button
								class="mini-player-action mini-player-control-surface w-9 h-9 flex items-center justify-center rounded-full {mediaEngine.musicSelectionLoopActive ? 'text-primary' : 'text-muted-foreground'} hover:text-foreground"
								onclick={toggleMusicSelectionLoop}
								aria-label={mediaEngine.musicSelectionLoopActive ? 'Exit loop selection' : 'Enter loop selection'}
								title={mediaEngine.musicSelectionLoopActive ? 'Exit loop selection' : 'Loop selected tracks'}
							>
								<Repeat class="w-4 h-4" />
							</button>
						{/if}
						<button
							class="mini-player-action mini-player-control-surface w-12 h-12 flex items-center justify-center rounded-full text-primary hover:text-primary/80"
							onclick={skipPrevious}
							aria-label="Previous"
						>
							<SkipBack class="w-6 h-6" />
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
							class="mini-player-action mini-player-control-surface w-12 h-12 flex items-center justify-center rounded-full text-primary hover:text-primary/80"
							onclick={skipNext}
							aria-label="Next"
						>
							<SkipForward class="w-6 h-6" />
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
				{#if activeTab === 'music'}
					<div class="absolute right-0 top-1/2 -translate-y-1/2">
						<button
							class="mini-player-action mini-player-control-surface h-8 min-w-[2.5rem] px-2 inline-flex items-center justify-center rounded-full text-xs font-semibold border-primary bg-primary/18 text-primary"
							onclick={() => { mediaEngine.activeMusicDeck = mediaEngine.activeMusicDeck === 'A' ? 'B' : 'A'; void triggerToggleHaptic(true); }}
							aria-label="Switch to deck {mediaEngine.activeMusicDeck === 'A' ? 'B' : 'A'}"
							title="Deck {mediaEngine.activeMusicDeck}"
						>
							{mediaEngine.activeMusicDeck}
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

		{#if mediaEngine.source === 'music' && mediaEngine.activeMusicDeck === 'B'}
			<div class="px-3 pb-2 flex items-center gap-2">
				<Volume2 class="w-3.5 h-3.5 text-muted-foreground shrink-0" />
				<input
					class="mini-player-seek w-full h-1.5 rounded-full appearance-none cursor-pointer bg-muted accent-primary"
					type="range"
					min="0"
					max="100"
					value={musicSettings.deckBVolume}
					oninput={(e) => {
						musicSettings.deckBVolume = parseInt((e.target as HTMLInputElement).value);
					}}
					aria-label="Deck B volume"
				/>
			</div>
		{/if}
	</div>
{/if}
