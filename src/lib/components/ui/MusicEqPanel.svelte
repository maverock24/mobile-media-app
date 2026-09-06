<script lang="ts">
	import { EQ_FREQS, EQ_LABELS, EQ_PRESETS, fmtGain } from '$lib/models/music';

	interface Props {
		eqBands: number[];
		equalizerPreset: string;
		eqAvailable?: boolean;
		onApplyPreset: (preset: string) => void;
		/** High-frequency drag handler (fires on every input event). The owner
		 *  applies the gain live to the audio filters but must NOT write the
		 *  persisted settings here — see onSetBand for the single commit. */
		onLiveBand?: (index: number, value: number) => void;
		/** Commit handler (fires once per drag, on release). The owner persists. */
		onSetBand: (index: number, value: number) => void;
	}

	let { eqBands, equalizerPreset, eqAvailable = true, onApplyPreset, onLiveBand, onSetBand }: Props = $props();

	// Local editable copy. Bands are edited here during a drag and only committed
	// back through onSetBand on release, so dragging never writes to the persisted
	// settings store on every tick. eqBands (the committed baseline) is synced in
	// whenever it changes externally (preset / reset / restore).
	const vals = $state<number[]>([]);
	$effect(() => {
		for (let i = 0; i < eqBands.length; i++) {
			if (eqBands[i] !== vals[i]) vals[i] = eqBands[i];
		}
	});

	function onInput(i: number, value: number) {
		vals[i] = value; // live thumb + label
		onLiveBand?.(i, value);
	}

	function onCommit(i: number) {
		onSetBand(i, vals[i]);
	}
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
					bind:value={vals[i]}
					oninput={(e) => onInput(i, +(e.target as HTMLInputElement).value)}
					onchange={() => onCommit(i)}
					onpointerup={() => onCommit(i)}
					class="flex-1 h-1.5 rounded-full appearance-none cursor-pointer bg-secondary accent-primary" />
				<span class="text-[10px] text-muted-foreground w-9 text-right shrink-0 tabular-nums">{fmtGain(vals[i])}dB</span>
			</div>
		{/each}
	</div>
</div>
