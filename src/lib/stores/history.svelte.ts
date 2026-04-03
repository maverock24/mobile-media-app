import { persisted } from '$lib/persisted.svelte';
import type { MediaItem } from '$lib/models/media';

export const historyStore = persisted('play-history', {
	recent: [] as MediaItem[]
});

export function addToHistory(item: MediaItem) {
	if (!item) return;

	// Filter out the item if it already exists to move it to the top
	const filtered = historyStore.recent.filter(i => 
		i.audioUrl !== item.audioUrl || i.title !== item.title
	);

	// Add to start and limit to 50 items
	historyStore.recent = [structuredClone(item), ...filtered].slice(0, 50);
}

export function clearHistory() {
	historyStore.recent = [];
}
