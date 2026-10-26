/**
 * resolve.ts — turn a `StoredAudioFile` into the serialisable `PairingTrackRef`
 * a pair stores, and turn a ref back into a playable file.
 *
 * `resolvePairingTrack` follows the order of `resolveFavoriteTrackFile`
 * (`$lib/favorites/favoriteTracks.ts:165-194`), which is the only proven
 * version of this lookup (Q31): the live library index first, keyed by
 * `getStoredFileKey`, so a file that is still loaded is returned as the very
 * object the deck already holds; then a per-source reconstruction from the
 * ref's own metadata, so a native or drive file that fell out of the index
 * (deleted folder, expired scan, restart before the library loads) still
 * plays. A `web` ref with no live `File` cannot be rebuilt, exactly as for
 * favourites, so it resolves to `null` and the caller decides what to say
 * (D5: toast, start nothing for A, start A alone for B).
 *
 * Rune-free on purpose (D10): both functions are pure, so they are unit
 * tested directly and can be called from a component or a plain module.
 */
import { getRelativePath, getStoredFileKey, type StoredAudioFile } from '$lib/models/music';
import type { PairingTrackRef } from './types';

/**
 * Build the store's copy of a file. `source` is added per branch so TS keeps
 * the discriminant narrow — spreading the source object would widen it to the
 * whole `StoredAudioFile` union and no `PairingTrackRef` member would accept it.
 */
export function toTrackRef(file: StoredAudioFile): PairingTrackRef {
	const base = {
		key: getStoredFileKey(file),
		name: file.name,
		relativePath: getRelativePath(file),
	};

	if (file.source === 'native') {
		return {
			...base,
			source: 'native',
			path: file.path,
			mimeType: file.mimeType,
			modifiedAt: file.modifiedAt,
		};
	}

	if (file.source === 'drive') {
		return {
			...base,
			source: 'drive',
			fileId: file.fileId,
			mimeType: file.mimeType,
			modifiedAt: file.modifiedAt,
			sizeBytes: file.sizeBytes,
			webViewLink: file.webViewLink,
		};
	}

	return { ...base, source: 'web' };
}

/**
 * Resolve a stored ref against the deck's current library index.
 *
 * Returns the indexed file when its stored key matches, else a file rebuilt
 * from the ref, else `null`. The index is `readonly` so callers can hand in a
 * live array (or a composed one) without the resolver implying it may reorder.
 */
export function resolvePairingTrack(
	ref: PairingTrackRef,
	index: readonly StoredAudioFile[]
): StoredAudioFile | null {
	const indexed = index.find((file) => getStoredFileKey(file) === ref.key);
	if (indexed) return indexed;

	if (ref.source === 'native' && ref.path) {
		return {
			source: 'native',
			name: ref.name,
			relativePath: ref.relativePath,
			path: ref.path,
			mimeType: ref.mimeType,
			modifiedAt: ref.modifiedAt,
		};
	}

	if (ref.source === 'drive' && ref.fileId) {
		return {
			source: 'drive',
			name: ref.name,
			relativePath: ref.relativePath,
			fileId: ref.fileId,
			mimeType: ref.mimeType,
			modifiedAt: ref.modifiedAt,
			sizeBytes: ref.sizeBytes,
			webViewLink: ref.webViewLink,
		};
	}

	return null;
}
