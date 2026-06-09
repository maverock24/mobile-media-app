<script lang="ts">
	import { EQ_FREQS, EQ_LABELS, EQ_PRESETS, fmtGain } from '$lib/models/music';

	interface Props {
		eqBands: number[];
		equalizerPreset: string;
		eqAvailable?: boolean;
		onApplyPreset: (preset: string) => void;
		onSetBand: (index: number, value: number) => void;
	}

	let { eqBands, equalizerPreset, eqAvailable = true, onApplyPreset, onSetBand }: Props = $props();
</script>

<div class="border-t bg-card/95 px-4 pt-3 pb-3 shrink-0">
	<div class="flex items-center justify-between mb-2">
		<p class="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Equalizer</p>
		<button class="text-xs text-muted-foreground hover:text-foreground px-2 py-0.5 rounded hover:bg-accent transition-colors"
			onclick={() => onApplyPreset('flat')}>Reset</button>
	</div>
	<div class="flex gap-1.5 flex-wrap mb-3">
		{#each Object.keys(EQ_PRESETS) as preset}
			<button
				class="px-2.5 py-1 rounded-full text-xs capitalize border transition-colors {equalizerPreset === preset ? 'bg-primary text-primary-foreground border-primary' : 'border-border hover:bg-accent'}"
				onclick={() => onApplyPreset(preset)}
			>{preset}</button>
		{/each}
	</div>
	<div class="space-y-2">
		{#each EQ_FREQS as _freq, i}
			<div class="flex items-center gap-2">
				<span class="text-[10px] text-muted-foreground w-9 text-right shrink-0 tabular-nums">{EQ_LABELS[i]}</span>
				<input type="range" min="-12" max="12" step="1"
					value={eqBands[i]}
					oninput={(e) => onSetBand(i, +(e.target as HTMLInputElement).value)}
					class="flex-1 h-1.5 rounded-full appearance-none cursor-pointer bg-secondary accent-primary" />
				<span class="text-[10px] text-muted-foreground w-9 text-right shrink-0 tabular-nums">{fmtGain(eqBands[i])}dB</span>
			</div>
		{/each}
	</div>
</div>
