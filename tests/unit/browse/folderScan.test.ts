import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { StoredAudioFile } from '$lib/models/music';

// The module under test imports the native plugin and the FilePicker plugin.
// Both are replaced with vi.fn stand-ins so the batch loop, the cancellation
// path and the directory picker can be driven without a device.
const mocks = vi.hoisted(() => ({
	startAudioScan: vi.fn(),
	getAudioScanBatch: vi.fn(),
	cancelAudioScan: vi.fn(),
	listEntries: vi.fn(),
	listAudioFiles: vi.fn(),
	pickDirectory: vi.fn(),
}));

vi.mock('$lib/native/directory-reader', () => ({
	DirectoryReader: {
		startAudioScan: mocks.startAudioScan,
		getAudioScanBatch: mocks.getAudioScanBatch,
		cancelAudioScan: mocks.cancelAudioScan,
		listEntries: mocks.listEntries,
		listAudioFiles: mocks.listAudioFiles,
	},
}));

vi.mock('@capawesome/capacitor-file-picker', () => ({
	FilePicker: { pickDirectory: mocks.pickDirectory },
}));

import {
	yieldScanToUi,
	scanNativeAudioFiles,
	collectAllFromPath,
	pickNativeAudioDirectory,
	type CollectAllDeps,
} from '$lib/browse/folderScan';

beforeEach(() => {
	vi.clearAllMocks();
});

// ── helpers ──────────────────────────────────────────────────

const nativeFile = (name: string, relPath = name): StoredAudioFile => ({
	source: 'native',
	name,
	relativePath: relPath,
	path: `/sdcard/${relPath}`,
	mimeType: 'audio/mpeg',
});

const webFile = (name: string, relPath = name): StoredAudioFile => ({
	source: 'web',
	name,
	relativePath: relPath,
	file: new File([], name),
});

const driveFile = (name: string, relPath = name): StoredAudioFile => ({
	source: 'drive',
	name,
	relativePath: relPath,
	fileId: `id:${relPath}`,
});

/** A batch result shaped like `DirectoryReader.getAudioScanBatch`. */
const batch = (files: string[], done: boolean, foldersScanned = 1, foldersQueued = 0) => ({
	files: files.map((name) => ({ kind: 'file', name, path: `/sdcard/${name}`, relativePath: name })),
	foldersScanned,
	foldersQueued,
	done,
});

// jsdom has no FileSystemDirectoryHandle constructor; use the same plain-object
// stand-in tests/unit/browse/libraryCache.test.ts uses.
function fileHandle(name: string): FileSystemFileHandle {
	return {
		kind: 'file',
		name,
		async getFile() { return new File(['bytes'], name); },
	} as unknown as FileSystemFileHandle;
}

function dirHandle(name: string, ...entries: [string, FileSystemHandle][]): FileSystemDirectoryHandle {
	return {
		kind: 'directory',
		name,
		async *[Symbol.asyncIterator]() {
			for (const entry of entries) yield entry;
		},
	} as unknown as FileSystemDirectoryHandle;
}

const baseDeps = (overrides: Partial<CollectAllDeps> = {}): CollectAllDeps => ({
	librarySource: 'device',
	sortOrder: 'filename',
	allFiles: [],
	libraryScanPromise: null,
	rootDirHandle: null,
	nativeTreeUri: null,
	...overrides,
});

// ─────────────────────────────────────────────────────────────
// yieldScanToUi
// ─────────────────────────────────────────────────────────────

describe('yieldScanToUi', () => {
	it('does not resolve until a macrotask has been queued', async () => {
		let resolved = false;
		const pending = yieldScanToUi().then(() => { resolved = true; });
		// A microtask flush must not be enough; the yield is a setTimeout(0).
		await Promise.resolve();
		expect(resolved).toBe(false);
		await pending;
		expect(resolved).toBe(true);
	});

	it('resolves to undefined', async () => {
		await expect(yieldScanToUi()).resolves.toBeUndefined();
	});

	it('returns immediately when there is no window (server-side render)', async () => {
		vi.stubGlobal('window', undefined);
		try {
			await expect(yieldScanToUi()).resolves.toBeUndefined();
		} finally {
			vi.unstubAllGlobals();
		}
	});
});

// ─────────────────────────────────────────────────────────────
// scanNativeAudioFiles
// ─────────────────────────────────────────────────────────────

