import type { BrowseEntry, StoredAudioFile } from '$lib/stores/library.svelte';

/**
 * Lightweight reactive bridge: the Music tab (Mp3PlayerView) writes its browse state here,
 * and the Mixer reads it so both views see the same folder / file list without needing
 * the user to pick a library folder a second time.
 */
export const mixerShared = $state<{
	browsePath: string[];
	allFiles: StoredAudioFile[];
	browseEntries: BrowseEntry[];
	browseLoading: boolean;
}>({
	browsePath: [],
	allFiles: [],
	browseEntries: [],
	browseLoading: false,
});
