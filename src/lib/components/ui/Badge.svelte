<script lang="ts">
	import { cn } from '$lib/utils';

	let {
		class: className = '',
		variant = 'default',
		children
	}: {
		class?: string;
		variant?: 'default' | 'secondary' | 'outline' | 'destructive';
		children?: import('svelte').Snippet;
	} = $props();

	const variants: Record<string, string> = {
		default: 'border-transparent bg-primary text-primary-foreground',
		secondary: 'border-transparent bg-secondary text-secondary-foreground',
		outline: 'text-foreground',
		destructive: 'border-transparent bg-destructive text-destructive-foreground'
	};
</script>

<div
	class={cn(
		'inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold transition-colors',
		variants[variant],
		className
	)}
>
	{#if children}
		{@render children()}
	{/if}
</div>
