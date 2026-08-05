/**
 * Lyrics resolution — tries to find lyrics for a given StoredAudioFile.
 *
 * Strategy (in order):
 * 1. Look for a .lrc file alongside the audio file (same path, .lrc extension)
 * 2. Return 'none' if nothing found
 */

import { Capacitor } from '@capacitor/core';
import { Filesystem, Directory } from '@capacitor/filesystem';
import { parseLrc } from './lrc';
import type { LyricsResult, LrcLine } from './types';

/**
 * Given the absolute native path of an audio file (e.g.
 * /storage/emulated/0/Music/song.mp3), return the expected .lrc path.
 */
function lrcPathFromAudio(audioPath: string): string {
	return audioPath.replace(/\.[^.]+$/, '') + '.lrc';
}

/**
 * Try to read a .lrc file from the device filesystem.
 * Returns parsed lines or null if the file doesn't exist / can't be read.
 */
async function readLrcFromPath(path: string): Promise<LrcLine[] | null> {
	try {
		// Use Capacitor Filesystem to read the .lrc as text
		const result = await Filesystem.readFile({
			path,
			directory: Directory.External,
		});
		const text = result.data as string;
		if (!text || text.trim().length === 0) return null;
		const lines = parseLrc(text);
		return lines.length > 0 ? lines : null;
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
	const lines = await readLrcFromPath(lrcPath);
	if (lines) return { source: 'lrc', lines };

	return { source: 'none' };
}
