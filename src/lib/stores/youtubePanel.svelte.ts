/**
 * Cross-component control for the YouTube panel.
 *
 * The panel is rendered once in `+page.svelte` (not inside Mp3PlayerView, which
 * exists twice — one instance per music deck). Keeping it at the shell level
 * means there is a single `<audio>` element, and playback survives both closing
 * the panel and switching tabs.
 */

export const youtubePanel = $state({
	open: false,
	/** Video the panel should start playing as soon as it is next opened.
	 *  Set when playback is requested from outside the panel (a favorite in the
	 *  browse list, or the MiniPlayer). */
	requestedVideoId: null as string | null,
});

export function openYoutubePanel(videoId?: string): void {
	youtubePanel.open = true;
	if (videoId) youtubePanel.requestedVideoId = videoId;
}

export function closeYoutubePanel(): void {
	youtubePanel.open = false;
	youtubePanel.requestedVideoId = null;
}
