import { describe, it, expect } from 'vitest';
import { buildBrowseEntries, getRelativePath } from '$lib/models/browse';
import type { StoredAudioFile } from '$lib/stores/library.svelte';
import type { BrowseEntry } from '$lib/stores/library.svelte';

// ── helpers ──────────────────────────────────────────────────

const web = (name: string, relPath?: string): StoredAudioFile => ({
	source: 'web',
	name,
	relativePath: relPath ?? name,
	file: new File([], name),
});

const native = (name: string, relPath?: string): StoredAudioFile => ({
	source: 'native',
	name,
	relativePath: relPath ?? name,
	path: `/sdcard/${relPath ?? name}`,
	mimeType: 'audio/mpeg',
});

const drive = (name: string, relPath?: string): StoredAudioFile => ({
	source: 'drive',
	name,
	relativePath: relPath ?? name,
	fileId: `d-${name}`,
});

function fileNames(entries: BrowseEntry[]): string[] {
	return entries.map((e) => e.name);
}

// ─────────────────────────────────────────────────────────────
// getRelativePath
// ─────────────────────────────────────────────────────────────

describe('getRelativePath', () => {
	it('returns relativePath when present', () => {
		const file = web('song.mp3', 'folder/song.mp3');
		expect(getRelativePath(file)).toBe('folder/song.mp3');
	});

	it('falls back to name when relativePath is empty string', () => {
		const file = { ...web('song.mp3'), relativePath: '' };
		expect(getRelativePath(file)).toBe('song.mp3');
	});

	it('falls back to name when relativePath is missing', () => {
		const file = { ...web('song.mp3'), relativePath: undefined as unknown as string };
		expect(getRelativePath(file)).toBe('song.mp3');
	});

	it('handles native files', () => {
		const file = native('track.mp3', 'Music/track.mp3');
		expect(getRelativePath(file)).toBe('Music/track.mp3');
	});

	it('handles drive files', () => {
		const file = drive('drive.mp3', 'top/drive.mp3');
		expect(getRelativePath(file)).toBe('top/drive.mp3');
	});
});

// ─────────────────────────────────────────────────────────────
// buildBrowseEntries
// ─────────────────────────────────────────────────────────────

