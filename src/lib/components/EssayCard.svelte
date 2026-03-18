<script lang="ts">
	import { cn } from '$lib/utils';
	import { isValidAudioUrl } from '$lib/utils/validation';
	import Card from '$lib/components/ui/Card.svelte';
	import Button from '$lib/components/ui/Button.svelte';
	import Badge from '$lib/components/ui/Badge.svelte';
	import { Play, Clock, HardDrive, User } from 'lucide-svelte';
	import type { EssayMetadata } from '$lib/models/essay';

	interface Props {
		essay: EssayMetadata;
		onPlay?: (essay: EssayMetadata) => void;
		class?: string;
		index?: number;
	}

	let { essay, onPlay, class: className = '', index = 0 }: Props = $props();

	const MAX_TAGS_DISPLAY = 3;

	function formatDuration(seconds: number): string {
		if (seconds <= 0) {
			return '0m';
		}
		const hours = Math.floor(seconds / 3600);
		const minutes = Math.floor((seconds % 3600) / 60);
		if (hours > 0) {
			return `${hours}h ${minutes}m`;
		}
		return `${minutes}m`;
	}

	let isValidUrl = $derived(isValidAudioUrl(essay.audioUrl));
</script>

<Card class={cn('overflow-hidden hover:shadow-lg transition-shadow', className)}>
	<!-- Thumbnail -->
	{#if essay.thumbnail}
		<img
			src={essay.thumbnail}
			alt={essay.title}
			loading="lazy"
			fetchpriority={index < 4 ? 'high' : 'low'}
			class="w-full h-32 sm:h-40 md:h-48 object-cover bg-muted"
		/>
	{:else}
		<div role="img" aria-label={`No thumbnail for ${essay.title}`} class="w-full h-32 sm:h-40 md:h-48 bg-gradient-to-br from-primary/20 to-secondary/20 flex items-center justify-center">
			<div class="text-center text-muted-foreground">
				<div class="text-4xl mb-2">🎧</div>
				<p class="text-sm">No thumbnail</p>
			</div>
		</div>
	{/if}

	<!-- Content -->
	<div class="p-4 flex flex-col gap-3">
		<!-- Topic Badge -->
		<Badge variant="secondary" class="w-fit capitalize">
			{essay.topic}
		</Badge>

		<!-- Title -->
		<h3 class="font-semibold text-lg line-clamp-2 leading-tight">
			{essay.title}
		</h3>

		<!-- Description -->
		<p class="text-sm text-muted-foreground line-clamp-2">
			{essay.description}
		</p>

		<!-- Metadata -->
		<div class="flex flex-col gap-2 text-sm text-muted-foreground border-t pt-3">
			<!-- Author -->
			<div class="flex items-center gap-2">
				<User class="w-4 h-4 flex-shrink-0" />
				<span class="truncate">{essay.author}</span>
			</div>

			<!-- Duration and File Size -->
			<div class="flex items-center justify-between gap-2">
				<div class="flex items-center gap-2">
					<Clock class="w-4 h-4 flex-shrink-0" />
					<span>{formatDuration(essay.duration)}</span>
				</div>
				<div class="flex items-center gap-2">
					<HardDrive class="w-4 h-4 flex-shrink-0" />
					<span>{essay.fileSize} MB</span>
				</div>
			</div>
		</div>

		<!-- Tags -->
		{#if essay.tags && essay.tags.length > 0}
			<div class="flex flex-wrap gap-1">
				{#each essay.tags.slice(0, MAX_TAGS_DISPLAY) as tag}
					<span class="text-xs px-2 py-1 bg-muted rounded text-muted-foreground">
						#{tag}
					</span>
				{/each}
				{#if essay.tags.length > MAX_TAGS_DISPLAY}
					<span class="text-xs px-2 py-1 bg-muted rounded text-muted-foreground">
						+{essay.tags.length - MAX_TAGS_DISPLAY}
					</span>
				{/if}
			</div>
		{/if}

		<!-- Play Button -->
		{#if isValidUrl}
			<Button
				variant="default"
				size="default"
				class="w-full mt-2 gap-2"
				aria-label={`Play essay: ${essay.title}`}
				onclick={() => onPlay?.(essay)}
			>
				<Play class="w-4 h-4" />
				Play Essay
			</Button>
		{:else}
			<Button
				variant="default"
				size="default"
				class="w-full mt-2 gap-2"
				disabled
				title="Invalid audio URL"
			>
				<Play class="w-4 h-4" />
				Invalid audio
			</Button>
		{/if}
	</div>
</Card>
