/**
 * Cross-component requests shared by the music views.
 *
 * `Mp3PlayerView` owns the browse/player toggle (`showQueue`), but the
 * MiniPlayer that drives it lives at the shell level. The view is mounted twice
 * (one instance per music deck), so every instance registers a handler and a
 * request applies to all of them — that way both decks agree on which view is
 * showing, instead of only the last-mounted one reacting.
 *
 * Mirrors the registerAudioSource/claimAudio registry in mediaEngine.
 */

const _showPlayerHandlers = new Set<() => void>();

/** Register a handler that switches the player away from the file browser.
 *  Returns an unregister function, for use as an `$effect` cleanup. */
export function registerMusicPlayerView(handler: () => void): () => void {
	_showPlayerHandlers.add(handler);
	return () => {
		_showPlayerHandlers.delete(handler);
	};
}

/** Ask every mounted music view to show the now-playing screen. */
export function requestMusicPlayerView(): void {
	for (const handler of _showPlayerHandlers) handler();
}

/**
 * The event the mounted music views listen for to rebuild the library index.
 *
 * A window event rather than a second handler registry, because the request can
 * come from any screen (Settings, the YouTube panel) that holds no reference to
 * the views.
 */
export const LIBRARY_RESCAN_EVENT = 'music-library:rescan';

/**
 * Ask every mounted music view to rebuild the library index.
 *
 * The browse view lists from that index rather than from the disk, so a file
 * written by the app itself stays invisible in the Music tab until the index is
 * rebuilt. Both decks rebuild their own copy.
 */
export function requestLibraryRescan(): void {
	window.dispatchEvent(new CustomEvent(LIBRARY_RESCAN_EVENT));
}

/**
 * Whether the music view is in favorites mode. Shared across decks A/B and
 * the YouTube panel: the star toggle in the browse header keeps its state
 * when switching between the A / B / YouTube sub-tabs, and the YouTube panel
 * reads it to show its favorites instead of search results.
 */
export const musicFavorites = $state({
	shown: false,
});