describe('buildBrowseEntries', () => {
	it('returns empty for empty file list', () => {
		expect(buildBrowseEntries([], [])).toEqual([]);
	});

	it('returns empty for empty file list at sub path', () => {
		expect(buildBrowseEntries([], ['sub'])).toEqual([]);
	});

	// ── flat (no subfolders) ──

	it('lists files at root in sorted order', () => {
		const files = [web('C.mp3'), web('A.mp3'), web('B.mp3')];
		const entries = buildBrowseEntries(files, []);
		expect(fileNames(entries)).toEqual(['A.mp3', 'B.mp3', 'C.mp3']);
	});

	it('all entries are files (no folders for flat list)', () => {
		const files = [web('a.mp3'), web('b.mp3')];
		const entries = buildBrowseEntries(files, []);
		expect(entries.every((e) => e.kind === 'file')).toBe(true);
	});

	// ── nested folders ──

	it('shows folders with counts at root', () => {
		const files = [
			web('f1/a.mp3', 'f1/a.mp3'),
			web('f1/b.mp3', 'f1/b.mp3'),
			web('f2/c.mp3', 'f2/c.mp3'),
		];
		const entries = buildBrowseEntries(files, []);
		const folders = entries.filter((e) => e.kind === 'folder');
		expect(folders).toHaveLength(2);
		expect(folders[0].name).toBe('f1');
		expect((folders[0] as { count: number }).count).toBe(2);
		expect(folders[1].name).toBe('f2');
		expect((folders[1] as { count: number }).count).toBe(1);
	});

	it('navigating into a folder shows its direct children', () => {
		const files = [
			web('f1/a.mp3', 'f1/a.mp3'),
			web('f1/b.mp3', 'f1/b.mp3'),
			web('f1/sub/x.mp3', 'f1/sub/x.mp3'),
		];
		const entries = buildBrowseEntries(files, ['f1']);
		// Folders first (sorted), then files (sorted)
		expect(fileNames(entries)).toEqual(['sub', 'a.mp3', 'b.mp3']);
		expect(entries).toHaveLength(3); // 1 subfolder + 2 files
	});

	it('navigating into a subfolder shows its files', () => {
		const files = [
			web('f1/sub/x.mp3', 'f1/sub/x.mp3'),
			web('f1/sub/y.mp3', 'f1/sub/y.mp3'),
		];
		const entries = buildBrowseEntries(files, ['f1', 'sub']);
		expect(fileNames(entries)).toEqual(['x.mp3', 'y.mp3']);
		expect(entries.every((e) => e.kind === 'file')).toBe(true);
	});

	it('deeply nested path shows correct children', () => {
		const files = [
			web('a/b/c/d.mp3', 'a/b/c/d.mp3'),
			web('a/b/c/e.mp3', 'a/b/c/e.mp3'),
			web('a/b/c/f/g.mp3', 'a/b/c/f/g.mp3'),
		];
		const entries = buildBrowseEntries(files, ['a', 'b', 'c']);
		const fileEntries = entries.filter((e) => e.kind === 'file');
		const folderEntries = entries.filter((e) => e.kind === 'folder');
		expect(fileNames(fileEntries)).toEqual(['d.mp3', 'e.mp3']);
		expect(folderEntries).toHaveLength(1);
		expect(folderEntries[0].name).toBe('f');
	});

	// ── sorting ──

	it('folders are sorted before files (numeric sort)', () => {
		const files = [
			web('10-file.mp3', '10-file.mp3'),
			web('1-file.mp3', '1-file.mp3'),
			web('2-folder/x.mp3', '2-folder/x.mp3'),
			web('a-folder/x.mp3', 'a-folder/x.mp3'),
		];
		const entries = buildBrowseEntries(files, []);
		const names = entries.map((e) => e.name);
		// Folders first, then files, each sorted numerically
		expect(names).toEqual(['2-folder', 'a-folder', '1-file.mp3', '10-file.mp3']);
	});

	it('numeric sort for file names', () => {
		const files = [web('10.mp3'), web('2.mp3'), web('1.mp3')];
		// localeCompare with { numeric: true } gives natural numeric order: 1, 2, 10
		expect(fileNames(buildBrowseEntries(files, []))).toEqual(['1.mp3', '2.mp3', '10.mp3']);
	});

	// ── edge cases ──

	it('files outside the path prefix are excluded', () => {
		const files = [
			web('a/x.mp3', 'a/x.mp3'),
			web('b/y.mp3', 'b/y.mp3'),
		];
		const entries = buildBrowseEntries(files, ['a']);
		expect(fileNames(entries)).toEqual(['x.mp3']);
	});

	it('file at exact path prefix match (no remaining) is excluded', () => {
		// A file named exactly as the folder: f1.mp3 in root, browsing f1/
		const files = [
			web('f1.mp3', 'f1.mp3'),  // This is a file AT root, not inside f1/
			web('f1/x.mp3', 'f1/x.mp3'),
		];
		const entries = buildBrowseEntries(files, ['f1']);
		expect(fileNames(entries)).toEqual(['x.mp3']);
		expect(entries).toHaveLength(1);
	});

	it('file with no remaining path is excluded', () => {
		const files = [web('exact.mp3', 'exact.mp3')];
		const entries = buildBrowseEntries(files, ['exact']);
		expect(entries).toEqual([]);
	});

	it('handles files with no relativePath gracefully', () => {
		const file: StoredAudioFile = {
			source: 'web',
			name: 'song.mp3',
			relativePath: '',
			file: new File([], 'song.mp3'),
		};
		const entries = buildBrowseEntries([file], []);
		expect(entries).toHaveLength(1);
		expect(entries[0].name).toBe('song.mp3');
	});

	it('handles mixed source types', () => {
		const files = [
			web('w.mp3', 'sub/w.mp3'),
			native('n.mp3', 'sub/n.mp3'),
			drive('d.mp3', 'sub/d.mp3'),
		];
		const entries = buildBrowseEntries(files, ['sub']);
		expect(fileNames(entries)).toEqual(['d.mp3', 'n.mp3', 'w.mp3']);
		expect(entries.every((e) => e.kind === 'file')).toBe(true);
	});

	// ── potential crash scenarios ──

	it('does not throw on empty relativePath with prefix', () => {
		const file: StoredAudioFile = {
			source: 'web',
			name: '',
			relativePath: '',
			file: new File([], ''),
		};
		// Empty name, empty relativePath — should not throw
		const entries = buildBrowseEntries([file], []);
		expect(entries).toEqual([]);
	});

	it('does not throw on very deep paths', () => {
		const deep = 'a/b/c/d/e/f/g/h/i/j/k.mp3';
		const files = [web(deep, deep)];
		const entries = buildBrowseEntries(files, ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j']);
		expect(entries).toHaveLength(1);
		expect(entries[0].name).toBe('k.mp3');
	});

	it('handles duplicate file names in different folders', () => {
		const files = [
			web('f1/song.mp3', 'f1/song.mp3'),
			web('f2/song.mp3', 'f2/song.mp3'),
		];
		const entries = buildBrowseEntries(files, []);
		expect(entries).toHaveLength(2); // Two folders
	});
});
