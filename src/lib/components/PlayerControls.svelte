<script lang="ts">
	import { essayPlayer } from '$lib/stores/essayPlayer.svelte';
	import { cn } from '$lib/utils';
	import Button from '$lib/components/ui/Button.svelte';
	import Slider from '$lib/components/ui/Slider.svelte';
	import { Play, Pause, Volume2, VolumeX, Zap } from 'lucide-svelte';

	const PLAYBACK_RATES = [0.75, 1.0, 1.25, 1.5];

	function formatTime(seconds: number): string {
		seconds = Math.max(0, seconds);
		if (!Number.isFinite(seconds)) return '0:00';
		const hours = Math.floor(seconds / 3600);
		const minutes = Math.floor((seconds % 3600) / 60);
		const secs = Math.floor(seconds % 60);
		const pad = (n: number) => String(n).padStart(2, '0');

		if (hours > 0) {
			return `${hours}:${pad(minutes)}:${pad(secs)}`;
		}
		return `${minutes}:${pad(secs)}`;
	}

	function handlePlayToggle() {
		essayPlayer.togglePlayback();
	}

	function handleProgressChange(e: Event) {
		const target = e.target as HTMLInputElement;
		const time = (parseInt(target.value) / 100) * essayPlayer.duration;
		essayPlayer.seekTo(time);
	}

	function handleVolumeChange(e: Event) {
		const target = e.target as HTMLInputElement;
		essayPlayer.setVolume(parseInt(target.value) / 100);
	}

	function handleMuteToggle() {
		if (essayPlayer.volume > 0) {
			essayPlayer.setVolume(0);
		} else {
			essayPlayer.setVolume(0.8);
		}
	}

	function handlePlaybackRateChange(rate: number) {
		essayPlayer.setPlaybackRate(rate);
	}

	const volumePercentage = $derived(Math.round(essayPlayer.volume * 100));
</script>

<div class="w-full space-y-4">
	<!-- Progress Bar -->
	<div class="space-y-2">
		<fieldset class="space-y-2">
			<legend class="sr-only">Seek audio position</legend>
			<Slider
				value={essayPlayer.progress}
				min={0}
				max={100}
				step={0.1}
				oninput={handleProgressChange}
				class="cursor-pointer"
			/>
		</fieldset>
		<div class="flex justify-between text-xs text-muted-foreground">
			<span>{formatTime(essayPlayer.currentTime)}</span>
			<span>{formatTime(essayPlayer.duration)}</span>
		</div>
	</div>

	<!-- Controls -->
	<div class="flex items-center justify-between gap-4">
		<!-- Play/Pause Button -->
		<Button
			variant="default"
			size="icon"
			onclick={handlePlayToggle}
			class="w-14 h-14"
			title={essayPlayer.isPlaying ? 'Pause' : 'Play'}
		>
			{#if essayPlayer.isPlaying}
				<Pause size={24} />
			{:else}
				<Play size={24} />
			{/if}
		</Button>

		<!-- Volume Control -->
		<fieldset class="flex items-center gap-2 flex-1 max-w-xs">
			<legend class="sr-only">Adjust volume</legend>
			<Button
				variant="ghost"
				size="icon"
				onclick={handleMuteToggle}
				title={essayPlayer.volume > 0 ? 'Mute' : 'Unmute'}
			>
				{#if essayPlayer.volume > 0}
					<Volume2 size={20} />
				{:else}
					<VolumeX size={20} />
				{/if}
			</Button>
			<Slider
				value={volumePercentage}
				min={0}
				max={100}
				step={1}
				oninput={handleVolumeChange}
				class="flex-1 cursor-pointer"
			/>
			<span class="text-xs text-muted-foreground w-8">{volumePercentage}%</span>
		</fieldset>

		<!-- Playback Rate Selector -->
		<div class="flex items-center gap-2">
			<span class="text-xs text-muted-foreground hidden sm:inline">Speed:</span>
			<div class="flex gap-1">
				{#each PLAYBACK_RATES as rate (rate)}
					<Button
						variant={essayPlayer.playbackRate === rate ? 'default' : 'outline'}
						size="sm"
						onclick={() => handlePlaybackRateChange(rate)}
						title={`${rate}x playback speed`}
						class="px-2 h-8 text-xs min-w-[3rem]"
					>
						{rate}x
					</Button>
				{/each}
			</div>
		</div>
	</div>
</div>
