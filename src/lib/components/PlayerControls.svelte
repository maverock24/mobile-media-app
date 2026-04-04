<script lang="ts">
	import { Play, Pause, SkipBack, SkipForward } from 'lucide-svelte';

	interface Props {
		isPlaying:    boolean;
		isBuffering?: boolean;
		currentTime:  number;   // seconds
		duration:     number;   // seconds
		/** If provided, skip-back button jumps back this many seconds from currentTime */
		skipBackSec?:    number;
		/** If provided, skip-forward button jumps forward this many seconds from currentTime */
		skipForwardSec?: number;
		/** Show prev/next track buttons instead of skip-by-time buttons */
		showTrackNav?: boolean;
		onPlayToggle: () => void;
		onSeek?:      (seconds: number) => void;
		onPrev?:      () => void;
		onNext?:      () => void;
	}
	let {
		isPlaying,
		isBuffering = false,
		currentTime,
		duration,
		skipBackSec    = 0,
		skipForwardSec = 0,
		showTrackNav   = false,
		onPlayToggle,
		onSeek,
		onPrev,
		onNext
	}: Props = $props();

	function formatTime(sec: number): string {
		if (!sec || sec < 0) return '0:00';
		const h = Math.floor(sec / 3600);
		const m = Math.floor((sec % 3600) / 60);
		const s = Math.floor(sec % 60);
		if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
		return `${m}:${String(s).padStart(2, '0')}`;
	}

	function handleSeekInput(e: Event) {
		const pct = Number((e.target as HTMLInputElement).value);
		onSeek?.(duration > 0 ? (pct / 100) * duration : 0);
	}

	function handleSkipBack() {
		if (skipBackSec > 0) onSeek?.(Math.max(0, currentTime - skipBackSec));
		else onPrev?.();
	}

	function handleSkipForward() {
		if (skipForwardSec > 0) onSeek?.(Math.min(duration || 0, currentTime + skipForwardSec));
		else onNext?.();
	}

	const progress = $derived(duration > 0 ? (currentTime / duration) * 100 : 0);
</script>

<div class="select-none">
	<!-- Seek slider -->
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
	<div class="flex justify-between text-[10px] text-muted-foreground mt-0.5 mb-3">
		<span>{formatTime(currentTime)}</span>
		<span>{duration > 0 ? formatTime(duration) : '--:--'}</span>
	</div>

	<!-- Control buttons -->
	<div class="flex items-center justify-center gap-6">
		<!-- Skip back / Prev track -->
		{#if showTrackNav || skipBackSec > 0}
			<button
				class="w-11 h-11 flex items-center justify-center rounded-full hover:bg-accent transition-colors text-muted-foreground hover:text-foreground"
				onclick={handleSkipBack}
				aria-label={skipBackSec > 0 ? `Skip back ${skipBackSec}s` : 'Previous track'}
			>
				<SkipBack class="w-6 h-6" />
			</button>
		{/if}

		<!-- Play / Pause -->
		<button
			class="w-16 h-16 flex items-center justify-center rounded-full bg-primary text-primary-foreground hover:bg-primary/90 transition-colors shadow-lg"
			onclick={onPlayToggle}
			aria-label={isPlaying ? 'Pause' : 'Play'}
		>
			{#if isBuffering}
				<div class="w-7 h-7 border-2 border-primary-foreground border-t-transparent rounded-full animate-spin"></div>
			{:else if isPlaying}
				<Pause class="w-7 h-7" />
			{:else}
				<Play class="w-7 h-7 ml-0.5" />
			{/if}
		</button>

		<!-- Skip forward / Next track -->
		{#if showTrackNav || skipForwardSec > 0}
			<button
				class="w-11 h-11 flex items-center justify-center rounded-full hover:bg-accent transition-colors text-muted-foreground hover:text-foreground"
				onclick={handleSkipForward}
				aria-label={skipForwardSec > 0 ? `Skip forward ${skipForwardSec}s` : 'Next track'}
			>
				<SkipForward class="w-6 h-6" />
			</button>
		{/if}
	</div>
</div>
