// mergeLibraryDelta — the prune policy of the delta walk.
//
// One test per rule in `.scratch/library-delta/outline.md` S4, plus the two extra
// cases the slice names: an equal-length add-plus-remove (the D9 trap, seen from the
// data side) and an incomplete walk that keeps the previous files.
// ─────────────────────────────────────────────────────────────

import { describe, it, expect } from 'vitest';
import { getStoredFileKey, type CachedLibrary, type StoredAudioFile } from '$lib/models/music';
import {
	decideScanMode,
	mergeLibraryDelta,
	DELTA_TREE_MAX_BYTES,
	FULL_WALK_MAX_AGE_MS,
	type LibraryDeltaDirRow,
} from '$lib/browse/libraryDelta';

// ── helpers ──────────────────────────────────────────────────

const nativeFile = (
	relativePath: string,
	modifiedAt: number | undefined,
	sizeBytes: number | undefined
): StoredAudioFile => ({
	source: 'native',
	name: relativePath.split('/').pop() ?? relativePath,
	relativePath,
	path: `/sdcard/${relativePath}`,
	mimeType: 'audio/mpeg',
	modifiedAt,
	sizeBytes,
});

const keys = (files: readonly StoredAudioFile[]): string[] => files.map((file) => getStoredFileKey(file));

const paths = (rows: readonly LibraryDeltaDirRow[]): string[] => rows.map((row) => row.path);

