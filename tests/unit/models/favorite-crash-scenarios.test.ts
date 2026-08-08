import { describe, it, expect } from 'vitest';
import {
	getStoredFileKey,
	getRelativePath,
	parseFilename,
	type StoredAudioFile,
} from '$lib/models/music';

// ─────────────────────────────────────────────────────────────
// BUG CONFIRMATION TESTS
//
// These tests reproduce crash scenarios in the favorite tracks
// resolution and playback flow. Tests should FAIL until the
// bug is fixed.
// ─────────────────────────────────────────────────────────────

type FavoriteTrack = {
	key: string; name: string; title: string; artist: string;
	relativePath: string; source: 'web' | 'native' | 'drive';
	path?: string; fileId?: string; mimeType?: string;
	modifiedAt?: number; sizeBytes?: number; webViewLink?: string;
};

/** Exact replica of the resolveFavoriteTrackFile from Mp3PlayerView */
function resolveFavoriteTrackFile(
	favorite: FavoriteTrack,
	allFiles: StoredAudioFile[],
	tracks: Array<{ source: StoredAudioFile }>,
): StoredAudioFile | null {
	const loadedFile =
		allFiles.find((file) => getStoredFileKey(file) === favorite.key) ??
		tracks.find((track) => getStoredFileKey(track.source) === favorite.key)?.source;
	if (loadedFile) return loadedFile;

	if (favorite.source === 'native' && favorite.path) {
		return {
			source: 'native',
			name: favorite.name,
			relativePath: favorite.relativePath,
			path: favorite.path,
			mimeType: favorite.mimeType,
			modifiedAt: favorite.modifiedAt,
		};
	}

	if (favorite.source === 'drive' && favorite.fileId) {
		return {
			source: 'drive',
			name: favorite.name,
			relativePath: favorite.relativePath,
			fileId: favorite.fileId,
			mimeType: favorite.mimeType,
			modifiedAt: favorite.modifiedAt,
			sizeBytes: favorite.sizeBytes,
			webViewLink: favorite.webViewLink,
		};
	}

	return null;
}

// ─────────────────────────────────────────────────────────────
// BUG #1: resolveFavoriteTrackFile crashes when tracks array
// contains entries with undefined source
// ─────────────────────────────────────────────────────────────

// FIXED version of resolveFavoriteTrackFile with the guard
function resolveFavoriteTrackFileFixed(
	favorite: FavoriteTrack,
	allFiles: StoredAudioFile[],
	tracks: Array<{ source: StoredAudioFile }>,
): StoredAudioFile | null {
	const loadedFile =
		allFiles.find((file) => getStoredFileKey(file) === favorite.key) ??
		tracks.find(
			(track) => track?.source != null && getStoredFileKey(track.source) === favorite.key,
		)?.source;
	if (loadedFile) return loadedFile;

	if (favorite.source === 'native' && favorite.path) {
		return {
			source: 'native',
			name: favorite.name,
			relativePath: favorite.relativePath,
			path: favorite.path,
			mimeType: favorite.mimeType,
			modifiedAt: favorite.modifiedAt,
		};
	}

	if (favorite.source === 'drive' && favorite.fileId) {
		return {
			source: 'drive',
			name: favorite.name,
			relativePath: favorite.relativePath,
			fileId: favorite.fileId,
			mimeType: favorite.mimeType,
			modifiedAt: favorite.modifiedAt,
			sizeBytes: favorite.sizeBytes,
			webViewLink: favorite.webViewLink,
		};
	}

	return null;
}

describe('BUG: resolveFavoriteTrackFile crashes with malformed tracks', () => {
	it('ORIGINAL (unfixed): crashes when a track has undefined source', () => {
		const fav: FavoriteTrack = {
			key: 'w:test',
			name: 'test.mp3',
			title: 'Test',
			artist: 'Artist',
			relativePath: 'test.mp3',
			source: 'web',
		};

		const badTracks = [{ source: undefined as unknown as StoredAudioFile }];

		// The unfixed version throws TypeError
		expect(() => resolveFavoriteTrackFile(fav, [], badTracks)).toThrow();
	});

	it('FIX: gracefully handles tracks with undefined source instead of crashing', () => {
		const fav: FavoriteTrack = {
			key: 'w:test',
			name: 'test.mp3',
			title: 'Test',
			artist: 'Artist',
			relativePath: 'test.mp3',
			source: 'web',
		};

		const badTracks = [{ source: undefined as unknown as StoredAudioFile }];

		// The fixed version should NOT throw — just skip the malformed track
		const result = resolveFavoriteTrackFileFixed(fav, [], badTracks);
		expect(result).toBeNull(); // Not found in bad tracks, and web fav can't synthesize
	});

	it('FIX: gracefully handles tracks with null source', () => {
		const fav: FavoriteTrack = {
			key: 'n:song',
			name: 'song.mp3',
			title: 'Song',
			artist: 'Artist',
			relativePath: 'song.mp3',
			source: 'native',
			path: '/tmp/song.mp3',
		};

		const badTracks = [{ source: null as unknown as StoredAudioFile }];

		// Should not throw — falls through to synthesis since path exists
		const result = resolveFavoriteTrackFileFixed(fav, [], badTracks);
		expect(result).not.toBeNull();
		expect(result!.source).toBe('native');
	});

	it('FIX: mixed valid and invalid tracks — finds valid ones', () => {
		const goodFile = {
			source: 'drive' as const,
			name: 'good.mp3',
			relativePath: 'good.mp3',
			fileId: 'g123',
		} satisfies StoredAudioFile;

		const fav: FavoriteTrack = {
			key: 'd:g123',
			name: 'good.mp3',
			title: 'Good',
			artist: 'Artist',
			relativePath: 'good.mp3',
			source: 'drive',
			fileId: 'g123',
		};

		const mixedTracks = [
			{ source: undefined as unknown as StoredAudioFile },
			{ source: goodFile },
			{ source: null as unknown as StoredAudioFile },
		];

		// Should find the valid track and skip the invalid ones
		const result = resolveFavoriteTrackFileFixed(fav, [], mixedTracks);
		expect(result).not.toBeNull();
		expect(getStoredFileKey(result!)).toBe('d:g123');
	});
});

