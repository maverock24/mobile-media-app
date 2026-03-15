<script lang="ts">
	import { cn } from '$lib/utils';

	let {
		class: className = '',
		children
	}: {
		class?: string;
		children?: import('svelte').Snippet;
	} = $props();
</script>

<div class={cn('rounded-xl border bg-card text-card-foreground shadow', className)}>
	{#if children}
		{@render children()}
	{/if}
</div>
