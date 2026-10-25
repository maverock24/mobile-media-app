import { describe, it, expect } from 'vitest';
import type { StoredAudioFile } from '$lib/models/music';
import {
	buildSearchIndex,
	createSearchIndex,
	updateSearchIndex,
	type SearchIndex,
} from '$lib/browse/searchIndex';

// The incremental search index is keyed on the publish revision (D9), not on
// `allFiles.length`. A revision that did not move is a no-op; a revision that
// moved is a merge only when the new list is a strict append of the old one and
// a rebuild otherwise. Every publish in `deviceLibrary.svelte.ts` bumps it.

const native = (name: string): StoredAudioFile => ({
	source: 'native',
	name,
	relativePath: name,
	path: `/sdcard/${name}`,
	mimeType: 'audio/mpeg',
});

const names = (index: SearchIndex) => index.entries.map((e) => e.file.name);

/** The first build: no previous revision, so the whole list is indexed. */
const build = (files: StoredAudioFile[], revision = 1): SearchIndex =>
	updateSearchIndex(createSearchIndex(), files, revision, 'filename');

describe('search index', () => {
	it('replaces the index when one file is added and another removed', () => {
		// The length stays at 2, which is exactly what the old length key could not
		// see: the publish swapped b.mp3 for c.mp3 and the index kept b.mp3.
		const first = build([native('a.mp3'), native('b.mp3')], 1);
		const replaced = updateSearchIndex(first, [native('a.mp3'), native('c.mp3')], 2, 'filename');

		expect(names(replaced)).toEqual(['a.mp3', 'c.mp3']);
		expect(names(replaced)).not.toContain('b.mp3');
		expect(replaced.revision).toBe(2);
	});

	it('an in-place replacement is visible to the next search', () => {
		// The publish reuses the array and swaps one row for a renamed copy, so the
		// length, the array identity and every surviving row are unchanged. Only the
		// revision moves, and it has to be enough.
		const files = [native('a.mp3'), native('b.mp3')];
		const first = updateSearchIndex(createSearchIndex(), files, 1, 'filename');
		expect(names(first)).toEqual(['a.mp3', 'b.mp3']);

		files[1] = native('c.mp3');
		const replaced = updateSearchIndex(first, files, 2, 'filename');

		expect(names(replaced)).toEqual(['a.mp3', 'c.mp3']);
		expect(replaced.revision).toBe(2);
	});

	it('an append still merges instead of rebuilding', () => {
		// A rebuild sorts the whole array again and hands back fresh entry objects.
		// A merge keeps the entries that were already indexed, by identity.
		const files = [native('a.mp3'), native('c.mp3')];
		const first = build(files, 1);
		const appended = updateSearchIndex(first, [...files, native('d.mp3')], 2, 'filename');

		expect(names(appended)).toEqual(['a.mp3', 'c.mp3', 'd.mp3']);
		expect(appended.entries[0]).toBe(first.entries[0]);
		expect(appended.entries[1]).toBe(first.entries[1]);
		expect(appended.entries.length).toBe(3);
		expect(appended.revision).toBe(2);
	});

	it('a merge keeps the index ordered, not just appended', () => {
		// The merged comparator uses `{ numeric: true }`, so the new batch lands in
		// its sorted position instead of after the existing entries.
		const files = [native('a.mp3'), native('c.mp3')];
		const first = build(files, 1);
		const merged = updateSearchIndex(first, [...files, native('b.mp3')], 2, 'filename');

		expect(names(merged)).toEqual(['a.mp3', 'b.mp3', 'c.mp3']);
	});

	it('a rebuild produces a sorted index with name, title and artist in the haystack', () => {
		const index = build([
			native('Track 10.mp3'),
			native('Some Artist - Some Title.mp3'),
			native('Track 2.mp3'),
		]);

		// Filename order, numeric-aware (Track 2 before Track 10).
		expect(names(index)).toEqual([
			'Some Artist - Some Title.mp3',
			'Track 2.mp3',
			'Track 10.mp3',
		]);

		const entry = index.entries[0];
		expect(entry.haystack).toBe('some artist - some title.mp3 some title some artist');
		expect(entry.haystack).toContain('some artist');
		expect(entry.haystack).toContain('some title');
		expect(entry.haystack).toBe(entry.haystack.toLowerCase());
	});

	it('a shrink resets the index', () => {
		const first = build([native('a.mp3'), native('b.mp3'), native('c.mp3')], 1);
		const shrunk = updateSearchIndex(first, [native('a.mp3')], 2, 'filename');

		expect(names(shrunk)).toEqual(['a.mp3']);
		expect(shrunk.entries.length).toBe(1);
	});

	it('a sort order change rebuilds the index', () => {
		// The list, the array identity and the revision are all unchanged; only the
		// order moved, which is what a Settings change does. The entries are stored
		// pre-sorted, so an identity of (revision, allFiles) alone would call this a
		// no-op and search would keep the old order.
		const files = [native('aaa - zzz.mp3'), native('bbb - aaa.mp3')];
		const first = build(files, 1);
		expect(names(first)).toEqual(['aaa - zzz.mp3', 'bbb - aaa.mp3']);

		const byTitle = updateSearchIndex(first, files, 1, 'title');

		// Filename order is `aaa - zzz` first; title order is `aaa` before `zzz`, so
		// the same two files come back reversed.
		expect(names(byTitle)).toEqual(['bbb - aaa.mp3', 'aaa - zzz.mp3']);
		expect(byTitle.sortOrder).toBe('title');
		expect(byTitle.revision).toBe(1);
		// A rebuild, not a merge of the old entries: they are in the old order.
		expect(byTitle.entries[0]).not.toBe(first.entries[0]);
	});

	it('an unchanged sort order keeps the no-op fast path', () => {
		const files = [native('a.mp3'), native('b.mp3')];
		const first = build(files, 1);

		expect(updateSearchIndex(first, files, 1, 'filename')).toBe(first);
	});

	it('buildSearchIndex sorts a single batch on its own', () => {
		const entries = buildSearchIndex([native('b.mp3'), native('a.mp3')], 'filename');

		expect(entries.map((e) => e.file.name)).toEqual(['a.mp3', 'b.mp3']);
	});
});