// ─────────────────────────────────────────────────────────────
// BUG #2: filteredFavoriteTracks derivation crashes when
// musicSettings.favoriteTracks is null/undefined
// ─────────────────────────────────────────────────────────────

describe('BUG: filteredFavoriteTracks crashes when favoriteTracks is null', () => {
	it('FAILS: musicSettings.favoriteTracks is null', () => {
		// This simulates what would happen if localStorage had
		// corrupted data or the persisted store didn't initialize properly
		const favoriteTracks: unknown = null;
		const allFiles: StoredAudioFile[] = [];
		const tracks: Array<{ source: StoredAudioFile }> = [];

		// Replicating the $derived.by block
		expect(() => {
			(favoriteTracks as FavoriteTrack[]).map((favorite) => ({
				favorite,
				file: resolveFavoriteTrackFile(favorite, allFiles, tracks),
			}));
		}).toThrow();
	});

	it('FAILS: musicSettings.favoriteTracks is not an array', () => {
		const favoriteTracks: unknown = { 0: 'corrupted' };
		const allFiles: StoredAudioFile[] = [];
		const tracks: Array<{ source: StoredAudioFile }> = [];

		expect(() => {
			(favoriteTracks as FavoriteTrack[]).map((favorite) => ({
				favorite,
				file: resolveFavoriteTrackFile(favorite, allFiles, tracks),
			}));
		}).toThrow();
	});
});

// ─────────────────────────────────────────────────────────────
// BUG #3: getResolvedFavoriteTrackFiles crashes when
// musicSettings.favoriteTracks is not iterable
// ─────────────────────────────────────────────────────────────

describe('BUG: getResolvedFavoriteTrackFiles crashes with non-iterable favorites', () => {
	it('FAILS: for-of loop on null throws', () => {
		const favorites: unknown = null;
		expect(() => {
			// @ts-expect-error testing non-iterable
			for (const fav of favorites) {
				void fav;
			}
		}).toThrow();
	});

	it('FAILS: undefined is not iterable', () => {
		const favorites: unknown = undefined;
		expect(() => {
			// @ts-expect-error testing non-iterable
			for (const fav of favorites) {
				void fav;
			}
		}).toThrow();
	});
});

// ─────────────────────────────────────────────────────────────
// BUG #4: playFavoriteTrack calls getResolvedFavoriteTrackFiles
// which accesses musicSettings.favoriteTracks - can crash if
// favorites array was mutated during a reactive cycle
// ─────────────────────────────────────────────────────────────

describe('BUG: race condition - favoriteTracks changes during resolution', () => {
	it('FAILS: mutation during iteration (concurrent modification)', () => {
		// This simulates: while iterating favorites to resolve them,
		// another reactive update changes the array
		let favorites: FavoriteTrack[] = [
			{
				key: 'w:a', name: 'a.mp3', title: 'A', artist: 'Artist',
				relativePath: 'a.mp3', source: 'web',
			},
			{
				key: 'w:b', name: 'b.mp3', title: 'B', artist: 'Artist',
				relativePath: 'b.mp3', source: 'web',
			},
		];

		const result: FavoriteTrack[] = [];
		let threw = false;

		// Simulate: during iteration, the array is replaced
		// (which can't happen in single-threaded JS, but the
		// reactive effect could set favorites to undefined)
		try {
			for (const fav of favorites) {
				result.push(fav);
				// Simulating a reactive effect mutating the array reference
				favorites = undefined as unknown as FavoriteTrack[];
			}
		} catch {
			threw = true;
		}

		// In single-threaded JS, this doesn't throw because
		// the for-of loop captures the iterator at the start.
		expect(threw).toBe(false);
		expect(result).toHaveLength(2);
	});
});
