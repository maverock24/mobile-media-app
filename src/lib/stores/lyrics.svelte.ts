/**
 * Global lyrics store — resolves and exposes lyrics for the currently playing
 * track. Accessible from any component (Mp3PlayerView, MiniPlayer, etc.).
 */

import { resolveLyrics } from '$lib/lyrics/reader';
import { findActiveLineIndex } from '$lib/lyrics/lrc';
import type { LyricsResult } from '$lib/lyrics/types';
import { mediaEngine } from './mediaEngine.svelte';

export const lyricsStore = $state({
	data: { source: 'none' as const } as LyricsResult,
	loading: false,
	/** Track key last resolved for — prevents re-fetching the same track. */
	resolvedForKey: '' as string,
});

/** Get the text of the currently active LRC line, or empty string if none. */
export function getCurrentLyricLine(): string {
	const d = lyricsStore.data;
	if (d.source !== 'lrc' || d.lines.length === 0) return '';
	void mediaEngine.currentTime; // reactive dependency
	const idx = findActiveLineIndex(d.lines, mediaEngine.currentTime);
	if (idx < 0) return d.lines[0]?.text ?? '';
	return d.lines[idx].text;
}

/** Whether lyrics are currently available to display. */
export function hasLyrics(): boolean {
	return lyricsStore.data.source === 'lrc' && lyricsStore.data.lines.length > 0;
}

/**
 * Trigger lyrics resolution for a given track. Uses a stable key to avoid
 * re-fetching the same track multiple times. Safe to call on every track change.
 */
export async function resolveTrackLyrics(file: {
	source: string;
	path?: string;
	name: string;
}, trackKey: string): Promise<void> {
	if (lyricsStore.resolvedForKey === trackKey) return;
	lyricsStore.resolvedForKey = trackKey;
	lyricsStore.loading = true;
	lyricsStore.data = { source: 'none' };

	try {
		const result = await resolveLyrics(file);
		lyricsStore.data = result;
	} catch {
		lyricsStore.data = { source: 'none' };
	} finally {
		lyricsStore.loading = false;
	}
}

/** Clear lyrics state (called when playback stops). */
export function clearLyrics(): void {
	lyricsStore.data = { source: 'none' };
	lyricsStore.loading = false;
	lyricsStore.resolvedForKey = '';
}
