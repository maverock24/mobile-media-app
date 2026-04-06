<script lang="ts">
	import { toasts, dismissToast } from '$lib/stores/toastStore.svelte';
	import { cn } from '$lib/utils';
	import { X } from 'lucide-svelte';
	import { fly } from 'svelte/transition';

	const typeStyles: Record<string, string> = {
		error:   'bg-destructive text-destructive-foreground',
		warning: 'bg-yellow-600 text-white',
		info:    'bg-primary text-primary-foreground'
	};
</script>

{#if toasts.length > 0}
	<div
		class="fixed bottom-20 left-1/2 z-50 flex w-full max-w-sm -translate-x-1/2 flex-col gap-2 px-4"
		aria-live="polite"
		aria-atomic="false"
	>
		{#each toasts as toast (toast.id)}
			<div
				class={cn(
					'flex items-start gap-2 rounded-lg px-4 py-3 shadow-lg',
					typeStyles[toast.type] ?? typeStyles.error
				)}
				role="alert"
				transition:fly={{ y: 40, duration: 200 }}
			>
				<p class="flex-1 text-sm font-medium">{toast.message}</p>

				{#if toast.action}
					<button
						class="shrink-0 text-sm font-semibold underline underline-offset-2 opacity-90 hover:opacity-100"
						onclick={() => {
							toast.action?.handler();
							dismissToast(toast.id);
						}}
					>
						{toast.action.label}
					</button>
				{/if}

				<button
					class="shrink-0 opacity-70 hover:opacity-100"
					onclick={() => dismissToast(toast.id)}
					aria-label="Dismiss"
				>
					<X class="h-4 w-4" />
				</button>
			</div>
		{/each}
	</div>
{/if}
