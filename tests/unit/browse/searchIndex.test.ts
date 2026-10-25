import { describe, it, expect } from 'vitest';
import type { StoredAudioFile } from '$lib/models/music';
import {
	buildSearchIndex,
	createSearchIndex,
	updateSearchIndex,
	type SearchIndex,
} from '$lib/browse/searchIndex';

// These tests pin the incremental search index as it behaved inside
// Mp3PlayerView.svelte, including its known length-keyed staleness. That bug is
// deliberate here: the revision-keyed follow-up rewrites the test named
// `an equal-length replacement leaves the old index in place`.

const native = (name: string): StoredAudioFile => ({
	source: 'native',
	name,
	relativePath: name,
	path: `/sdcard/${name}`,
	mimeType: 'audio/mpeg',
});

const names = (index: SearchIndex) => index.entries.map((e) => e.file.name);

const build = (files: StoredAudioFile[]): SearchIndex =>
	updateSearchIndex(createSearchIndex(), files, 'filename');

describe('search index', () => {
	it('an equal-length replacement leaves the old index in place', () => {
		// The update key is allFiles.length, so swapping b.mp3 for c.mp3 keeps the
		// length at 2 and the fast path returns without touching the entries.
		const first = build([native('a.mp3'), native('b.mp3')]);
		const replaced = updateSearchIndex(first, [native('a.mp3'), native('c.mp3')], 'filename');

		expect(names(replaced)).toEqual(['a.mp3', 'b.mp3']);
		expect(names(replaced)).not.toContain('c.mp3');
		expect(replaced.length).toBe(2);
	});

	it('an append merges instead of rebuilding', () => {
		// A rebuild would sort the whole array again and hand back fresh entry
		// objects. A merge keeps the existing entries by identity.
		const first = build([native('a.mp3'), native('c.mp3')]);
		const appended = updateSearchIndex(first, [native('a.mp3'), native('c.mp3'), native('d.mp3')], 'filename');

		expect(names(appended)).toEqual(['a.mp3', 'c.mp3', 'd.mp3']);
		expect(appended.entries[0]).toBe(first.entries[0]);
		expect(appended.entries[1]).toBe(first.entries[1]);
		expect(appended.entries[2]).not.toBe(first.entries[0]);
		expect(appended.length).toBe(3);
	});

	it('a merge keeps the index ordered, not just appended', () => {
		// The merged comparator uses `{ numeric: true }`, so the new batch lands in
		// its sorted position instead of after the existing entries.
		const first = build([native('a.mp3'), native('c.mp3')]);
		const merged = updateSearchIndex(first, [native('a.mp3'), native('c.mp3'), native('b.mp3')], 'filename');

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
		const first = build([native('a.mp3'), native('b.mp3'), native('c.mp3')]);
		const shrunk = updateSearchIndex(first, [native('a.mp3')], 'filename');

		expect(names(shrunk)).toEqual(['a.mp3']);
		expect(shrunk.length).toBe(1);
	});

	it('buildSearchIndex sorts a single batch on its own', () => {
		const entries = buildSearchIndex([native('b.mp3'), native('a.mp3')], 'filename');

		expect(entries.map((e) => e.file.name)).toEqual(['a.mp3', 'b.mp3']);
	});
});
