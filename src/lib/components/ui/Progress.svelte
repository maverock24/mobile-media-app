<script lang="ts">
	import { cn } from '$lib/utils';

	let {
		value = 0,
		max = 100,
		class: className = ''
	}: {
		value?: number;
		max?: number;
		class?: string;
	} = $props();

	const percentage = $derived(Math.min(100, Math.max(0, (value / max) * 100)));
</script>

<div class={cn('relative h-2 w-full overflow-hidden rounded-full bg-secondary', className)}>
	<div
		class="h-full bg-primary transition-all duration-150"
		style="width: {percentage}%"
	></div>
</div>
