import { describe, it, expect } from 'vitest';
import {
	createStoredWebAudioFile,
	createStoredNativeAudioFile,
	createStoredDriveAudioFile,
	getStoredFileKey,
	getRelativePath,
	parseFilename,
	sortFiles as sortStoredFiles,
	type StoredAudioFile,
} from '$lib/models/music';

// ─────────────────────────────────────────────────────────────
// Extract the favorite-track logic from Mp3PlayerView into pure
// testable functions (same signatures & behaviour as the view).
// ─────────────────────────────────────────────────────────────

type FavoriteTrack = {
	key: string;
	name: string;
	title: string;
	artist: string;
	relativePath: string;
	source: 'web' | 'native' | 'drive';
	path?: string;
	fileId?: string;
	mimeType?: string;
	modifiedAt?: number;
	sizeBytes?: number;
	webViewLink?: string;
};

function createFavoriteTrack(file: StoredAudioFile): FavoriteTrack {
	const parsed = parseFilename(file.name);
	const baseFavorite = {
		key: getStoredFileKey(file),
		name: file.name,
		title: parsed.title,
		artist: parsed.artist,
		relativePath: getRelativePath(file),
		source: file.source,
	};

	if (file.source === 'native') {
		return {
			...baseFavorite,
			path: file.path,
			mimeType: file.mimeType,
			modifiedAt: file.modifiedAt,
		};
	}

	if (file.source === 'drive') {
		return {
			...baseFavorite,
			fileId: file.fileId,
			mimeType: file.mimeType,
			modifiedAt: file.modifiedAt,
			sizeBytes: file.sizeBytes,
			webViewLink: file.webViewLink,
		};
	}

	return baseFavorite;
}

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

function getResolvedFavoriteTrackFiles(
	favorites: FavoriteTrack[],
	allFiles: StoredAudioFile[],
	tracks: Array<{ source: StoredAudioFile }>,
): StoredAudioFile[] {
	const seen = new Set<string>();
	const files: StoredAudioFile[] = [];

	for (const favorite of favorites) {
		const file = resolveFavoriteTrackFile(favorite, allFiles, tracks);
		if (!file) continue;
		const key = getStoredFileKey(file);
		if (seen.has(key)) continue;
		seen.add(key);
		files.push(file);
	}

	return files;
}

/** Sort for deterministic test assertions — mirrors the view's sort order. */
function sortFiles(files: StoredAudioFile[], sortOrder: string): StoredAudioFile[] {
	return sortStoredFiles(files, sortOrder);
}

// ── helpers ──────────────────────────────────────────────────

const webFile = (name: string): StoredAudioFile =>
	createStoredWebAudioFile(new File([], name), name);

const nativeFile = (name: string, path?: string): StoredAudioFile =>
	createStoredNativeAudioFile({
		kind: 'file',
		name,
		relativePath: name,
		path: path ?? `/sdcard/Music/${name}`,
		mimeType: 'audio/mpeg',
		modifiedAt: Date.now(),
	});

const driveFile = (name: string, fileId?: string): StoredAudioFile =>
	createStoredDriveAudioFile({
		id: fileId ?? `drive-${name}`,
		name,
		mimeType: 'audio/mpeg',
		modifiedTime: new Date().toISOString(),
		size: '2048',
	});

// ─────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────