describe('mergeLibraryDelta', () => {
	// Rule 1 — fingerprint
	it('keeps the previous object when modifiedAt and sizeBytes both match, and takes the new one otherwise', () => {
		const prevSame = nativeFile('Alpha/same.mp3', 100, 1000);
		const prevNewMtime = nativeFile('Alpha/new-mtime.mp3', 200, 2000);
		const prevNewSize = nativeFile('Alpha/new-size.mp3', 300, 3000);
		const walkedSame = nativeFile('Alpha/same.mp3', 100, 1000);
		const walkedNewMtime = nativeFile('Alpha/new-mtime.mp3', 201, 2000);
		const walkedNewSize = nativeFile('Alpha/new-size.mp3', 300, 3001);

		const result = mergeLibraryDelta({
			previous: [prevSame, prevNewMtime, prevNewSize],
			walked: [walkedSame, walkedNewMtime, walkedNewSize],
			dirs: [],
			skippedDirs: [],
			unreadableDirs: 0,
			completed: true,
		});

		expect(result.files).toHaveLength(3);
		expect(result.files[0]).toBe(prevSame);
		expect(result.files[1]).toBe(walkedNewMtime);
		expect(result.files[2]).toBe(walkedNewSize);
	});

	// Rule 2 — identity is relativePath
	it('treats a rename as one removal plus one addition', () => {
		// Same filename, same fingerprint, different directory: identity is the path,
		// so the old entry goes and a new one arrives.
		const before = nativeFile('Alpha/x.mp3', 100, 1000);
		const after = nativeFile('Beta/x.mp3', 100, 1000);

		const result = mergeLibraryDelta({
			previous: [before],
			walked: [after],
			dirs: [],
			skippedDirs: [],
			unreadableDirs: 0,
			completed: true,
		});

		expect(keys(result.files)).toEqual(['n:Beta/x.mp3']);
		expect(result.files[0]).toBe(after);
	});

	// Rule 3 — incomplete walks prune nothing
	it('prunes nothing when completed is false, and prunes when it is true', () => {
		const prevUpdated = nativeFile('Alpha/a.mp3', 100, 1000);
		const prevUnseen = nativeFile('Beta/b.mp3', 200, 2000);
		const walkedUpdated = nativeFile('Alpha/a.mp3', 101, 1000);
		const walkedNew = nativeFile('Gamma/c.mp3', 300, 3000);

		const shared = {
			previous: [prevUpdated, prevUnseen],
			walked: [walkedUpdated, walkedNew],
			dirs: [],
			skippedDirs: [],
			unreadableDirs: 0,
		};

		const incomplete = mergeLibraryDelta({ ...shared, completed: false });
		expect(keys(incomplete.files)).toEqual(['n:Alpha/a.mp3', 'n:Gamma/c.mp3', 'n:Beta/b.mp3']);
		expect(incomplete.files[0]).toBe(walkedUpdated);
		expect(incomplete.files[1]).toBe(walkedNew);
		expect(incomplete.files[2]).toBe(prevUnseen);

		const completed = mergeLibraryDelta({ ...shared, completed: true });
		expect(keys(completed.files)).toEqual(['n:Alpha/a.mp3', 'n:Gamma/c.mp3']);
	});

	// Rule 4 — an unreadable directory disables pruning for the whole walk (D2)
	it('prunes nothing when a directory was unreadable, while keeping the additions and updates', () => {
		const prevUpdated = nativeFile('Alpha/a.mp3', 100, 1000);
		const prevInsideUnreadable = nativeFile('Beta/b.mp3', 200, 2000);
		const prevElsewhere = nativeFile('Zeta/z.mp3', 400, 4000);
		const walkedUpdated = nativeFile('Alpha/a.mp3', 101, 1000);
		const walkedNew = nativeFile('Gamma/c.mp3', 300, 3000);

		const result = mergeLibraryDelta({
			previous: [prevUpdated, prevInsideUnreadable, prevElsewhere],
			walked: [walkedUpdated, walkedNew],
			dirs: [{ path: 'Alpha', mtime: 10 }],
			skippedDirs: [],
			unreadableDirs: 1,
			completed: true,
		});

		// The walk saw Alpha and Gamma; Beta was unreadable and Zeta was never reached.
		expect(keys(result.files)).toEqual([
			'n:Alpha/a.mp3',
			'n:Gamma/c.mp3',
			'n:Beta/b.mp3',
			'n:Zeta/z.mp3',
		]);
		expect(result.files[0]).toBe(walkedUpdated);
		expect(result.files[1]).toBe(walkedNew);
		expect(result.files[2]).toBe(prevInsideUnreadable);
		expect(result.files[3]).toBe(prevElsewhere);
	});

	// Rule 5 — a skipped directory protects its own subtree, and only that subtree
	it('never prunes a file under a skipped directory, even on a completed walk', () => {
		const prevSkippedFile = nativeFile('Alpha/a.mp3', 100, 1000);
		const prevSkippedNested = nativeFile('Alpha/Sub/b.mp3', 150, 1500);
		const prevVisited = nativeFile('Beta/c.mp3', 200, 2000);
		const prevVisitedGone = nativeFile('Zeta/z.mp3', 400, 4000);
		const walkedVisited = nativeFile('Beta/c.mp3', 200, 2000);
		const walkedNew = nativeFile('Gamma/d.mp3', 300, 3000);

		const result = mergeLibraryDelta({
			previous: [prevSkippedFile, prevSkippedNested, prevVisited, prevVisitedGone],
			walked: [walkedVisited, walkedNew],
			dirs: [
				{ path: 'Beta', mtime: 20 },
				{ path: 'Gamma', mtime: 30 },
			],
			previousDirs: [
				{ path: 'Alpha', mtime: 10 },
				{ path: 'Alpha/Sub', mtime: 15 },
				{ path: 'Beta', mtime: 20 },
			],
			skippedDirs: ['Alpha'],
			unreadableDirs: 0,
			completed: true,
		});

		// Zeta was not skipped and was reached by the walk, so it is pruned. The
		// skipped subtree survives untouched, its own file objects included.
		expect(keys(result.files)).toEqual([
			'n:Beta/c.mp3',
			'n:Gamma/d.mp3',
			'n:Alpha/a.mp3',
			'n:Alpha/Sub/b.mp3',
		]);
		expect(result.files[0]).toBe(prevVisited);
		expect(result.files[2]).toBe(prevSkippedFile);
		expect(result.files[3]).toBe(prevSkippedNested);

		// The persisted tree is the observed rows plus the skipped rows (D4 amendment),
		// with no duplicate for the row the walk re-observed.
		expect(paths(result.dirs)).toEqual(['Beta', 'Gamma', 'Alpha', 'Alpha/Sub']);
	});

	// Rule 6 — prefixes are /-delimited
	it('matches prefixes on / boundaries, so Alpha2 is not under Alpha', () => {
		const prevVisited = nativeFile('Alpha/keep.mp3', 100, 1000);
		const prevLookalike = nativeFile('Alpha2/x.mp3', 200, 2000);
		const prevOther = nativeFile('Other/o.mp3', 300, 3000);

		const result = mergeLibraryDelta({
			previous: [prevVisited, prevLookalike, prevOther],
			walked: [],
			dirs: [],
			skippedDirs: ['Alpha'],
			unreadableDirs: 0,
			completed: true,
		});

		expect(keys(result.files)).toEqual(['n:Alpha/keep.mp3']);
	});

	// Extra — the D9 trap seen from the data side
	it('changes the result for an equal-length add plus remove', () => {
		const prevKept = nativeFile('Alpha/keep.mp3', 100, 1000);
		const prevGone = nativeFile('Alpha/gone.mp3', 200, 2000);
		const walkedKept = nativeFile('Alpha/keep.mp3', 100, 1000);
		const walkedAdded = nativeFile('Alpha/added.mp3', 300, 3000);

		const result = mergeLibraryDelta({
			previous: [prevKept, prevGone],
			walked: [walkedKept, walkedAdded],
			dirs: [],
			skippedDirs: [],
			unreadableDirs: 0,
			completed: true,
		});

		// Same length as `previous`, so a length-keyed index would miss the change.
		expect(result.files).toHaveLength(2);
		expect(keys(result.files)).toEqual(['n:Alpha/keep.mp3', 'n:Alpha/added.mp3']);
		expect(result.files[0]).toBe(prevKept);
		expect(result.files[1]).toBe(walkedAdded);
	});

	// Extra — an interrupted walk
	it('keeps the previous files when the walk did not complete', () => {
		const prevA = nativeFile('Alpha/a.mp3', 100, 1000);
		const prevB = nativeFile('Alpha/b.mp3', 200, 2000);
		const prevC = nativeFile('Beta/c.mp3', 300, 3000);
		const walkedA = nativeFile('Alpha/a.mp3', 100, 1000);

		// The walk stopped after the first directory: everything else unseen.
		const result = mergeLibraryDelta({
			previous: [prevA, prevB, prevC],
			walked: [walkedA],
			dirs: [{ path: 'Alpha', mtime: 10 }],
			skippedDirs: [],
			unreadableDirs: 0,
			completed: false,
		});

		expect(keys(result.files)).toEqual(['n:Alpha/a.mp3', 'n:Alpha/b.mp3', 'n:Beta/c.mp3']);
		expect(result.files[0]).toBe(prevA);
		expect(result.files[1]).toBe(prevB);
		expect(result.files[2]).toBe(prevC);
	});
});

