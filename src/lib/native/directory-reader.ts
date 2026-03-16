import { registerPlugin } from '@capacitor/core';

export interface NativeDirectoryFile {
	name: string;
	path: string;
	relativePath: string;
	mimeType?: string;
	modifiedAt?: number;
}

export interface ListDirectoryFilesResult {
	folderName: string;
	files: NativeDirectoryFile[];
}

interface DirectoryReaderPlugin {
	listFiles(options: { treeUri: string }): Promise<ListDirectoryFilesResult>;
}

export const DirectoryReader = registerPlugin<DirectoryReaderPlugin>('DirectoryReader');