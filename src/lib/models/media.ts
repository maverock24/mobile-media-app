// Shared normalized media item — used by the media engine to represent a
// playable track from any source (music or podcast episode).

export type MediaSource = 'music' | 'podcast';

export interface MediaItem {
	/** Globally unique identifier across all sources. */
	id: string;
	/** Which domain this track belongs to. */
	source: MediaSource;
	title: string;
	subtitle: string;           // artist / podcast name
	audioUrl: string;
	artworkUrl?: string;
	duration?: number;          // seconds, if known ahead of time
}