// ─────────────────────────────────────────────────────────────
// decideScanMode — which walk the index asks for (D1, D3)
// The four fallbacks the slice names, plus the one delta case.
// ─────────────────────────────────────────────────────────────

const DAY = 24 * 60 * 60 * 1000;

/** A payload that would earn a delta on every count, overridable per test. */
const usableCache = (overrides: Partial<CachedLibrary> = {}): CachedLibrary => ({
	folderName: 'Music',
	files: [],
	savedAt: 1,
	schemaVersion: 1,
	completedAt: 1_000_000,
	dirs: [{ path: '', mtime: 5 }],
	...overrides,
});

describe('decideScanMode', () => {
	it('runs a delta when the tree is usable, inside the cap and inside the window', () => {
		const cached = usableCache();

		expect(decideScanMode({
			cached,
			now: 1_000_000 + DAY,
			encodedTreeBytes: JSON.stringify(cached.dirs).length,
		})).toBe('delta');
	});

	it('a cold cache walks in full', () => {
		expect(decideScanMode({ cached: null, now: 1_000_000, encodedTreeBytes: 0 })).toBe('full');
	});

	it('a payload without schemaVersion walks in full', () => {
		// Every device's payload before the tree existed: files, no version, no rows.
		const legacy: CachedLibrary = { folderName: 'Music', files: [], savedAt: 1, completedAt: 1_000_000 };

		expect(decideScanMode({ cached: legacy, now: 1_000_000, encodedTreeBytes: 0 })).toBe('full');
	});

	it('a tree over the size cap walks in full', () => {
		const cached = usableCache();

		expect(decideScanMode({
			cached,
			now: 1_000_000,
			encodedTreeBytes: DELTA_TREE_MAX_BYTES + 1,
		})).toBe('full');
	});

	it('a cached walk older than the window walks in full', () => {
		const cached = usableCache();

		// Exactly at the window is still inside it; one millisecond past is not.
		expect(decideScanMode({
			cached,
			now: 1_000_000 + FULL_WALK_MAX_AGE_MS,
			encodedTreeBytes: 10,
		})).toBe('delta');
		expect(decideScanMode({
			cached,
			now: 1_000_000 + FULL_WALK_MAX_AGE_MS + 1,
			encodedTreeBytes: 10,
		})).toBe('full');
	});

	it('a payload with no completedAt walks in full', () => {
		// The stamp is the only thing the window can read, so without it the walk
		// cannot be verified as recent.
		const cached = usableCache({ completedAt: undefined });

		expect(decideScanMode({ cached, now: 1_000_000, encodedTreeBytes: 10 })).toBe('full');
	});
});
