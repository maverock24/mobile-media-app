/** Shared types for the lyrics system. */

export interface LrcLine {
	/** Timestamp in seconds. */
	time: number;
	/** The lyric text for this timestamp. */
	text: string;
}

export type LyricsResult =
	| { source: 'lrc'; lines: LrcLine[] }
	| { source: 'text'; text: string }
	| { source: 'none' };
