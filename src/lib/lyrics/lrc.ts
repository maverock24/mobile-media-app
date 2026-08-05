/**
 * LRC (Lyrics) file parser.
 *
 * Format: [mm:ss.xx]Lyric text
 * Supports optional ID tags at the top ([ti:...], [ar:...], etc.)
 */

import type { LrcLine } from './types';

const LINE_RE = /^\[(\d{1,3}):(\d{2})(?:\.(\d{1,3}))?\](.*)/;

/** Parse an LRC string into timestamped lines, sorted by time. */
export function parseLrc(raw: string): LrcLine[] {
	const lines: LrcLine[] = [];

	for (const line of raw.split('\n')) {
		const trimmed = line.trim();
		if (!trimmed) continue;

		const match = trimmed.match(LINE_RE);
		if (!match) continue;

		const minutes = parseInt(match[1], 10);
		const seconds = parseInt(match[2], 10);
		const millis = match[3] ? parseInt(match[3].padEnd(3, '0'), 10) : 0;
		const text = match[4].trim();

		if (!text) continue;

		lines.push({
			time: minutes * 60 + seconds + millis / 1000,
			text,
		});
	}

	lines.sort((a, b) => a.time - b.time);
	return lines;
}

/** Find the index of the line that should be active at the given time (seconds).
 *  Returns -1 if no line has been reached yet. */
export function findActiveLineIndex(lines: LrcLine[], currentTimeSec: number): number {
	if (lines.length === 0) return -1;
	let active = -1;
	for (let i = 0; i < lines.length; i++) {
		if (lines[i].time <= currentTimeSec) {
			active = i;
		} else {
			break;
		}
	}
	return active;
}
