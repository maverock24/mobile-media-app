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
}

interface DirectoryReaderPlugin {
	listEntries(options: { treeUri: string; path?: string }): Promise<ListDirectoryEntriesResult>;
	listAudioFiles(options: { treeUri: string; path?: string }): Promise<ListDirectoryFilesResult>;
}

export const DirectoryReader = registerPlugin<DirectoryReaderPlugin>('DirectoryReader');