describe('createFavoriteTrack', () => {
	it('preserves key, name, title, artist, relativePath, source for web file', () => {
		const file = webFile('Artist - Song.mp3');
		const fav = createFavoriteTrack(file);
		expect(fav.source).toBe('web');
		expect(fav.key).toBe(getStoredFileKey(file));
		expect(fav.name).toBe('Artist - Song.mp3');
		expect(fav.title).toBe('Song');
		expect(fav.artist).toBe('Artist');
		expect(fav.relativePath).toBe('Artist - Song.mp3');
	});

	it('preserves native path and mimeType', () => {
		const file = nativeFile('track.mp3', '/sdcard/Music/track.mp3');
		const fav = createFavoriteTrack(file);
		expect(fav.source).toBe('native');
		expect(fav.path).toBe('/sdcard/Music/track.mp3');
		expect(fav.mimeType).toBe('audio/mpeg');
		expect(fav.modifiedAt).toBeDefined();
	});

	it('preserves drive fileId and extra fields', () => {
		const file = driveFile('drive-track.mp3', 'abc123');
		const fav = createFavoriteTrack(file);
		expect(fav.source).toBe('drive');
		expect(fav.fileId).toBe('abc123');
		expect(fav.sizeBytes).toBe(2048);
		expect(fav.webViewLink).toBeUndefined();
	});

	it('round-trips web file through favorite and back (when file is in allFiles)', () => {
		const file = webFile('Artist - Song.mp3');
		const fav = createFavoriteTrack(file);
		const resolved = resolveFavoriteTrackFile(fav, [file], []);
		expect(resolved).not.toBeNull();
		expect(getStoredFileKey(resolved!)).toBe(getStoredFileKey(file));
	});

	it('round-trips native file through favorite and back (when file is in allFiles)', () => {
		const file = nativeFile('track.mp3');
		const fav = createFavoriteTrack(file);
		const resolved = resolveFavoriteTrackFile(fav, [file], []);
		expect(resolved).not.toBeNull();
		expect((resolved! as { path?: string }).path).toBe('/sdcard/Music/track.mp3');
	});

	it('round-trips drive file through favorite and back (when file is in allFiles)', () => {
		const file = driveFile('drive-track.mp3', 'abc123');
		const fav = createFavoriteTrack(file);
		const resolved = resolveFavoriteTrackFile(fav, [file], []);
		expect(resolved).not.toBeNull();
		expect((resolved! as { fileId?: string }).fileId).toBe('abc123');
	});
});

describe('resolveFavoriteTrackFile', () => {
	it('resolves web favorite from allFiles', () => {
		const file = webFile('Song.mp3');
		const fav = createFavoriteTrack(file);
		const resolved = resolveFavoriteTrackFile(fav, [file], []);
		expect(resolved).toBe(file);
	});

	it('resolves web favorite from tracks when not in allFiles', () => {
		const file = webFile('Song.mp3');
		const fav = createFavoriteTrack(file);
		const track = { source: file };
		const resolved = resolveFavoriteTrackFile(fav, [], [track]);
		expect(resolved).toBe(file);
	});

	it('returns null for web favorite not in allFiles or tracks', () => {
		const file = webFile('Song.mp3');
		const fav = createFavoriteTrack(file);
		const resolved = resolveFavoriteTrackFile(fav, [], []);
		expect(resolved).toBeNull();
	});

	it('returns null for web favorite when current library is native and file is gone', () => {
		// Simulates: user added web file to favorites, switched to native library
		const webF = webFile('WebSong.mp3');
		const fav = createFavoriteTrack(webF);
		const nativeFiles = [nativeFile('NativeSong.mp3')];
		const resolved = resolveFavoriteTrackFile(fav, nativeFiles, []);
		expect(resolved).toBeNull();
	});

	it('synthesises native file from favorite metadata when not in memory', () => {
		const file = nativeFile('NativeSong.mp3');
		const fav = createFavoriteTrack(file);
		// Simulate: allFiles and tracks are empty (different library loaded)
		const resolved = resolveFavoriteTrackFile(fav, [], []);
		expect(resolved).not.toBeNull();
		expect(resolved!.source).toBe('native');
		expect((resolved! as { path?: string }).path).toBe('/sdcard/Music/NativeSong.mp3');
	});

	it('synthesises drive file from favorite metadata when not in memory', () => {
		const file = driveFile('DriveSong.mp3', 'd123');
		const fav = createFavoriteTrack(file);
		const resolved = resolveFavoriteTrackFile(fav, [], []);
		expect(resolved).not.toBeNull();
		expect(resolved!.source).toBe('drive');
		expect((resolved! as { fileId?: string }).fileId).toBe('d123');
	});

	it('returns null for native favorite with no path', () => {
		const fav: FavoriteTrack = {
			key: 'n:test',
			name: 'test.mp3',
			title: 'Test',
			artist: 'Artist',
			relativePath: 'test.mp3',
			source: 'native',
			// no path
		};
		const resolved = resolveFavoriteTrackFile(fav, [], []);
		expect(resolved).toBeNull();
	});

	it('returns null for drive favorite with no fileId', () => {
		const fav: FavoriteTrack = {
			key: 'd:test',
			name: 'test.mp3',
			title: 'Test',
			artist: 'Artist',
			relativePath: 'test.mp3',
			source: 'drive',
			// no fileId
		};
		const resolved = resolveFavoriteTrackFile(fav, [], []);
		expect(resolved).toBeNull();
	});
});

