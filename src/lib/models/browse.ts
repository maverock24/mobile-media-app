import type { BrowseEntry, StoredAudioFile } from '$lib/stores/library.svelte';

/**
 * Extract a stable relative path from a stored file.
 * Falls back to the file name when relativePath is missing.
 */
export function getRelativePath(file: StoredAudioFile): string {
	return file.relativePath && file.relativePath.length > 0 ? file.relativePath : file.name;
}

/**
 * Build a list of BrowseEntries (folders + files) from a flat file array
 * at the given navigation path. Folders are derived from path prefixes.
 */
export function buildBrowseEntries(files: StoredAudioFile[], path: string[]): BrowseEntry[] {
	const prefix = path.length > 0 ? path.join('/') + '/' : '';
	const folderCounts = new Map<string, number>();
	const directFiles: BrowseEntry[] = [];

	for (const file of files) {
		const normalized = getRelativePath(file);
		if (!normalized.startsWith(prefix)) continue;
		const remaining = normalized.slice(prefix.length);
		if (!remaining) continue;
		const slash = remaining.indexOf('/');
		if (slash === -1) {
			directFiles.push({ kind: 'file', name: remaining, file });
			continue;
		}
		const folderName = remaining.slice(0, slash);
		folderCounts.set(folderName, (folderCounts.get(folderName) ?? 0) + 1);
	}

	const folders: BrowseEntry[] = Array.from(folderCounts.entries(), ([name, count]) => ({
		kind: 'folder',
		name,
		count,
	}));
	folders.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
	directFiles.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
	return [...folders, ...directFiles];
}
