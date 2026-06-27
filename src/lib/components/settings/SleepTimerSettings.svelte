<script lang="ts">
	import {
		sleepTimer,
		SLEEP_TIMER_PRESETS,
		setSleepTimer,
		clearSleepTimer,
	} from '$lib/stores/sleepTimer.svelte';
	import Button from '$lib/components/ui/Button.svelte';

	const sleepTimerSummary = $derived(
		sleepTimer.isActive
			? `Active · ${Math.ceil(sleepTimer.remainingMs / 60_000)} min remaining`
			: 'Off'
	);
</script>

<div class="settings-panel-body px-4 pb-4 space-y-4">
	<p class="text-xs text-muted-foreground leading-relaxed">
		Automatically pause music, podcasts, or radio after a preset duration. The timer keeps its target time across tab switches and app resume.
	</p>

	<div>
		<p class="text-sm font-medium mb-2">Quick Presets</p>
		<div class="flex flex-wrap gap-2">
			{#each SLEEP_TIMER_PRESETS as minutes}
				<button
					class="px-3 py-1.5 rounded-lg text-xs border transition-colors {sleepTimer.isActive && sleepTimer.lastDurationMin === minutes ? 'border-primary bg-primary/10 text-primary font-medium' : 'border-border hover:bg-accent'}"
					onclick={() => setSleepTimer(minutes)}
				>
					{minutes} minutes
				</button>
			{/each}
		</div>
	</div>

	<div class="settings-control-card rounded-xl border px-3 py-3 flex items-center justify-between gap-3">
		<div>
			<p class="text-sm font-medium">Current timer</p>
			<p class="text-xs text-muted-foreground">{sleepTimerSummary}</p>
		</div>
		<Button variant="outline" class="gap-2 shrink-0" onclick={() => clearSleepTimer()} disabled={!sleepTimer.isActive}>
			Off
		</Button>
	</div>
</div>