describe('scanNativeAudioFiles', () => {
	it('returns [] and does not start a scan without a tree URI', async () => {
		expect(await scanNativeAudioFiles(null, [], 10)).toEqual([]);
		expect(mocks.startAudioScan).not.toHaveBeenCalled();
	});

	it('collects every batch and reports progress until done', async () => {
		mocks.startAudioScan.mockResolvedValue({ scanId: 's1' });
		mocks.getAudioScanBatch
			.mockResolvedValueOnce(batch(['a.mp3'], false, 1, 2))
			.mockResolvedValueOnce(batch(['b.mp3'], true, 3, 0));
		const onBatch = vi.fn();

		const files = await scanNativeAudioFiles('content://tree', [], 10, {}, onBatch);

		expect(mocks.startAudioScan).toHaveBeenCalledWith({ treeUri: 'content://tree', path: undefined });
		expect(files.map((f) => f.name)).toEqual(['a.mp3', 'b.mp3']);
		expect(onBatch).toHaveBeenCalledTimes(2);
		expect(onBatch.mock.calls[0][1]).toEqual({ done: false, foldersScanned: 1, foldersQueued: 2, totalFiles: 1 });
		expect(onBatch.mock.calls[1][1]).toEqual({ done: true, foldersScanned: 3, foldersQueued: 0, totalFiles: 2 });
		// A completed scan is never cancelled.
		expect(mocks.cancelAudioScan).not.toHaveBeenCalled();
	});

	it('passes the browse path through as a joined string', async () => {
		mocks.startAudioScan.mockResolvedValue({ scanId: 's1' });
		mocks.getAudioScanBatch.mockResolvedValueOnce(batch([], true));
		await scanNativeAudioFiles('content://tree', ['Music', 'Live'], 10);
		expect(mocks.startAudioScan).toHaveBeenCalledWith({ treeUri: 'content://tree', path: 'Music/Live' });
	});

	it('uses initialBatchSize for the first batch and batchSize afterwards', async () => {
		mocks.startAudioScan.mockResolvedValue({ scanId: 's1' });
		mocks.getAudioScanBatch
			.mockResolvedValueOnce(batch(['a.mp3'], false))
			.mockResolvedValueOnce(batch([], true));
		await scanNativeAudioFiles('content://tree', [], 48, { initialBatchSize: 1 });
		expect(mocks.getAudioScanBatch.mock.calls[0][0]).toEqual({ scanId: 's1', batchSize: 1 });
		expect(mocks.getAudioScanBatch.mock.calls[1][0]).toEqual({ scanId: 's1', batchSize: 48 });
	});

	it('clamps a zero or negative initialBatchSize up to one', async () => {
		mocks.startAudioScan.mockResolvedValue({ scanId: 's1' });
		mocks.getAudioScanBatch.mockResolvedValueOnce(batch([], true));
		await scanNativeAudioFiles('content://tree', [], 48, { initialBatchSize: 0 });
		expect(mocks.getAudioScanBatch.mock.calls[0][0]).toEqual({ scanId: 's1', batchSize: 1 });
	});

	it('does not report an empty batch to onBatch', async () => {
		mocks.startAudioScan.mockResolvedValue({ scanId: 's1' });
		mocks.getAudioScanBatch
			.mockResolvedValueOnce(batch([], false))
			.mockResolvedValueOnce(batch(['later.mp3'], true));
		const onBatch = vi.fn();
		const files = await scanNativeAudioFiles('content://tree', [], 10, {}, onBatch);
		expect(onBatch).toHaveBeenCalledTimes(1);
		expect(onBatch.mock.calls[0][0].map((f: StoredAudioFile) => f.name)).toEqual(['later.mp3']);
		expect(files.map((f) => f.name)).toEqual(['later.mp3']);
	});

	it('cancels the scan when a batch rejects', async () => {
		mocks.startAudioScan.mockResolvedValue({ scanId: 's1' });
		mocks.getAudioScanBatch.mockRejectedValueOnce(new Error('device gone'));
		mocks.cancelAudioScan.mockResolvedValue(undefined);

		await expect(scanNativeAudioFiles('content://tree', [], 10)).rejects.toThrow('device gone');
		expect(mocks.cancelAudioScan).toHaveBeenCalledWith({ scanId: 's1' });
	});

	it('swallows a cancellation failure and still rejects', async () => {
		mocks.startAudioScan.mockResolvedValue({ scanId: 's1' });
		mocks.getAudioScanBatch.mockRejectedValueOnce(new Error('device gone'));
		mocks.cancelAudioScan.mockRejectedValueOnce(new Error('cancel failed'));
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

		await expect(scanNativeAudioFiles('content://tree', [], 10)).rejects.toThrow('device gone');
		expect(warn).toHaveBeenCalled();
		warn.mockRestore();
	});
});

