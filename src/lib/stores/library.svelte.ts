import { musicSettings } from './settings.svelte';
import { googleDriveSession } from './googleDriveSession.svelte';
import { streamGoogleDriveMp3Files } from '$lib/google-drive';
import { DirectoryReader } from '$lib/native/directory-reader';

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

class LibraryStore {
	#isLoading = $state(false);
	#lastScanAt = $state<number | null>(null);
	#folderEntries = $state<Map<string, BrowseEntry[]>>(new Map());
	#isTruncated = $state(false);
	#fileCount = $state(0);

	get isLoading() { return this.#isLoading; }
	get lastScanAt() { return this.#lastScanAt; }
	get isTruncated() { return this.#isTruncated; }
	get fileCount() { return this.#fileCount; }

	// ── IndexedDB access ──────────────────────────────────────────
	async #openIDB(): Promise<IDBDatabase> {
		return new Promise((res, rej) => {
			const req = indexedDB.open('music-app-library', 1);
			req.onupgradeneeded = () => {
				const db = req.result;
				if (!db.objectStoreNames.contains('libraries')) db.createObjectStore('libraries');
			};
			req.onsuccess = () => res(req.result);
			req.onerror  = () => rej(req.error);
		});
	}

	async #saveToCache(folderPath: string, entries: BrowseEntry[]) {
		try {
			const db = await this.#openIDB();
			const tx = db.transaction('libraries', 'readwrite');
			const key = `${musicSettings.librarySource}:${folderPath}`;
			tx.objectStore('libraries').put({ entries, savedAt: Date.now() }, key);
			await new Promise<void>((res, rej) => { tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); });
			db.close();
		} catch (e) { console.error('Library cache write failed', e); }
	}

	async bustCache() {
		const db = await this.#openIDB();
		const tx = db.transaction('libraries', 'readwrite');
		tx.objectStore('libraries').clear();
		await new Promise<void>((res) => { tx.oncomplete = () => res(); });
		db.close();
	}

	get folderTree() { return this.#folderEntries; }
	get isTreeSyncing() { return false; }

	getBrowseEntries(path: string[]): BrowseEntry[] {
		return this.#folderEntries.get(path.join('/')) ?? [];
	}

	async fetchEntries(path: string[]): Promise<BrowseEntry[]> {
		const pathStr = path.join('/');
		const cached = this.#folderEntries.get(pathStr);
		if (cached) return cached;

		const source = musicSettings.librarySource;
		this.#isLoading = true;
		try {
			let entries: BrowseEntry[] = [];
			if (source === 'device' && musicSettings.nativeTreeUri) {
				const result = await DirectoryReader.listEntries({ 
					treeUri: musicSettings.nativeTreeUri,
					path: pathStr
				});
				entries = result.entries.map(e => {
					if (e.kind === 'folder') return { kind: 'folder', name: e.name, count: 0 };
					return {
						kind: 'file',
						name: e.name,
						file: {
							source: 'native',
							name: e.name,
							relativePath: e.relativePath,
							path: e.path!,
							mimeType: e.mimeType,
							modifiedAt: e.modifiedAt
						}
					};
				});
			}

			this.#folderEntries.set(pathStr, entries);
			return entries;
		} catch (e) {
			console.error('Failed to fetch entries', e);
			return [];
		} finally {
			this.#isLoading = false;
		}
	}

	async initialize() {
		this.#folderEntries.clear();
		// Automatically fetch root if possible
		if (musicSettings.librarySource === 'device' && musicSettings.nativeTreeUri) {
			await this.fetchEntries([]);
		}
	}

	async rescan(options?: { rootDirHandle?: FileSystemDirectoryHandle }) {
		this.#isLoading = true;
		try {
			this.#folderEntries.clear();
			if (musicSettings.librarySource === 'device') {
				if (musicSettings.nativeTreeUri) {
					await this.fetchEntries([]);
				} else if (options?.rootDirHandle) {
					await this.#rescanDirHandle(options.rootDirHandle);
				}
			} else if (musicSettings.librarySource === 'drive') {
				await this.#rescanDrive();
			}
			this.#lastScanAt = Date.now();
		} finally {
			this.#isLoading = false;
		}
	}

	async #rescanDirHandle(handle: FileSystemDirectoryHandle) {
		const entries: BrowseEntry[] = [];
		for await (const [name, h] of (handle as any)) {
			if (h.kind === 'file' && name.toLowerCase().endsWith('.mp3')) {
				const file = await h.getFile();
				entries.push({
					kind: 'file',
					name,
					file: { source: 'web', name, relativePath: name, file }
				});
			} else if (h.kind === 'directory') {
				entries.push({ kind: 'folder', name, count: 0 });
			}
		}
		this.#folderEntries.set("", entries);
	}

	async #rescanDrive() {
		const folderId = musicSettings.driveFolderId || undefined;
		const token = googleDriveSession.accessToken;
		if (!token) return;

		const entries: BrowseEntry[] = [];
		for await (const batch of streamGoogleDriveMp3Files(token, { folderId })) {
			for (const f of batch.files) {
				entries.push({
					kind: 'file',
					name: f.name,
					file: {
						source: 'drive' as const,
						name: f.name,
						relativePath: f.relativePath ?? f.name,
						fileId: f.id,
						mimeType: f.mimeType,
						modifiedAt: f.modifiedTime ? new Date(f.modifiedTime).getTime() : undefined,
						sizeBytes: f.size ? Number(f.size) : undefined,
						webViewLink: f.webViewLink,
					}
				});
			}
		}
		this.#folderEntries.set("", entries);
	}

	setFiles(files: StoredAudioFile[], folderName: string) {
		const entries: BrowseEntry[] = files.map(f => ({ kind: 'file', name: f.name, file: f }));
		this.#folderEntries.set("", entries);
		this.#lastScanAt = Date.now();
	}
}

export const library = new LibraryStore();
