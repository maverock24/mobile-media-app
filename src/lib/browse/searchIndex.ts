/**
 * Incremental search index for the music browse view.
 *
 * This logic used to live inline in a `$effect` in `Mp3PlayerView.svelte`, keyed
 * on `allFiles.length`. A length key cannot see two things: a replacement that
 * keeps the length (one file added plus one removed between two publishes) and
 * an in-place replacement of a row. The key is now the publish revision D9
 * settled on, which every publish of `allFiles` bumps:
 *
 *  - the revision moved and the new list is a strict append of the old one:
 *    sort the tail and merge it in;
 *  - the revision moved and the list is anything else (a shrink, an equal-length
 *    replacement, an in-place replacement): rebuild;
 *  - the revision did not move: the entries are already current.
 *
 * The append check compares against `files`, the list the entries were built
 * from, so it sees the published rows rather than the sorted entries.
 */
import { parseFilename, sortFiles, type StoredAudioFile } from '$lib/models/music';

export type SearchIndexSortOrder = 'filename' | 'title' | 'artist';

/** A file paired with its lowercase `name title artist` haystack. */
export type SearchIndexEntry = { file: StoredAudioFile; haystack: string };

/** The index, the publish revision it is current for, and the list behind it. */
export type SearchIndex = {
	entries: SearchIndexEntry[];
	revision: number;
	files: StoredAudioFile[];
};

export function createSearchIndex(): SearchIndex {
	return { entries: [], revision: -1, files: [] };
}

/** Sort the whole array and build a haystack per file. */
export function buildSearchIndex(
	allFiles: StoredAudioFile[],
	sortOrder: SearchIndexSortOrder,
): SearchIndexEntry[] {
	return sortFiles(allFiles, sortOrder).map((f) => {
		const { title, artist } = parseFilename(f.name);
		return { file: f, haystack: `${f.name} ${title} ${artist}`.toLowerCase() };
	});
}

/** Sort an incoming batch and merge it into the pre-sorted index. */
export function mergeSearchIndex(
	existing: SearchIndexEntry[],
	incoming: StoredAudioFile[],
	sortOrder: SearchIndexSortOrder,
): SearchIndexEntry[] {
	const newEntries = sortFiles(incoming, sortOrder).map((f) => {
		const { title, artist } = parseFilename(f.name);
		return { file: f, haystack: `${f.name} ${title} ${artist}`.toLowerCase() };
	});
	// Merge the pre-sorted index with the new sorted batch
	const merged = new Array(existing.length + newEntries.length);
	let ei = 0, ii = 0, mi = 0;
	const getKey = (entry: { file: StoredAudioFile }) => {
		if (sortOrder === 'title') return parseFilename(entry.file.name).title;
		if (sortOrder === 'artist') return parseFilename(entry.file.name).artist;
		return entry.file.name;
	};
	while (ei < existing.length && ii < newEntries.length) {
		const aKey = getKey(existing[ei]);
		const bKey = getKey(newEntries[ii]);
		if (aKey.localeCompare(bKey, undefined, { numeric: true }) <= 0) {
			merged[mi++] = existing[ei++];
		} else {
			merged[mi++] = newEntries[ii++];
		}
	}
	while (ei < existing.length) merged[mi++] = existing[ei++];
	while (ii < newEntries.length) merged[mi++] = newEntries[ii++];
	return merged;
}

/**
 * True when `next` is `prev` with rows appended and every previous row still the
 * same object at the same index — the one shape a merge is safe on.
 */
function isStrictAppend(next: StoredAudioFile[], prev: StoredAudioFile[]): boolean {
	if (next.length <= prev.length) return false;
	for (let i = 0; i < prev.length; i += 1) {
		if (next[i] !== prev[i]) return false;
	}
	return true;
}

/**
 * Advance the index to `allFiles` as published under `revision`.
 *
 *  - the revision did not move and the list is the same array: no-op;
 *  - a strict append: sort only the tail past the previous list and merge it;
 *  - anything else (a shrink, an equal-length replacement, an in-place
 *    replacement): sort the whole list again.
 *
 * The `allFiles === index.files` half of the no-op check covers the sources that
 * publish the list without a revision sink (the Drive library and the file ops),
 * so a missed bump falls through to the append/rebuild decision instead of
 * leaving stale entries behind.
 */
export function updateSearchIndex(
	index: SearchIndex,
	allFiles: StoredAudioFile[],
	revision: number,
	sortOrder: SearchIndexSortOrder,
): SearchIndex {
	if (revision === index.revision && allFiles === index.files) return index;
	const previous = index.files;
	if (isStrictAppend(allFiles, previous)) {
		const newSlice = allFiles.slice(previous.length);
		return { entries: mergeSearchIndex(index.entries, newSlice, sortOrder), revision, files: allFiles };
	}
	// A shrink (a delete) lands here too: the previous rows are no longer the
	// prefix of the list, and slicing past the new end would keep the deleted
	// file forever.
	return { entries: buildSearchIndex(allFiles, sortOrder), revision, files: allFiles };
}