describe('getResolvedFavoriteTrackFiles', () => {
	it('returns empty array when no favorites', () => {
		const result = getResolvedFavoriteTrackFiles([], [], []);
		expect(result).toEqual([]);
	});

	it('returns empty array when no favorites can be resolved', () => {
		const favs: FavoriteTrack[] = [{
			key: 'w:missing',
			name: 'missing.mp3',
			title: 'Missing',
			artist: 'Nobody',
			relativePath: 'missing.mp3',
			source: 'web',
		}];
		const result = getResolvedFavoriteTrackFiles(favs, [], []);
		expect(result).toEqual([]);
	});

	it('returns resolved files from allFiles', () => {
		const file = webFile('Song.mp3');
		const fav = createFavoriteTrack(file);
		const result = getResolvedFavoriteTrackFiles([fav], [file], []);
		expect(result).toHaveLength(1);
		expect(result[0]).toBe(file);
	});

	it('deduplicates by key', () => {
		const file = nativeFile('dup.mp3');
		const fav = createFavoriteTrack(file);
		// Same favorite twice + file appears twice in allFiles
		const result = getResolvedFavoriteTrackFiles([fav, fav], [file, file], []);
		expect(result).toHaveLength(1);
	});

	it('resolves mixed sources', () => {
		const webF = webFile('web.mp3');
		const nativeF = nativeFile('native.mp3');
		const driveF = driveFile('drive.mp3', 'd1');

		const favs = [
			createFavoriteTrack(webF),
			createFavoriteTrack(nativeF),
			createFavoriteTrack(driveF),
		];

		const result = getResolvedFavoriteTrackFiles(favs, [webF, nativeF, driveF], []);
		expect(result).toHaveLength(3);
	});

	it('resolves native favorite even when not in current library (synthesised)', () => {
		const file = nativeFile('remote.mp3');
		const fav = createFavoriteTrack(file);
		// allFiles/tracks are from a different library
		const result = getResolvedFavoriteTrackFiles([fav], [nativeFile('other.mp3')], []);
		expect(result).toHaveLength(1);
		expect(result[0].source).toBe('native');
	});
});

describe('sortFiles with resolved favorites', () => {
	it('sorts mixed-source resolved favorites deterministically', () => {
		const files: StoredAudioFile[] = [
			nativeFile('B - zeta.mp3'),
			webFile('A - alpha.mp3'),
			driveFile('C - gamma.mp3', 'c1'),
		];

		// Verify they are all valid StoredAudioFile objects — sortFiles should not throw
		const sorted = sortFiles(files, 'name');
		expect(sorted).toHaveLength(3);
	});

	it('sortFiles can handle the resolved favorites array directly', () => {
		const files: StoredAudioFile[] = [
			webFile('Track 1.mp3'),
			webFile('Track 2.mp3'),
			nativeFile('Track 3.mp3'),
		];
		const favs = files.map(createFavoriteTrack);
		const resolved = getResolvedFavoriteTrackFiles(favs, files, []);
		expect(resolved).toHaveLength(3);
		// sortFiles should not throw on resolved favorites
		const sorted = sortFiles(resolved, 'name');
		expect(sorted).toHaveLength(3);
		expect(sorted.every((f) => typeof f.name === 'string')).toBe(true);
	});

	it('sortFiles does not mutate input', () => {
		const files: StoredAudioFile[] = [
			webFile('B.mp3'),
			webFile('A.mp3'),
		];
		const copy = [...files];
		const sorted = sortFiles(files, 'name');
		expect(sorted[0].name).toBe('A.mp3');
		// Original unchanged
		expect(files.map((f) => f.name)).toEqual(copy.map((f) => f.name));
	});
});

