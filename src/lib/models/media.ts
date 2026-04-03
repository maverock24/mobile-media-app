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
	album?: string;
	audioUrl: string;
	artworkUrl?: string;
	duration?: number;          // seconds, if known ahead of time
	/** Optional callback to resolve a dynamic URL (e.g. temporary Blob or Drive URL) */
	resolveUrl?: () => Promise<string | null>;
}
