/**
 * Cross-component request to show the music player view.
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