describe('playFavoriteTrack scenario — full resolution + sort + find-index', () => {
	it('finds the correct sorted position for a clicked favorite', () => {
		// Arrange: library with 3 files
		const songs: StoredAudioFile[] = [
			webFile('C - charlie.mp3'),
			webFile('A - alpha.mp3'),
			webFile('B - bravo.mp3'),
		];

		const favs = songs.map(createFavoriteTrack);
		// Save favorites to "state"
		const favorites = favs;
		const allFiles = songs;
		const tracks: Array<{ source: StoredAudioFile }> = [];

		// Act: "user clicks on B - bravo"
		const clicked = favorites[2]; // B - bravo

		// Step 1: resolve all favorites to files
		const files = getResolvedFavoriteTrackFiles(favorites, allFiles, tracks);
		expect(files.length).toBeGreaterThan(0);

		// Step 2: sort the resolved files (same as what loadTracks does internally
		// and what playFavoriteTrack does externally)
		const sortedFiles = sortFiles(files, 'name');

		// Step 3: find the clicked favorite's position in sortedFiles
		const nextIndex = sortedFiles.findIndex(
			(file) => getStoredFileKey(file) === clicked.key,
		);

		// Assert: index should be >= 0 (found) and point to the correct file
		expect(nextIndex).toBeGreaterThanOrEqual(0);
		expect(getStoredFileKey(sortedFiles[nextIndex])).toBe(clicked.key);
		// B - bravo should be between A - alpha and C - charlie in name sort
		expect(nextIndex).toBe(1);
	});

	it('handles synthetic resolved files (not in allFiles) correctly', () => {
		// User added native files from LibraryA to favorites, then switched to LibraryB.
		// The native files are synthesised from favorite metadata.
		const nativeSong = nativeFile('OldLibrarySong.mp3', '/old/song.mp3');
		const fav = createFavoriteTrack(nativeSong);

		// Current library has different files
		const currentLibraryFiles = [webFile('NewSong.mp3')];
		const favorites = [fav];
		const allFiles = currentLibraryFiles;
		const tracks: Array<{ source: StoredAudioFile }> = [];

		// Resolve — should synthesise the native file
		const files = getResolvedFavoriteTrackFiles(favorites, allFiles, tracks);
		expect(files).toHaveLength(1);

		// sortFiles should not throw with synthesised file
		const sortedFiles = sortFiles(files, 'name');
		expect(sortedFiles).toHaveLength(1);

		// Find index
		const nextIndex = sortedFiles.findIndex(
			(file) => getStoredFileKey(file) === fav.key,
		);
		expect(nextIndex).toBe(0);
	});

	it('handles the case where all favorites resolve to valid StoredAudioFile objects', () => {
		// This is the most critical path — playFavoriteTrack calls sortFiles and
		// findIndex on the resolved files. Every file must be a valid StoredAudioFile.
		const files: StoredAudioFile[] = [
			webFile('web1.mp3'),
			nativeFile('native1.mp3'),
			driveFile('drive1.mp3', 'd1'),
			// Synthesised native (no matching file in allFiles)
			{
				source: 'native',
				name: 'synth.mp3',
				relativePath: 'synth.mp3',
				path: '/remote/synth.mp3',
				mimeType: 'audio/mpeg',
				modifiedAt: Date.now(),
			},
		];

		const sorted = sortFiles(files, 'name');
		expect(sorted).toHaveLength(4);

		// Every file must have a valid key
		for (const file of sorted) {
			const key = getStoredFileKey(file);
			expect(typeof key).toBe('string');
			expect(key.length).toBeGreaterThan(0);
		}

		// findIndex should work for any of them
		for (const file of sorted) {
			const idx = sorted.findIndex(
				(f) => getStoredFileKey(f) === getStoredFileKey(file),
			);
			expect(idx).toBeGreaterThanOrEqual(0);
		}
	});
});