// ─────────────────────────────────────────────────────────────
// pickNativeAudioDirectory
// ─────────────────────────────────────────────────────────────

describe('pickNativeAudioDirectory', () => {
	it('returns the picked tree URI and the listed folder name', async () => {
		mocks.pickDirectory.mockResolvedValue({ path: 'content://tree/9' });
		mocks.listEntries.mockResolvedValue({ folderName: 'Music', entries: [] });

		await expect(pickNativeAudioDirectory()).resolves.toEqual({ treeUri: 'content://tree/9', folderName: 'Music' });
		expect(mocks.listEntries).toHaveBeenCalledWith({ treeUri: 'content://tree/9' });
	});
});

// ─────────────────────────────────────────────────────────────
// collectAllFromPath
// ─────────────────────────────────────────────────────────────

describe('collectAllFromPath', () => {
	it('filters the snapshot for the drive source', async () => {
		const deps = baseDeps({
			librarySource: 'drive',
			allFiles: [driveFile('x.mp3', 'a/x.mp3'), driveFile('y.mp3', 'b/y.mp3')],
		});
		const files = await collectAllFromPath(['a'], deps);
		expect(files.map((f) => f.name)).toEqual(['x.mp3']);
		expect(mocks.listAudioFiles).not.toHaveBeenCalled();
	});

	it('returns an empty list for the drive source even when a native tree exists', async () => {
		// The drive branch short-circuits, so an empty drive snapshot must not
		// fall through to a live native listing.
		const deps = baseDeps({ librarySource: 'drive', allFiles: [], nativeTreeUri: 'content://tree' });
		expect(await collectAllFromPath([], deps)).toEqual([]);
		expect(mocks.listAudioFiles).not.toHaveBeenCalled();
	});

	it('filters the in-memory snapshot for the device source', async () => {
		const deps = baseDeps({ allFiles: [nativeFile('x.mp3', 'a/x.mp3'), nativeFile('y.mp3', 'b/y.mp3')] });
		expect((await collectAllFromPath(['a'], deps)).map((f) => f.name)).toEqual(['x.mp3']);
	});

	it('awaits an in-flight scan promise when the snapshot is empty', async () => {
		const deps = baseDeps({ libraryScanPromise: Promise.resolve([nativeFile('z.mp3', 'a/z.mp3')]) });
		expect((await collectAllFromPath(['a'], deps)).map((f) => f.name)).toEqual(['z.mp3']);
	});

	it('honours the injected sort order', async () => {
		const deps = baseDeps({
			sortOrder: 'title',
			allFiles: [nativeFile('B - a.mp3'), nativeFile('A - z.mp3')],
		});
		expect((await collectAllFromPath([], deps)).map((f) => f.name)).toEqual(['B - a.mp3', 'A - z.mp3']);
	});

	it('walks a File System Access root handle and wraps files as stored web files', async () => {
		const sub = dirHandle('sub', ['inner.mp3', fileHandle('inner.mp3')]);
		const root = dirHandle('root', ['sub', sub], ['top.mp3', fileHandle('top.mp3')]);
		const deps = baseDeps({ rootDirHandle: root });

		const files = await collectAllFromPath(['sub'], deps);
		expect(files.map((f) => `${f.source}:${f.name}`)).toEqual(['web:inner.mp3']);
	});

	it('returns an empty list when the root handle has no such path', async () => {
		const root = dirHandle('root', ['other', dirHandle('other')]);
		const deps = baseDeps({ rootDirHandle: root });
		expect(await collectAllFromPath(['missing'], deps)).toEqual([]);
	});

	it('lists native audio through the tree URI as a last resort', async () => {
		mocks.listAudioFiles.mockResolvedValue({
			folderName: 'Music',
			files: [{ kind: 'file', name: 'n.mp3', path: '/sdcard/n.mp3', relativePath: 'n.mp3' }],
		});
		const deps = baseDeps({ nativeTreeUri: 'content://tree' });

		const files = await collectAllFromPath([], deps);
		expect(files).toEqual([{ source: 'native', name: 'n.mp3', relativePath: 'n.mp3', path: '/sdcard/n.mp3', mimeType: undefined, modifiedAt: undefined }]);
		expect(mocks.listAudioFiles).toHaveBeenCalledWith({ treeUri: 'content://tree', path: undefined });
	});

	it('returns an empty list when no source is available', async () => {
		expect(await collectAllFromPath([], baseDeps())).toEqual([]);
	});
});
