/**
 * Incremental search index for the music browse view.
 *
 * This logic used to live inline in a `$effect` in `Mp3PlayerView.svelte`. It
 * moved here verbatim so the incremental update rule can be unit-tested; the
 * view now only supplies the reactive reads.
 *
 * The index is rebuilt when it is empty, merged when the file list only grew,
 * and reset when the list shrank. The rebuild/merge decision is keyed on
 * `allFiles.length`. That length key is a known bug — a replacement that keeps
 * the length (one file added plus one removed between two publishes) leaves the
 * old index in place. `tests/unit/browse/searchIndex.test.ts` pins the current
 * behaviour on purpose; the revision-keyed follow-up rewrites it.
 */
import { parseFilename, sortFiles, type StoredAudioFile } from '$lib/models/music';

export type SearchIndexSortOrder = 'filename' | 'title' | 'artist';

/** A file paired with its lowercase `name title artist` haystack. */
export type SearchIndexEntry = { file: StoredAudioFile; haystack: string };

/** The index plus the file count it was built from (`allFiles.length`). */
export type SearchIndex = { entries: SearchIndexEntry[]; length: number };

export function createSearchIndex(): SearchIndex {
	return { entries: [], length: 0 };
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
 * Advance the index for a new `allFiles` array.
 *
 * Same rules as the effect this was lifted from:
 *  - a shorter list resets the recorded length, so the index is rebuilt,
 *  - an unchanged length is a no-op (this is the staleness bug, see above),
 *  - a longer list sorts and merges only the tail past the previous length.
 *
 * The branch order is kept exactly as the effect had it, including the
 * unreachable zero-length branch noted inline.
 */
export function updateSearchIndex(
	index: SearchIndex,
	allFiles: StoredAudioFile[],
	sortOrder: SearchIndexSortOrder,
): SearchIndex {
	const total = allFiles.length;
	let length = index.length;
	// A delete shrinks the index. Without this reset the merge branch below
	// slices past the new end, finds nothing "new", and keeps the deleted
	// file in the search index forever.
	if (total < length) length = 0;
	if (total === length) return index;
	// Unreachable as the code stands: a zero-length list either matched the
	// length above or was just reset to 0, so it returns on the line before.
	// Kept verbatim from the effect so the follow-up diff is only the key.
	if (total === 0) return createSearchIndex();
	// On first build or reset, sort the full array; on incremental batches,
	// sort only the new slice and merge (the incoming slice is already sorted
	// within itself from the source, so we benchmark vs full re-sort).
	if (length === 0) {
		return { entries: buildSearchIndex(allFiles, sortOrder), length: total };
	}
	const newSlice = allFiles.slice(length);
	return { entries: mergeSearchIndex(index.entries, newSlice, sortOrder), length: total };
}