describe('bug confirmation: playFavoriteTrack with empty allFiles crashes', () => {
	it('should NOT crash when allFiles is empty but favorites exist from previous session', () => {
		// BUG SCENARIO: User has favorites from a previous session.
		// They open the app, haven't loaded a library yet (allFiles is empty).
		// They click the star button to see favorites, then click a favorite track.
		// The filteredFavoriteTracks derivation resolves favorites, and some
		// may appear as playable (resolved). When clicked, playFavoriteTrack
		// calls getResolvedFavoriteTrackFiles which should handle this gracefully.

		const nativeSong = nativeFile('FavoriteSong.mp3', '/music/FavoriteSong.mp3');
		const fav = createFavoriteTrack(nativeSong);
		const favorites = [fav];
		const allFiles: StoredAudioFile[] = []; // No library loaded!
		const tracks: Array<{ source: StoredAudioFile }> = [];

		// The derivation would resolve the favorite
		const resolved = resolveFavoriteTrackFile(fav, allFiles, tracks);
		// For native files with a path, it should synthesise
		expect(resolved).not.toBeNull();

		// Now simulate playFavoriteTrack's flow:
		// 1. getResolvedFavoriteTrackFiles
		const files = getResolvedFavoriteTrackFiles(favorites, allFiles, tracks);
		expect(files.length).toBeGreaterThan(0);

		// 2. sortFiles(files) — should NOT throw
		const sortedFiles = sortFiles(files, 'name');
		expect(sortedFiles.length).toBe(files.length);

		// 3. sortedFiles.findIndex — should find the favorite
		const nextIndex = sortedFiles.findIndex(
			(file) => getStoredFileKey(file) === fav.key,
		);
		expect(nextIndex).toBeGreaterThanOrEqual(0);

		// 4. Verify every file in the resolved array has valid structure
		for (const file of files) {
			expect(file.source).toBeDefined();
			expect(file.name).toBeDefined();
			expect(file.relativePath).toBeDefined();
		}
	});

	it('should NOT crash when playing a web favorite not found in current library', () => {
		// User added a web file to favorites in a previous session.
		// Now they have a native library loaded. The web file can't be resolved
		// because File objects don't survive page reloads.
		// The derivation would show file: null, and the button would be disabled.
		// But let's verify the logic handles this correctly.

		const webF = webFile('OldWebSong.mp3');
		const fav = createFavoriteTrack(webF);
		const favorites = [fav];
		const nativeLib = [nativeFile('NewNativeSong.mp3')];
		const tracks: Array<{ source: StoredAudioFile }> = [];

		const resolved = resolveFavoriteTrackFile(fav, nativeLib, tracks);
		expect(resolved).toBeNull();

		const files = getResolvedFavoriteTrackFiles(favorites, nativeLib, tracks);
		expect(files).toHaveLength(0);
	});

	it('regression: playFavoriteTrack calls sortFiles twice with same files array', () => {
		// In playFavoriteTrack, sortFiles(files) is called AFTER loadTracks
		// internally already called sortFiles(files).
		// sortFiles creates a new array each time (non-mutating), so calling
		// it twice on the same input should produce the same result.

		const resolved = getResolvedFavoriteTrackFiles(
			[
				createFavoriteTrack(webFile('B.mp3')),
				createFavoriteTrack(webFile('A.mp3')),
			],
			[webFile('B.mp3'), webFile('A.mp3')],
			[],
		);

		// First sort (as loadTracks would do)
		const sorted1 = sortFiles(resolved, 'name');
		// Second sort (as playFavoriteTrack would do)
		const sorted2 = sortFiles(resolved, 'name');

		// Both should produce the same order
		expect(sorted1.map((f) => f.name)).toEqual(sorted2.map((f) => f.name));
		// Input should not have been mutated
		expect(resolved.map((f) => f.name)).not.toEqual(sorted1.map((f) => f.name));
	});

	it('CRASH SCENARIO: resolved favorite files contain a file with undefined name', () => {
		// If somehow a StoredAudioFile gets into the resolved array with
		// an undefined name, sortFiles would crash on parseFilename(f.name).
		// Let's ensure the resolution functions always produce valid objects.

		const fav: FavoriteTrack = {
			key: 'n:broken',
			name: 'Broken.mp3',
			title: 'Broken',
			artist: 'Artist',
			relativePath: 'Broken.mp3',
			source: 'native',
			path: '/broken/Broken.mp3',
		};

		const resolved = resolveFavoriteTrackFile(fav, [], []);
		expect(resolved).not.toBeNull();
		expect(resolved!.name).toBe('Broken.mp3');
		expect(resolved!.relativePath).toBe('Broken.mp3');

		// sortFiles should handle this without throwing
		const sorted = sortFiles([resolved!], 'name');
		expect(sorted).toHaveLength(1);
	});

	it('CRASH SCENARIO: getStoredFileKey accesses undefined relativePath', () => {
		// getStoredFileKey uses source.relativePath. If relativePath is undefined,
		// the key would be "w:undefined" or "n:undefined", which could cause
		// key mismatches and findIndex returning -1.

		// Create a favorite track from a file with explicit relativePath
		const file = nativeFile('song.mp3', '/path/song.mp3');
		expect(file.relativePath).toBeDefined();

		const fav = createFavoriteTrack(file);
		expect(fav.relativePath).toBeDefined();
		expect(fav.key).toContain(fav.relativePath);

		// Resolve and verify keys are consistent
		const resolved = resolveFavoriteTrackFile(fav, [file], []);
		expect(resolved).not.toBeNull();
		expect(getStoredFileKey(resolved!)).toBe(fav.key);
	});
});
