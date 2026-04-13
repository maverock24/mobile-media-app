import { registerPlugin } from '@capacitor/core';

export interface NativeDirectoryFile {
	kind: 'file';
	name: string;
	path: string;
	relativePath: string;
	mimeType?: string;
	modifiedAt?: number;
}

export interface NativeDirectoryFolder {
	kind: 'folder';
	name: string;
	relativePath: string;
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
}

interface DirectoryReaderPlugin {
	rememberTreeUri(options: { treeUri: string }): Promise<void>;
	listEntries(options: { treeUri: string; path?: string }): Promise<ListDirectoryEntriesResult>;
	listAudioFiles(options: { treeUri: string; path?: string }): Promise<ListDirectoryFilesResult>;
	startAudioScan(options: { treeUri: string; path?: string }): Promise<StartAudioScanResult>;
	getAudioScanBatch(options: { scanId: string; batchSize?: number }): Promise<AudioScanBatchResult>;
	cancelAudioScan(options: { scanId: string }): Promise<void>;
	installApk(options: { path: string }): Promise<void>;
}

export const DirectoryReader = registerPlugin<DirectoryReaderPlugin>('DirectoryReader');