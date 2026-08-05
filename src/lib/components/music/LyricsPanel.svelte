<script lang="ts">
	import { findActiveLineIndex } from '$lib/lyrics/lrc';
	import type { LyricsResult } from '$lib/lyrics/types';

	interface Props {
		lyrics: LyricsResult;
		currentTimeSec: number;
	}

	let { lyrics, currentTimeSec }: Props = $props();

	const activeLineIndex = $derived(
		lyrics.source === 'lrc'
			? findActiveLineIndex(lyrics.lines, currentTimeSec)
			: -1
	);

	// Auto-scroll: when the active line changes, scroll it into view.
	// We use a reactive statement that reads activeLineIndex, then
	// schedules a DOM update via requestAnimationFrame.
	let scrollContainer = $state<HTMLElement | null>(null);
	let _lastScrolledIndex = -1;

	$effect(() => {
		const idx = activeLineIndex;
		if (idx < 0 || idx === _lastScrolledIndex) return;
		_lastScrolledIndex = idx;
		if (!scrollContainer) return;

		const activeEl = scrollContainer.querySelector(`[data-line-index="${idx}"]`) as HTMLElement | null;
		if (activeEl) {
			requestAnimationFrame(() => {
				activeEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
			});
		}
	});
</script>

<div class="flex flex-col h-full">
	{#if lyrics.source === 'lrc' && lyrics.lines.length > 0}
		<div
			bind:this={scrollContainer}
			class="flex-1 overflow-y-auto px-4 py-6 space-y-3 text-center"
		>
			{#each lyrics.lines as line, i}
				{@const isActive = i === activeLineIndex}
				{@const isPast = i < activeLineIndex}
				<p
					data-line-index={i}
					class="transition-all duration-300 select-none {isActive
						? 'text-primary text-lg font-semibold scale-105'
						: isPast
							? 'text-muted-foreground/40 text-sm'
							: 'text-muted-foreground/60 text-sm'}"
				>
					{line.text}
				</p>
			{/each}
		</div>
	{:else if lyrics.source === 'text'}
		<div class="flex-1 overflow-y-auto px-4 py-6">
			<p class="text-sm text-muted-foreground whitespace-pre-wrap leading-relaxed">{lyrics.text}</p>
		</div>
	{:else}
		<div class="flex-1 flex items-center justify-center px-4 py-12">
			<p class="text-sm text-muted-foreground text-center">
				No lyrics found for this track.<br />
				<span class="text-xs opacity-60 mt-1 block">
					Place a .lrc file with the same name as the MP3 in the same folder.
				</span>
			</p>
		</div>
	{/if}
</div>
