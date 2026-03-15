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
		default: 'bg-primary text-primary-foreground hover:bg-primary/90',
		outline: 'border border-input bg-background hover:bg-accent hover:text-accent-foreground',
		ghost: 'hover:bg-accent hover:text-accent-foreground',
		destructive: 'bg-destructive text-destructive-foreground hover:bg-destructive/90',
		secondary: 'bg-secondary text-secondary-foreground hover:bg-secondary/80'
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
		'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50',
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
