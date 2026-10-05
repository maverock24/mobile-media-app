export type StoredAudioFile =
	| { source: 'web'; name: string; relativePath: string; file: File }
	| { source: 'native'; name: string; relativePath: string; path: string; mimeType?: string; modifiedAt?: number }
	| {
			source: 'drive';
			name: string;
			relativePath: string;
			fileId: string;
			mimeType?: string;
			modifiedAt?: number;
			sizeBytes?: number;
			webViewLink?: string;
		};

export type BrowseEntry =
	| { kind: 'folder'; name: string; count: number }
	| { kind: 'file'; name: string; file: StoredAudioFile };
