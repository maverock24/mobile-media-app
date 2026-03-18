<script lang="ts">
	import { essayPlayer } from '$lib/stores/essayPlayer.svelte';
	import { cn } from '$lib/utils';
	import Card from '$lib/components/ui/Card.svelte';
	import Button from '$lib/components/ui/Button.svelte';
	import Badge from '$lib/components/ui/Badge.svelte';
	import Progress from '$lib/components/ui/Progress.svelte';
	import AudioPlayer from '$lib/components/AudioPlayer.svelte';
	import PlayerControls from '$lib/components/PlayerControls.svelte';
	import { ArrowLeft, Calendar, User, Tag } from 'lucide-svelte';

	function formatDate(dateString: string): string {
		const date = new Date(dateString);
		return date.toLocaleDateString('en-US', {
			year: 'numeric',
			month: 'short',
			day: 'numeric'
		});
	}

	function handleBack() {
		essayPlayer.reset();
	}
</script>

<div class="w-full h-screen flex flex-col bg-background">	<!-- Error banner -->
	{#if essayPlayer.error}
		<div class="bg-red-100 border-b border-red-400 text-red-700 px-4 py-3 flex items-center justify-between gap-4">
			<span class="flex items-center gap-2">
				<span>⚠️</span>
				<span>{essayPlayer.error}</span>
			</span>
			<button
				onclick={() => essayPlayer.setError(null)}
				class="px-3 py-1 bg-red-700 text-white text-sm rounded hover:bg-red-800 transition-colors"
				title="Clear error and retry"
			>
				Retry
			</button>
		</div>
	{/if}	<!-- Header with back button -->
	<div class="flex items-center gap-4 p-4 sm:p-6 border-b">
		<Button variant="ghost" size="icon" onclick={handleBack} title="Back to essays">
			<ArrowLeft size={24} />
		</Button>
		<div class="flex-1">
			<h1 class="text-xl sm:text-2xl font-bold truncate">{essayPlayer.currentEssay?.title || ''}</h1>
		</div>
	</div>

	<!-- Main content -->
	<div class="flex-1 overflow-y-auto">
		<div class="max-w-2xl mx-auto p-4 sm:p-6 space-y-6">
			<!-- Essay metadata card -->
			<Card class="overflow-hidden">
				<!-- Thumbnail -->
				{#if essayPlayer.currentEssay?.thumbnail}
					<img
						src={essayPlayer.currentEssay.thumbnail}
						alt={essayPlayer.currentEssay.title}
						class="w-full h-48 sm:h-64 object-cover bg-muted"
					/>
				{:else}
					<div
						role="img"
						aria-label={`No thumbnail for ${essayPlayer.currentEssay?.title || 'essay'}`}
						class="w-full h-48 sm:h-64 bg-gradient-to-br from-primary/20 to-secondary/20 flex items-center justify-center"
					>
						<div class="text-center text-muted-foreground">
							<div class="text-6xl mb-2">🎧</div>
							<p class="text-sm">No thumbnail</p>
						</div>
					</div>
				{/if}

				<!-- Content -->
				<div class="p-4 sm:p-6 space-y-4">
					<div>
						<h2 class="text-2xl sm:text-3xl font-bold mb-2">{essayPlayer.currentEssay?.title || ''}</h2>
						<p class="text-muted-foreground text-sm sm:text-base">
							{essayPlayer.currentEssay?.description || ''}
						</p>
					</div>

					<!-- Metadata -->
					<div class="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
						{#if essayPlayer.currentEssay?.author}
							<div class="flex items-center gap-2 text-muted-foreground">
								<User size={16} />
								<span>{essayPlayer.currentEssay.author}</span>
							</div>
						{/if}

						{#if essayPlayer.currentEssay?.publishedDate}
							<div class="flex items-center gap-2 text-muted-foreground">
								<Calendar size={16} />
								<span>{formatDate(essayPlayer.currentEssay.publishedDate)}</span>
							</div>
						{/if}

						{#if essayPlayer.currentEssay?.topic}
							<div class="flex items-center gap-2 text-muted-foreground">
								<Tag size={16} />
								<span>{essayPlayer.currentEssay.topic}</span>
							</div>
						{/if}
					</div>

					<!-- Tags -->
					{#if essayPlayer.currentEssay?.tags && essayPlayer.currentEssay.tags.length > 0}
						<div class="flex flex-wrap gap-2">
							{#each essayPlayer.currentEssay.tags.slice(0, 5) as tag (tag)}
								<Badge variant="secondary">{tag}</Badge>
							{/each}
						</div>
					{/if}
				</div>
			</Card>

			<!-- Player controls section -->
			<div class="bg-card border rounded-lg p-4 sm:p-6">
				<AudioPlayer />
				<PlayerControls />
			</div>
		</div>
	</div>
</div>
