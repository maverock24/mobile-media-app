/**
 * Shared types and helpers for the Music (MP3) player.
 * Extracted from Mp3PlayerView.svelte to reduce file size and enable reuse.
 */

// ─── StoredAudioFile — unified representation of an MP3 file from any source ───

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

export interface Track {
	id: number;
	title: string;
	artist: string;
	filename: string;
	url: string;
	duration: number;
	cleanup?: () => void;
	source: StoredAudioFile;
}

export type FavoriteTrack =
	| { key: string; name: string; title: string; artist: string; relativePath: string; source: 'web' }
	| { key: string; name: string; title: string; artist: string; relativePath: string; source: 'native'; path: string; mimeType?: string; modifiedAt?: number }
	| { key: string; name: string; title: string; artist: string; relativePath: string; source: 'drive'; fileId: string; mimeType?: string; modifiedAt?: number; sizeBytes?: number; webViewLink?: string };

export type CachedWebLibraryFile = { source: 'web'; name: string; relativePath: string; file: File };
export type CachedNativeLibraryFile = {
	source: 'native';
	name: string;
	relativePath: string;
	path: string;
	mimeType?: string;
	modifiedAt?: number;
};
export type CachedLibraryFile = CachedWebLibraryFile | CachedNativeLibraryFile;
export type CachedLibrary = { folderName: string; files: CachedLibraryFile[]; savedAt: number; cacheKey?: string };

// ─── EQ Constants ────────────────────────────────────────────────────────────

export const EQ_FREQS  = [60, 170, 350, 1000, 3500, 10000];
export const EQ_LABELS = ['60', '170', '350', '1K', '3.5K', '10K'];
export const EQ_PRESETS: Record<string, number[]> = {
	flat:      [ 0,  0,  0,  0,  0,  0],
	bass:      [ 8,  5,  2,  0, -1, -1],
	treble:    [-1, -1,  0,  2,  5,  8],
	vocal:     [-2,  0,  4,  5,  3, -1],
	classical: [ 4,  3, -1,  0,  2,  4],
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

export function getStoredFileKey(source: StoredAudioFile): string {
	if (source.source === 'drive') return `d:${source.fileId}`;
	if (source.source === 'native') return `n:${source.relativePath}`;
	return `w:${source.relativePath}`;
}

export function getTrackKey(source: StoredAudioFile): string {
	return getStoredFileKey(source);
}

export function createStoredAudioFile(file: File): StoredAudioFile {
	const relativePath = file.webkitRelativePath?.split('/').slice(1).join('/') ?? file.name;
	return createStoredWebAudioFile(file, relativePath && relativePath.length > 0 ? relativePath : file.name);
}

export function createStoredWebAudioFile(file: File, relativePath: string): StoredAudioFile {
	return {
		source: 'web',
		name: file.name,
		relativePath: relativePath && relativePath.length > 0 ? relativePath : file.name,
		file,
	};
}

export interface NativeDirectoryFile {
	kind: 'file';
	name: string;
	path: string;
	relativePath: string;
	mimeType?: string;
	modifiedAt?: number;
}

export function createStoredNativeAudioFile(entry: NativeDirectoryFile): StoredAudioFile {
	return {
		source: 'native',
		name: entry.name,
		relativePath: entry.relativePath,
		path: entry.path,
		mimeType: entry.mimeType,
		modifiedAt: entry.modifiedAt,
	};
}

export interface GoogleDriveFile {
	id: string;
	name: string;
	mimeType?: string;
	modifiedTime?: string;
	size?: string;
	webViewLink?: string;
	relativePath?: string;
}

export function createStoredDriveAudioFile(entry: GoogleDriveFile): StoredAudioFile {
	return {
		source: 'drive',
		name: entry.name,
		relativePath: entry.relativePath ?? entry.name,
		fileId: entry.id,
		mimeType: entry.mimeType,
		modifiedAt: entry.modifiedTime ? new Date(entry.modifiedTime).getTime() : undefined,
		sizeBytes: entry.size ? Number(entry.size) : undefined,
		webViewLink: entry.webViewLink,
	};
}

export function getRelativePath(file: StoredAudioFile): string {
	return file.relativePath && file.relativePath.length > 0 ? file.relativePath : file.name;
}

export function parseFilename(filename: string): { title: string; artist: string } {
	const name = filename.replace(/\.mp3$/i, '').replace(/_/g, ' ');
	const sep = name.indexOf(' - ');
	if (sep > 0) return { artist: name.slice(0, sep).trim(), title: name.slice(sep + 3).trim() };
	return { title: name, artist: 'Unknown Artist' };
}

export function formatTime(seconds: number): string {
	if (!isFinite(seconds) || seconds < 0) return '0:00';
	const m = Math.floor(seconds / 60), s = Math.floor(seconds % 60);
	return `${m}:${s.toString().padStart(2, '0')}`;
}

/** Clock format with hours when needed: H:MM:SS or M:SS. */
export function formatClock(seconds: number): string {
	if (!isFinite(seconds) || seconds < 0) return '0:00';
	const h = Math.floor(seconds / 3600);
	const m = Math.floor((seconds % 3600) / 60);
	const s = Math.floor(seconds % 60);
	if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
	return `${m}:${String(s).padStart(2, '0')}`;
}

/** Compact human duration for list/tile contexts: `Hh Mm`, `M:SS`, or `–` when empty.
 *  Use for episode/card durations where clock format (`H:MM:SS`) is too wide. */
export function formatDuration(seconds: number): string {
	if (!seconds || seconds < 0 || !isFinite(seconds)) return '–';
	const h = Math.floor(seconds / 3600);
	const m = Math.floor((seconds % 3600) / 60);
	const s = Math.floor(seconds % 60);
	if (h > 0) return `${h}h ${m}m`;
	return `${m}:${s.toString().padStart(2, '0')}`;
}

export function sortFiles(files: StoredAudioFile[], sortOrder: string): StoredAudioFile[] {
	return [...files].sort((a, b) => {
		if (sortOrder === 'title')
			return parseFilename(a.name).title.localeCompare(parseFilename(b.name).title);
		if (sortOrder === 'artist')
			return parseFilename(a.name).artist.localeCompare(parseFilename(b.name).artist);
		return a.name.localeCompare(b.name, undefined, { numeric: true });
	});
}

export function mergeStoredFiles(existing: StoredAudioFile[], incoming: StoredAudioFile[]): StoredAudioFile[] {
	if (incoming.length === 0) return existing;
	const seen = new Set(existing.map((file) => getStoredFileKey(file)));
	const merged = [...existing];
	for (const file of incoming) {
		const key = getStoredFileKey(file);
		if (seen.has(key)) continue;
		seen.add(key);
		merged.push(file);
	}
	return merged;
}

export function fmtGain(g: number): string { return (g > 0 ? '+' : '') + g; }
