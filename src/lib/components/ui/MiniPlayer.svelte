<script lang="ts">
	import { mediaEngine } from '$lib/stores/mediaEngine.svelte';
	import { openYoutubePanel } from '$lib/stores/youtubePanel.svelte';
	import { requestMusicPlayerView } from '$lib/stores/musicView.svelte';
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
	import { Play, Pause, SkipBack, SkipForward, Moon, X, Repeat, Volume2, Gauge, MoreVertical } from 'lucide-svelte';

	interface Props {
		/** The currently selected tab. */
		activeTab: string;
		/** Whether the shared controls are rendered above or below content. */
		position?: 'top' | 'bottom';
		/** Clicking the bar body navigates back to the owning tab */
		onNavigateTo?: (tab: string) => void;
	}
	let { activeTab, position = 'bottom', onNavigateTo }: Props = $props();
	let showMenu = $state(false);
	let showSleepTimerOptions = $state(false);
	let showMusicSpeedOptions = $state(false);

	// Which source the visible view drives. `activeView` is published by
	// +page.svelte and kept in lockstep with the A / B / YouTube sub-tabs, so the
	// MiniPlayer shows (and controls) exactly the source on screen — even when
	// Deck B is mixing with another playing source.
	const displayKind = $derived.by((): 'A' | 'B' | 'youtube' | 'podcast' | 'radio' | 'global' => {
		switch (mediaEngine.activeView) {
			case 'music:A':       return 'A';
			case 'music:B':       return 'B';
			case 'music:youtube': return 'youtube';
			case 'podcasts':      return 'podcast';
			case 'radio':         return 'radio';
			default:              return 'global';
		}
	});
	const isDeckDisplay = $derived(displayKind === 'A' || displayKind === 'B');

	const ownerTab = $derived.by((): string | null => {
		switch (displayKind) {
			case 'A': case 'B': case 'youtube': return 'music';
			case 'podcast': return 'podcasts';
			case 'radio':   return 'radio';
			default: {
				// Weather / settings own no source — follow the engine's source,
				// falling back to whatever per-source flag is set.
				switch (mediaEngine.source) {
					case 'music':   return 'music';
					case 'youtube': return 'music';
					case 'podcast': return 'podcasts';
					case 'radio':   return 'radio';
				}
				if (mediaEngine.musicPlayingA || mediaEngine.musicPlayingB) return 'music';
				if (mediaEngine.youtubePlaying) return 'music';
				if (mediaEngine.podcastPlaying) return 'podcasts';
				if (mediaEngine.radioPlaying) return 'radio';
				return null;
			}
		}
	});

	const deckItem = $derived(
		displayKind === 'A' ? mediaEngine.deckAItem
			: displayKind === 'B' ? mediaEngine.deckBItem
			: mediaEngine.item
	);
	const deckCurrentTime = $derived(
		displayKind === 'A' ? mediaEngine.deckACurrentTime
			: displayKind === 'B' ? mediaEngine.deckBCurrentTime
			: mediaEngine.currentTime
	);
	const deckDuration = $derived(
		displayKind === 'A' ? mediaEngine.deckADuration
			: displayKind === 'B' ? mediaEngine.deckBDuration
			: mediaEngine.duration
	);

	// The play/pause state of the source that is actually on screen.
	const isPlaying = $derived(
		displayKind === 'A' ? mediaEngine.musicPlayingA
			: displayKind === 'B' ? mediaEngine.musicPlayingB
			: displayKind === 'youtube' ? mediaEngine.youtubePlaying
			: displayKind === 'podcast' ? mediaEngine.podcastPlaying
			: displayKind === 'radio' ? mediaEngine.radioPlaying
			: mediaEngine.isPlaying
	);

	const isBuffering = $derived(
		displayKind === 'A' ? mediaEngine.deckABuffering
			: displayKind === 'B' ? mediaEngine.deckBBuffering
			: false
	);

	const displayTitle = $derived(
		deckItem?.title ??
		(isDeckDisplay ? `Deck ${displayKind}` : undefined)
	);
	const displaySubtitle = $derived(
		deckItem
			? (isDeckDisplay
				? `Deck ${displayKind} · ${deckItem.subtitle ?? ''}`
				: deckItem.subtitle)
			: (isDeckDisplay ? 'No track loaded' : undefined)
	);

	// Always visible on the music tab. Otherwise only when something is playing
	// or a track is loaded.
	const visible = $derived(
		activeTab === 'music' ||
		mediaEngine.item !== null ||
		mediaEngine.podcastPlaying ||
		mediaEngine.radioPlaying ||
		mediaEngine.youtubePlaying ||
		mediaEngine.musicPlayingA ||
		mediaEngine.musicPlayingB
	);

	const progress = $derived(
		deckDuration > 0
			? (deckCurrentTime / deckDuration) * 100
			: 0
	);

	// CSS-driven progress bar: the fill div uses transition:width for smooth
	// animation between 4Hz ticks, and the range input overlay handles seeking.
	// During drag we disable the transition so the bar follows the finger instantly.
	let seekDragging = $state(false);
	let dragProgress = $state(0);
	const displayProgress = $derived(seekDragging ? dragProgress : progress);

	function handleSeekPointerDown(e: PointerEvent) {
		seekDragging = true;
		dragProgress = progress;
		updateDragFromEvent(e);
	}

	function handleSeekPointerMove(e: PointerEvent) {
		if (!seekDragging) return;
		updateDragFromEvent(e);
	}

	function handleSeekPointerUp(e: PointerEvent) {
		if (!seekDragging) return;
		seekDragging = false;
		updateDragFromEvent(e);
		const target = deckDuration > 0 ? (dragProgress / 100) * deckDuration : 0;
		seekTo(Math.max(0, Math.min(target, deckDuration || 0)));
	}

	function updateDragFromEvent(e: PointerEvent) {
		const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
		const x = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
		dragProgress = x * 100;
	}


	const canSeek = $derived(
		displayKind === 'A' || displayKind === 'B' || displayKind === 'youtube' || displayKind === 'podcast'
		// Weather / settings follow the engine source, so keep their seek bar.
		|| (displayKind === 'global'
			&& (mediaEngine.source === 'music' || mediaEngine.source === 'podcast' || mediaEngine.source === 'youtube'))
	);
	const canSkipPrevious = $derived(mediaEngine._onPrev !== null);
	const canSkipNext = $derived(mediaEngine._onNext !== null);
	const showPodcastSpeedPreset = $derived(
		displayKind === 'podcast' || (displayKind === 'global' && mediaEngine.source === 'podcast')
	);
	const podcastOneAndHalfActive = $derived(showPodcastSpeedPreset && podcastSettings.playbackSpeed === 1.5);
	const sleepTimerLabel = $derived(
		sleepTimer.isActive ? formatSleepTimerRemaining(sleepTimer.remainingMs) : 'Off'
	);
	// The mini-player speed button always controls Deck A's playback speed
	// (a dedicated Deck A speed control, independent of the active deck).
	const deckASpeed = $derived(musicSettings.deckASpeed);

	function seekTo(time: number) {
		const target = Math.max(0, Math.min(time, deckDuration || 0));
		mediaEngine._onSeek?.(target) ?? mediaEngine.seek(target);
	}

	function togglePlayback() {
		if (isPlaying) {
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

	function toggleMenu() {
		showMenu = !showMenu;
	}

	function openSleepOptions() {
		showMenu = false;
		showSleepTimerOptions = true;
		showMusicSpeedOptions = false;
	}

	function openSpeedOptions() {
		showMenu = false;
		showMusicSpeedOptions = true;
		showSleepTimerOptions = false;
	}

	function applyMusicSpeed(speed: number) {
		musicSettings.deckASpeed = speed;
		showMusicSpeedOptions = false;
		void triggerToggleHaptic(true);
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
				onclick={() => {
					if (!ownerTab) return;
					// Returning to YouTube playback should land on the panel, not just
					// the tab it happens to live on.
					if (displayKind === 'youtube') openYoutubePanel();
					// Switching tabs alone did nothing while the Music tab was already
					// active, which made this button dead exactly when it was needed:
					// the file browser has no other way back to the now-playing screen.
					requestMusicPlayerView();
					onNavigateTo?.(ownerTab);
				}}
				aria-label="Return to {ownerTab} player"
			>
				<p class="mini-player-info-title text-sm font-semibold leading-tight truncate">{displayTitle}</p>
				<p class="mini-player-info-subtitle text-xs text-muted-foreground leading-tight truncate mt-0.5">{displaySubtitle}</p>
			</button>

			<div class="relative min-h-[3.5rem]">
				<div class="absolute left-0 top-1/2 -translate-y-1/2 flex items-center gap-1.5">
					<button
						class="mini-player-action mini-player-control-surface w-9 h-9 flex items-center justify-center rounded-full {showMenu ? 'text-primary' : 'text-muted-foreground hover:text-foreground'}"
						onclick={toggleMenu}
						aria-label="More options"
						aria-pressed={showMenu}
						title="Sleep timer · Playback speed"
					>
						<MoreVertical class="w-4 h-4 {sleepTimer.isActive ? 'text-primary' : ''}" />
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
						aria-label={isBuffering ? 'Loading' : isPlaying ? 'Pause' : 'Play'}
					>
						{#if isBuffering}
							<div class="w-7 h-7 border-2 border-current border-t-transparent rounded-full animate-spin" aria-hidden="true"></div>
						{:else if isPlaying}
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

				{#if showPodcastSpeedPreset && activeTab !== 'music'}
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

		{#if showMenu}
			<div class="px-3 pb-2 flex flex-wrap gap-2">
				<button
					class="mini-player-chip mini-player-control-surface inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs"
					onclick={openSleepOptions}
					aria-label="Sleep timer"
				>
					<Moon class="w-3.5 h-3.5 {sleepTimer.isActive ? 'text-primary' : ''}" />
					Sleep timer{sleepTimer.isActive ? ` · ${sleepTimerLabel}` : ''}
				</button>
				{#if activeTab === 'music'}
					<button
						class="mini-player-chip mini-player-control-surface inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs"
						onclick={openSpeedOptions}
						aria-label="Playback speed"
					>
						<Gauge class="w-3.5 h-3.5" />
						Speed · {deckASpeed}×
					</button>
				{/if}
			</div>
		{/if}

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

		{#if showMusicSpeedOptions}
			<div class="px-3 pb-2 space-y-2">
				<div class="flex items-center justify-between text-[11px] text-muted-foreground">
					<span>Playback speed · Deck A</span>
				</div>
				<div class="flex flex-wrap gap-2">
					{#each [0.5, 0.75, 0.8, 1.0, 1.25, 1.5, 1.75, 2.0] as speed}
						<button
							class="mini-player-chip mini-player-control-surface px-3 py-1.5 rounded-full text-xs {deckASpeed === speed ? 'border-primary bg-primary/18 text-primary font-medium' : 'text-foreground'}"
							onclick={() => applyMusicSpeed(speed)}
						>
							{speed}×
						</button>
					{/each}
				</div>
			</div>
		{/if}

		{#if canSeek}
			<div class="px-3 pb-2">
				<!-- CSS-driven progress bar with transparent seek overlay.
				     The fill div animates smoothly via CSS transition between ticks.
				     During pointer drag we disable the transition for instant feedback. -->
				<div
					class="relative w-full h-4 flex items-center cursor-pointer touch-none select-none"
					role="slider"
					tabindex="0"
					aria-label="Seek"
					aria-valuemin="0"
					aria-valuemax="100"
					aria-valuenow={Math.round(displayProgress)}
					onpointerdown={handleSeekPointerDown}
					onpointermove={handleSeekPointerMove}
					onpointerup={handleSeekPointerUp}
					onpointerleave={() => { if (seekDragging) { seekDragging = false; } }}
					onpointercancel={() => { if (seekDragging) { seekDragging = false; } }}
				>
					<!-- Track background -->
					<div class="absolute inset-x-0 top-1/2 -translate-y-1/2 h-2 rounded-full bg-muted"></div>
					<!-- Fill bar -- transition gives smooth animation between 4Hz ticks -->
					<div
						class="absolute left-0 top-1/2 -translate-y-1/2 h-2 rounded-full bg-primary"
						style="width:{displayProgress}%;{seekDragging ? '' : 'transition: width 250ms linear;'}"
					></div>
					<!-- Thumb dot -->
					<div
						class="absolute top-1/2 -translate-y-1/2 w-3.5 h-3.5 rounded-full bg-primary shadow-md shadow-primary/40 {seekDragging ? 'scale-125' : ''}"
						style="left:calc({displayProgress}% - 7px);"
					></div>
				</div>
				<div class="flex justify-between text-[10px] text-muted-foreground mt-0.5">
					<span>{formatTime(deckCurrentTime)}</span>
					<span>{deckDuration > 0 ? formatTime(deckDuration) : '--:--'}</span>
				</div>
			</div>
		{/if}

		{#if displayKind === 'B' || (displayKind === 'global' && mediaEngine.source === 'music' && mediaEngine.activeMusicDeck === 'B')}
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
