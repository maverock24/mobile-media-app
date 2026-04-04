import { musicSettings } from './settings.svelte';
import { googleDriveSession } from './googleDriveSession.svelte';
import { streamGoogleDriveMp3Files, type GoogleDriveFile } from '$lib/google-drive';
import { DirectoryReader, type NativeDirectoryFile } from '$lib/native/directory-reader';

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
	#allFiles = $state<StoredAudioFile[]>([]);
	#isLoading = $state(false);
	#lastScanAt = $state<number | null>(null);
	#folderTree = $state<Map<string, { folders: BrowseEntry[], files: BrowseEntry[] }>>(new Map([["", { folders: [], files: [] }]]));
	#treeUpdateTimer: ReturnType<typeof setTimeout> | null = null;
	#isTreeSyncing = $state(false);
	#isTruncated = $state(false);
	#fileCount = $state(0);

	get allFiles() { return this.#allFiles; }
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

	async #saveToCache(files: StoredAudioFile[], folderName: string) {
		try {
			const db = await this.#openIDB();
			const tx = db.transaction('libraries', 'readwrite');
			// We store by librarySource + folderName/Id to allow quick switching
			const key = `${musicSettings.librarySource}:${folderName}`;
			tx.objectStore('libraries').put({ files, savedAt: Date.now() }, key);
			await new Promise<void>((res, rej) => { tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); });
			db.close();
		} catch (e) { console.error('Library cache write failed', e); }
	}

	async #loadFromCache(folderName: string): Promise<StoredAudioFile[] | null> {
		try {
			const db = await this.#openIDB();
			const tx = db.transaction('libraries', 'readonly');
			const key = `${musicSettings.librarySource}:${folderName}`;
			const entry = await new Promise<{ files: StoredAudioFile[]; savedAt: number } | null>((res, rej) => {
				const req = tx.objectStore('libraries').get(key);
				req.onsuccess = () => res(req.result ?? null);
				req.onerror = () => rej(req.error);
			});
			db.close();
			if (!entry) return null;
			this.#lastScanAt = entry.savedAt;
			return entry.files;
		} catch { return null; }
	}

	async bustCache() {
		const db = await this.#openIDB();
		const tx = db.transaction('libraries', 'readwrite');
		tx.objectStore('libraries').clear();
		await new Promise<void>((res) => { tx.oncomplete = () => res(); });
		db.close();
	}

	// ── Async Folder Tree Rebuild (Debounced) ───────────────────
	scheduleTreeRebuild() {
		if (this.#treeUpdateTimer) clearTimeout(this.#treeUpdateTimer);
		this.#treeUpdateTimer = setTimeout(() => {
			this.#treeUpdateTimer = null;
			void this.#rebuildFolderTree();
		}, 300);
	}

	async #rebuildFolderTree() {
		this.#isTreeSyncing = true;
		
		const files = this.#allFiles;
		const tree = new Map<string, { folders: BrowseEntry[], files: BrowseEntry[] }>();
		tree.set("", { folders: [], files: [] });

		// Process in chunks to keep UI alive
		const CHUNK_SIZE = 1000;
		for (let i = 0; i < files.length; i += CHUNK_SIZE) {
			const chunk = files.slice(i, i + CHUNK_SIZE);
			
			for (const file of chunk) {
				const rel = file.relativePath || file.name;
				const segments = rel.split('/');
				const fileName = segments.pop()!;
				
				let currentPath = "";
				for (const segment of segments) {
					const parentPath = currentPath;
					currentPath = currentPath ? `${currentPath}/${segment}` : segment;
					
					if (!tree.has(currentPath)) {
						tree.set(currentPath, { folders: [], files: [] });
						const parent = tree.get(parentPath)!;
						if (!parent.folders.find(f => f.name === segment)) {
							parent.folders.push({ kind: 'folder', name: segment, count: 0 });
						}
					}
				}
				
				const fileFolder = tree.get(currentPath);
				if (fileFolder) {
					fileFolder.files.push({ kind: 'file', name: fileName, file });
				}
			}

			// Yield to browser
			await new Promise(res => setTimeout(res, 0));
		}

		// Calculate counts and sort
		for (const [path, node] of tree.entries()) {
			node.folders.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
			node.files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
			
			for (const f of node.folders) {
				const fullPath = path ? `${path}/${f.name}` : f.name;
				const subNode = tree.get(fullPath);
				if (f.kind === 'folder') {
					f.count = subNode ? subNode.files.length : 0;
				}
			}
		}

		this.#folderTree = tree;
		this.#isTreeSyncing = false;
	}


	get folderTree() { return this.#folderTree; }
	get isTreeSyncing() { return this.#isTreeSyncing; }

	getBrowseEntries(path: string[]): BrowseEntry[] {
		const pathStr = path.join('/');
		const node = this.#folderTree.get(pathStr);
		if (!node) return [];
		return [...node.folders, ...node.files];
	}

	async initialize() {
		const source = musicSettings.librarySource;
		const folderName = source === 'drive' ? (musicSettings.driveFolderId || '_all') : musicSettings.lastFolderName;
		
		if (!folderName) return;

		const cached = await this.#loadFromCache(folderName);
		if (cached) {
			this.#allFiles = cached;
			void this.#rebuildFolderTree(); // Sync now for instant cache hit
		}
	}

	async rescan(options?: { rootDirHandle?: FileSystemDirectoryHandle }) {
		this.#isLoading = true;
		try {
			if (musicSettings.librarySource === 'drive') {
				await this.#rescanDrive();
			} else if (musicSettings.librarySource === 'device') {
				if (musicSettings.nativeTreeUri) {
					await this.#rescanNative(musicSettings.nativeTreeUri);
				} else if (options?.rootDirHandle) {
					await this.#rescanDirHandle(options.rootDirHandle);
				} else {
					// Cannot rescan web directory without handle (lost on reload)
					this.#allFiles = [];
				}
			}
		} finally {
			this.#isLoading = false;
		}
	}

	async #rescanNative(treeUri: string) {
		try {
			const result = await DirectoryReader.listAudioFiles({ treeUri });
			const files = result.files.map(f => ({
				source: 'native' as const,
				name: f.name,
				relativePath: f.relativePath,
				path: f.path,
				mimeType: f.mimeType,
				modifiedAt: f.modifiedAt,
			}));
			this.#allFiles = files;
			this.#lastScanAt = Date.now();
			this.#isTruncated = result.truncated || false;
			this.#fileCount = result.count || files.length;
			await this.#saveToCache(files, treeUri);
			this.scheduleTreeRebuild();
		} catch (e) {
			console.error('Native rescan failed', e);
		}
	}

	async #rescanDirHandle(handle: FileSystemDirectoryHandle) {
		// This logic matches Mp3PlayerView's collectStoredFilesFromDirHandle
		const files: StoredAudioFile[] = [];
		const collect = async (dir: FileSystemDirectoryHandle, pathSegments: string[] = []) => {
			for await (const [name, h] of (dir as any)) {
				if (h.kind === 'file' && name.toLowerCase().endsWith('.mp3')) {
					const file = await h.getFile();
					files.push({
						source: 'web',
						name,
						relativePath: [...pathSegments, name].join('/'),
						file
					});
				} else if (h.kind === 'directory') {
					await collect(h, [...pathSegments, name]);
				}
			}
		};
		await collect(handle);
		this.#allFiles = files;
		this.#lastScanAt = Date.now();
		await this.#saveToCache(files, handle.name);
		this.scheduleTreeRebuild();
	}

	async #rescanDrive() {
		const folderId = musicSettings.driveFolderId || undefined;
		const token = googleDriveSession.accessToken;
		if (!token) return;

		const files: StoredAudioFile[] = [];
		for await (const batch of streamGoogleDriveMp3Files(token, { folderId })) {
			files.push(...batch.files.map(f => ({
				source: 'drive' as const,
				name: f.name,
				relativePath: f.relativePath ?? f.name,
				fileId: f.id,
				mimeType: f.mimeType,
				modifiedAt: f.modifiedTime ? new Date(f.modifiedTime).getTime() : undefined,
				sizeBytes: f.size ? Number(f.size) : undefined,
				webViewLink: f.webViewLink,
			})));
		}
		this.#allFiles = files;
		this.#lastScanAt = Date.now();
		await this.#saveToCache(files, musicSettings.driveFolderId || '_all');
		this.scheduleTreeRebuild();
	}

	setFiles(files: StoredAudioFile[], folderName: string) {
		this.#allFiles = files;
		this.#lastScanAt = Date.now();
		void this.#saveToCache(files, folderName);
		this.scheduleTreeRebuild();
	}
}

function pathJoin(p1: string, p2: string) {
	if (!p1) return p2;
	if (!p2) return p1;
	return `${p1}/${p2}`;
}

export const library = new LibraryStore();
