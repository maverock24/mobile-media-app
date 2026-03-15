<script lang="ts">
	import { cn } from '$lib/utils';

	let {
		value = 0,
		min = 0,
		max = 100,
		step = 1,
		class: className = '',
		oninput
	}: {
		value?: number;
		min?: number;
		max?: number;
		step?: number;
		class?: string;
		oninput?: (e: Event) => void;
	} = $props();
</script>

<input
	type="range"
	{min}
	{max}
	{step}
	bind:value
	{oninput}
	class={cn(
		'w-full h-2 rounded-full appearance-none cursor-pointer bg-secondary accent-primary',
		className
	)}
/>
