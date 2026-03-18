<script lang="ts">
	import { onMount } from 'svelte';
	import EssayCard from '$lib/components/EssayCard.svelte';
	import Button from '$lib/components/ui/Button.svelte';
	import { essayPlayer } from '$lib/stores/essayPlayer.svelte';
	import { isValidAudioUrl } from '$lib/utils/validation';
	import type { EssayMetadata, EssayLibrary } from '$lib/models/essay';

	let essays: EssayMetadata[] = $state([]);
	let loading: boolean = $state(true);
	let error: string | null = $state(null);

	onMount(async () => {
		await loadEssays();
	});

	async function loadEssays() {
		loading = true;
		error = null;
		try {
			const response = await fetch('/data/essays.json');
			if (!response.ok) {
				throw new Error('Failed to load essays');
			}
			const data: EssayLibrary = await response.json();
			essays = data.essays;
		} catch (err) {
			error = err instanceof Error ? err.message : 'Unknown error';
			console.error('Error loading essays:', err);
		} finally {
			loading = false;
		}
	}

	async function retryLoad() {
		await loadEssays();
	}

	function handlePlayEssay(essay: EssayMetadata) {
		if (!isValidAudioUrl(essay.audioUrl)) {
			console.warn('Invalid audio URL for essay:', essay.title);
			return;
		}
		console.log('Playing:', essay.title);
		essayPlayer.selectEssay(essay);
	}
</script>

<div class="w-full h-full flex flex-col p-4 md:p-6">
	<!-- Header -->
	<header class="mb-6">
		<h1 class="text-3xl md:text-4xl font-bold mb-2">Audio Essays</h1>
		<p class="text-muted-foreground">
			Discover thought-provoking essays on science, history, philosophy, and more.
		</p>
	</header>

	<!-- Loading State -->
	{#if loading}
		<div class="flex-1 flex items-center justify-center">
			<div class="text-center">
				<div class="inline-block w-8 h-8 border-4 border-primary border-t-transparent rounded-full animate-spin mb-4"></div>
				<p class="text-muted-foreground">Loading essays...</p>
			</div>
		</div>
	{/if}

	<!-- Error State -->
	{#if error}
		<div class="flex-1 flex items-center justify-center">
			<div class="text-center">
				<p class="text-destructive font-semibold mb-2">Error loading essays</p>
				<p class="text-muted-foreground text-sm mb-4">{error}</p>
				<Button variant="default" onclick={retryLoad}>
					Retry
				</Button>
			</div>
		</div>
	{/if}

	<!-- Essays Grid -->
	{#if !loading && !error && essays.length > 0}
		<div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-2 sm:gap-3 md:gap-4 flex-1">
			{#each essays as essay, i (essay.id)}
				<EssayCard {essay} onPlay={handlePlayEssay} index={i} />
			{/each}
		</div>
	{/if}

	<!-- Empty State -->
	{#if !loading && !error && essays.length === 0}
		<div class="flex-1 flex items-center justify-center">
			<div class="text-center">
				<p class="text-muted-foreground">No essays found</p>
			</div>
		</div>
	{/if}
</div>
