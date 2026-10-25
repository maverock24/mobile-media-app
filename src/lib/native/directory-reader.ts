import { registerPlugin } from '@capacitor/core';

export interface NativeDirectoryFile {
	kind: 'file';
	name: string;
	path: string;
	relativePath: string;
	mimeType?: string;
	modifiedAt?: number;
	sizeBytes?: number;
}

export interface NativeDirectoryFolder {
	kind: 'folder';
	name: string;
	relativePath: string;
}

/** One directory row reported by a delta-aware native walk. */
export interface NativeDirectoryDir {
	path: string;
	mtime: number;
}

export interface ListDirectoryEntriesResult {
	folderName: string;
	entries: Array<NativeDirectoryFolder | NativeDirectoryFile>;
}

export interface ListDirectoryFilesResult {
	folderName: string;
	files: NativeDirectoryFile[];
	truncated?: boolean;
	count?: number;
}

export interface StartAudioScanResult {
	scanId: string;
	folderName: string;
	foldersScanned: number;
	foldersQueued: number;
}

export interface AudioScanBatchResult {
	files: NativeDirectoryFile[];
	foldersScanned: number;
	foldersQueued: number;
	done: boolean;
	/**
	 * Directory rows observed during this batch. Absent on an APK older than the delta
	 * walk. The first batch always carries the scan root as `{ path: '', mtime }`, so a
	 * library whose files all sit in the root still reports a non-empty tree.
	 */
	dirs?: NativeDirectoryDir[];
	/** Directories skipped because their cached mtime matched. Cumulative over the scan. */
	skippedDirs?: number;
	/**
	 * The relative paths behind `skippedDirs`, cumulative over the scan. A count alone
	 * cannot be turned back into paths: a directory the walk skipped is still on the
	 * device, while one it never saw may have been deleted. Absent on an APK older
	 * than this field.
	 */
	skippedPaths?: string[];
	/** Directories this walk could not read. Cumulative over the scan. */
	unreadableDirs?: number;
}

interface DirectoryReaderPlugin {
	rememberTreeUri(options: { treeUri: string }): Promise<void>;
	listEntries(options: { treeUri: string; path?: string }): Promise<ListDirectoryEntriesResult>;
	listAudioFiles(options: { treeUri: string; path?: string }): Promise<ListDirectoryFilesResult>;
	startAudioScan(options: { treeUri: string; path?: string; prevDirs?: NativeDirectoryDir[] }): Promise<StartAudioScanResult>;
	getAudioScanBatch(options: { scanId: string; batchSize?: number }): Promise<AudioScanBatchResult>;
	cancelAudioScan(options: { scanId: string }): Promise<void>;
	writeFile(options: { treeUri: string; path?: string; fileName: string; mimeType?: string; data: string }): Promise<{ path: string }>;
	appendFileChunk(options: { treeUri: string; path?: string; fileName: string; mimeType?: string; data: string; create?: boolean }): Promise<{ path: string }>;
	deleteEntry(options: { treeUri: string; path?: string; name: string }): Promise<void>;
	copyEntry(options: { srcTreeUri: string; srcPath?: string; srcName: string; destTreeUri: string; destPath?: string; destName: string }): Promise<void>;
	moveEntry(options: { srcTreeUri: string; srcPath?: string; srcName: string; destTreeUri: string; destPath?: string; destName: string }): Promise<void>;
	installApk(options: { path: string }): Promise<void>;
}

export const DirectoryReader = registerPlugin<DirectoryReaderPlugin>('DirectoryReader');