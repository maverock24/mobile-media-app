/**
 * Lyrics resolution — tries to find lyrics for a given StoredAudioFile.
 *
 * Strategy (in order):
 * 1. Look for a .lrc file alongside the audio file (same path, .lrc extension)
 *    using Capacitor's file bridge (works with SAF tree URIs on Android).
 * 2. Return 'none' if nothing found
 */

import { Capacitor } from '@capacitor/core';
import { parseLrc } from './lrc';
import type { LyricsResult } from './types';

/**
 * Given the absolute native path of an audio file (e.g.
 * /storage/emulated/0/Music/song.mp3), return the expected .lrc path.
 */
function lrcPathFromAudio(audioPath: string): string {
	return audioPath.replace(/\.[^.]+$/, '') + '.lrc';
}

/**
 * Try to read a .lrc file using Capacitor's file bridge (convertFileSrc).
 * This works with both direct file paths and SAF tree URI files because
 * Capacitor's localhost bridge server has access to all granted file URIs.
 * Returns parsed lines or null if the file doesn't exist / can't be read.
 */
async function readLrcViaBridge(path: string): Promise<string | null> {
	try {
		const bridgeUrl = Capacitor.convertFileSrc(path);
		if (bridgeUrl === path) return null; // Capacitor couldn't convert — not a valid file path
		const response = await fetch(bridgeUrl);
		if (!response.ok) return null;
		const text = await response.text();
		return text?.trim() || null;
	} catch {
		return null;
	}
}

/**
 * Try to resolve lyrics for a stored audio file.
 * Only works on native platforms (Android/iOS) where we have file access.
 */
export async function resolveLyrics(file: {
	source: string;
	path?: string;
	name: string;
}): Promise<LyricsResult> {
	if (!Capacitor.isNativePlatform()) return { source: 'none' };
	if (file.source !== 'native' || !file.path) return { source: 'none' };

	const lrcPath = lrcPathFromAudio(file.path);
	const text = await readLrcViaBridge(lrcPath);
	if (text) {
		const lines = parseLrc(text);
		if (lines.length > 0) return { source: 'lrc', lines };
	}

	return { source: 'none' };
}
