<script lang="ts">
	import { cn } from '$lib/utils';

	let {
		class: className = '',
		variant = 'default',
		size = 'default',
		disabled = false,
		onclick,
		children,
		...rest
	}: {
		class?: string;
		variant?: 'default' | 'outline' | 'ghost' | 'destructive' | 'secondary';
		size?: 'default' | 'sm' | 'lg' | 'icon';
		disabled?: boolean;
		onclick?: (e: MouseEvent) => void;
		children?: import('svelte').Snippet;
		[key: string]: unknown;
	} = $props();

	const variants: Record<string, string> = {
		default: 'ui-button-depth ui-button-primary border bg-primary text-primary-foreground hover:bg-primary/92',
		outline: 'ui-button-depth ui-button-outline border bg-background/82 text-foreground hover:bg-accent/86 hover:text-accent-foreground',
		ghost: 'ui-button-depth ui-button-ghost border border-transparent bg-white/3 text-foreground hover:bg-accent/78 hover:text-accent-foreground',
		destructive: 'ui-button-depth border border-destructive/55 bg-destructive text-destructive-foreground hover:bg-destructive/92',
		secondary: 'ui-button-depth ui-button-secondary border bg-secondary/92 text-secondary-foreground hover:bg-secondary/82'
	};

	const sizes: Record<string, string> = {
		default: 'h-10 px-4 py-2',
		sm: 'h-9 rounded-md px-3',
		lg: 'h-11 rounded-md px-8',
		icon: 'h-10 w-10'
	};
</script>

<button
	{disabled}
	{onclick}
	class={cn(
		'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-semibold tracking-[0.01em] ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 disabled:shadow-none disabled:before:opacity-0 disabled:after:opacity-0',
		variants[variant],
		sizes[size],
		className
	)}
	{...rest}
>
	{#if children}
		{@render children()}
	{/if}
</button>
