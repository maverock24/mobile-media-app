import type { BrowseEntry, StoredAudioFile } from '$lib/stores/library.svelte';

/**
 * Lightweight reactive bridge:
 * - Music tab (Mp3PlayerView) writes browse state (allFiles, browseEntries, …)
 * - Mixer reads browse state and writes playback hooks (playBoth, anyDeckLoaded)
 * - MiniPlayer reads playback hooks to control both mixer decks
 */
export const mixerShared = $state<{
	browsePath: string[];
	allFiles: StoredAudioFile[];
	browseEntries: BrowseEntry[];
	browseLoading: boolean;
	/** true when at least one mixer deck has a track loaded. */
	anyDeckLoaded: boolean;
	/** true when at least one mixer deck is actively playing. */
	anyPlaying: boolean;
	/** Deck A's display name, surfaced so the MiniPlayer can show it as the
	 *  now-playing title/subtitle on the mixer tab. */
	deckALabel: string;
	/** Play both decks (set by MixerView on mount). */
	playBoth: (() => void) | null;
}>({
	browsePath: [],
	allFiles: [],
	browseEntries: [],
	browseLoading: false,
	anyDeckLoaded: false,
	anyPlaying: false,
	deckALabel: '',
	playBoth: null,
});
