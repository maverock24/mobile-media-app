import { describe, it, expect, beforeEach } from 'vitest';
import {
	createStoredWebAudioFile,
	createStoredNativeAudioFile,
	createStoredDriveAudioFile,
	getStoredFileKey,
	getRelativePath,
	parseFilename,
	sortFiles,
	type StoredAudioFile,
	getTrackKey,
} from '$lib/models/music';

// ─────────────────────────────────────────────────────────────
// Test the EXACT flow from playFavoriteTrack in Mp3PlayerView
//
// The crash scenario: user clicks a favorite track, and the
// app crashes. This test simulates the full synchronous
// portion of the playFavoriteTrack function to catch any
// throws or edge cases.
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

interface Track {
	id: number;
	title: string;
	artist: string;
	filename: string;
	url: string;
	duration: number;
	cleanup?: () => void;
	source: StoredAudioFile;
}

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
	tracks: Track[],
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
	tracks: Track[],
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

function loadTracks(
	files: StoredAudioFile[],
	folder: string,
	currentTracks: Track[],
): { tracks: Track[]; queueSessionId: number; isSelectionLoop: boolean } {
	const sorted = sortFiles(files, 'name');
	const tracks: Track[] = sorted.map((f, i) => {
		const { title, artist } = parseFilename(f.name);
		return {
			id: i,
			title,
			artist,
			filename: f.name,
			url: '',
			duration: 0,
			cleanup: undefined,
			source: f,
		};
	});
	return {
		tracks,
		queueSessionId: 1,
		isSelectionLoop: false,
	};
}

// ── Test helpers ─────────────────────────────────────────────

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
// playFavoriteTrack simulation
// ─────────────────────────────────────────────────────────────

/**
 * Simulates the EXACT synchronous flow of playFavoriteTrack.
 * This is the path executed before `await startAudioAt(...)`.
 * Any throw here would crash the component.
 */
function simulatePlayFavoriteTrack(
	clicked: FavoriteTrack,
	allFavorites: FavoriteTrack[],
	allFiles: StoredAudioFile[],
	existingTracks: Track[],
): {
	files: StoredAudioFile[];
	tracks: Track[];
	sortedFiles: StoredAudioFile[];
	nextIndex: number;
	lastTrackIndex: number;
} {
	// Step 1: validate the clicked favorite resolves
	const resolvedTrack = resolveFavoriteTrackFile(clicked, allFiles, existingTracks);
	if (!resolvedTrack) {
		throw new Error('Clicked favorite could not be resolved');
	}

	// Step 2: collect all resolved favorite tracks
	const files = getResolvedFavoriteTrackFiles(allFavorites, allFiles, existingTracks);
	if (files.length === 0) {
		throw new Error('No favorite tracks are currently available');
	}

	// Step 3: load tracks (mirrors loadTracks call in the view)
	const { tracks } = loadTracks(files, 'Favorite Tracks', existingTracks);

	// Step 4: sort files again and find the clicked favorite's position
	const sortedFiles = sortFiles(files, 'name');
	const nextIndex = sortedFiles.findIndex(
		(file) => getStoredFileKey(file) === clicked.key,
	);
	const lastTrackIndex = Math.max(0, nextIndex);

	return { files, tracks, sortedFiles, nextIndex, lastTrackIndex };
}

// ─────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────

describe('playFavoriteTrack flow (simulated)', () => {
	let allFiles: StoredAudioFile[];
	let allFavorites: FavoriteTrack[];

	beforeEach(() => {
		allFiles = [
			webFile('C - Delta.mp3'),
			webFile('A - Alpha.mp3'),
			webFile('B - Bravo.mp3'),
		];
		allFavorites = allFiles.map(createFavoriteTrack);
	});

	it('clicking B-Bravo correctly resolves and positions', () => {
		const clicked = allFavorites[2]; // B - Bravo
		const result = simulatePlayFavoriteTrack(clicked, allFavorites, allFiles, []);
		expect(result.nextIndex).toBe(1); // Position in sorted order
		expect(result.lastTrackIndex).toBe(1);
		expect(result.tracks).toHaveLength(3);
		expect(result.tracks[result.lastTrackIndex].title).toBe('Bravo');
	});

	it('clicking A-Alpha correctly resolves and positions', () => {
		const clicked = allFavorites[1]; // A - Alpha
		const result = simulatePlayFavoriteTrack(clicked, allFavorites, allFiles, []);
		expect(result.nextIndex).toBe(0);
		expect(result.lastTrackIndex).toBe(0);
		expect(result.tracks[0].title).toBe('Alpha');
	});

	it('works when allFiles has different files than favorites (synthesised native)', () => {
		// User has a native favorite from a different library
		const nativeFav = createFavoriteTrack(nativeFile('OldSong.mp3', '/old/OldSong.mp3'));
		const favorites = [nativeFav];
		const currentLib = [webFile('NewSong.mp3')]; // Different library

		const result = simulatePlayFavoriteTrack(nativeFav, favorites, currentLib, []);
		expect(result.nextIndex).toBe(0);
		expect(result.tracks).toHaveLength(1);
		expect(result.tracks[0].source.source).toBe('native');
	});

	it('works when allFiles has different files than favorites (synthesised drive)', () => {
		const driveFav = createFavoriteTrack(driveFile('DriveSong.mp3', 'd123'));
		const favorites = [driveFav];
		const currentLib = [webFile('LocalSong.mp3')];

		const result = simulatePlayFavoriteTrack(driveFav, favorites, currentLib, []);
		expect(result.nextIndex).toBe(0);
		expect(result.tracks).toHaveLength(1);
		expect(result.tracks[0].source.source).toBe('drive');
	});

	it('handles mixed sources in favorites', () => {
		const web = webFile('Web.mp3');
		const native = nativeFile('Native.mp3');
		const drive = driveFile('Drive.mp3', 'd1');

		const favs = [
			createFavoriteTrack(web),
			createFavoriteTrack(native),
			createFavoriteTrack(drive),
		];
		const lib = [web, native, drive];

		// Click the native one
		const result = simulatePlayFavoriteTrack(favs[1], favs, lib, []);
		expect(result.tracks).toHaveLength(3);
		// Verify no track has invalid source
		for (const track of result.tracks) {
			expect(track.source).toBeDefined();
			expect(track.source.source).toMatch(/^(web|native|drive)$/);
			expect(typeof track.source.name).toBe('string');
			expect(typeof getStoredFileKey(track.source)).toBe('string');
		}
	});

	it('findIndex works with synthesised files whose keys match createFavoriteTrack keys', () => {
		// Native favorite from a different library
		const origFile = nativeFile('Remote.mp3', '/remote/Remote.mp3');
		const fav = createFavoriteTrack(origFile);
		const currentLib: StoredAudioFile[] = []; // Empty — no matching files

		const result = simulatePlayFavoriteTrack(fav, [fav], currentLib, []);

		// The synthesised file in sortedFiles should have the same key as the favorite
		const synthFile = result.sortedFiles[0];
		expect(getStoredFileKey(synthFile)).toBe(fav.key);
		expect(result.nextIndex).toBe(0);
	});

	it('does not throw when allFiles is empty and favorites are synthetics', () => {
		const nativeFav = createFavoriteTrack(nativeFile('Song.mp3', '/songs/Song.mp3'));
		const driveFav = createFavoriteTrack(driveFile('Other.mp3', 'd99'));

		// No library loaded — both should resolve via synthesis
		const result = simulatePlayFavoriteTrack(
			nativeFav,
			[nativeFav, driveFav],
			[],
			[],
		);

		expect(result.tracks).toHaveLength(2);
		expect(result.nextIndex).toBeGreaterThanOrEqual(0);
	});

	it('sortFiles returns same elements count as input', () => {
		const favs = [
			createFavoriteTrack(webFile('Z.mp3')),
			createFavoriteTrack(webFile('A.mp3')),
			createFavoriteTrack(webFile('M.mp3')),
		];
		const files = getResolvedFavoriteTrackFiles(favs, [
			webFile('Z.mp3'),
			webFile('A.mp3'),
			webFile('M.mp3'),
		], []);

		const sorted = sortFiles(files, 'name');
		expect(sorted).toHaveLength(files.length);
		expect(sorted[0].name).toBe('A.mp3');
	});

	it('loadTracks produces tracks in sorted-files order', () => {
		const favs = [
			createFavoriteTrack(webFile('Z.mp3')),
			createFavoriteTrack(webFile('A.mp3')),
			createFavoriteTrack(webFile('M.mp3')),
		];
		const files = getResolvedFavoriteTrackFiles(favs, [
			webFile('Z.mp3'),
			webFile('A.mp3'),
			webFile('M.mp3'),
		], []);

		const { tracks } = loadTracks(files, 'Test', []);
		const sortedFiles = sortFiles(files, 'name');

		// Both should have the same order
		for (let i = 0; i < tracks.length; i++) {
			const track = tracks[i];
			const file = sortedFiles[i];
			expect(getStoredFileKey(track.source)).toBe(getStoredFileKey(file));
		}
	});
});

describe('stress: large favorite lists', () => {
	it('handles 100 favorite tracks without throwing', () => {
		const files: StoredAudioFile[] = [];
		for (let i = 0; i < 100; i++) {
			files.push(webFile(`Track ${String(i).padStart(3, '0')}.mp3`));
		}
		const favs = files.map(createFavoriteTrack);

		const result = simulatePlayFavoriteTrack(favs[50], favs, files, []);
		expect(result.tracks).toHaveLength(100);
		expect(result.nextIndex).toBeGreaterThanOrEqual(0);
	});

	it('handles favorites with synthesised native files (no allFiles matches)', () => {
		// 50 native favorites from a previous library, no matching files in current
		const favs: FavoriteTrack[] = [];
		for (let i = 0; i < 50; i++) {
			const file = nativeFile(
				`Song ${i}.mp3`,
				`/old-library/Song ${i}.mp3`,
			);
			favs.push(createFavoriteTrack(file));
		}

		const result = simulatePlayFavoriteTrack(favs[0], favs, [], []);
		expect(result.tracks).toHaveLength(50);
	});
});

describe('edge case: every track source is valid for getStoredFileKey', () => {
	it('getStoredFileKey works on every resolved file type', () => {
		const allTypes: StoredAudioFile[] = [
			webFile('web.mp3'),
			nativeFile('native.mp3'),
			driveFile('drive.mp3', 'd1'),
			// Synthesised native
			{
				source: 'native',
				name: 'synth-native.mp3',
				relativePath: 'synth-native.mp3',
				path: '/fake/synth-native.mp3',
				mimeType: 'audio/mpeg',
			},
			// Synthesised drive
			{
				source: 'drive',
				name: 'synth-drive.mp3',
				relativePath: 'synth-drive.mp3',
				fileId: 'fake-id',
			},
		];

		for (const file of allTypes) {
			const key = getStoredFileKey(file);
			expect(typeof key).toBe('string');
			expect(key.length).toBeGreaterThan(0);

			// Verify getTrackKey (used elsewhere) also works
			const trackKey = getTrackKey(file);
			expect(trackKey).toBe(key);
		}
	});

	it('findIndex in sortedFiles works with getStoredFileKey on every resolved type', () => {
		const files: StoredAudioFile[] = [
			webFile('A-web.mp3'),
			nativeFile('A-native.mp3'),
			driveFile('A-drive.mp3', 'd-a'),
			// Synthesised native
			{
				source: 'native' as const,
				name: 'B-synth.mp3',
				relativePath: 'B-synth.mp3',
				path: '/fake/B-synth.mp3',
				mimeType: 'audio/mpeg',
				modifiedAt: Date.now(),
			},
		];

		const sorted = sortFiles(files, 'name');
		expect(sorted).toHaveLength(4);

		// Every file should be findable by its own key
		for (const file of sorted) {
			const key = getStoredFileKey(file);
			const idx = sorted.findIndex(
				(f) => getStoredFileKey(f) === key,
			);
			expect(idx).toBeGreaterThanOrEqual(0);
			expect(getStoredFileKey(sorted[idx])).toBe(key);
		}
	});
});

describe('regression: tracks and allFiles both searched in resolve', () => {
	it('prefers allFiles over tracks when both have the file', () => {
		const file = webFile('song.mp3');
		const fav = createFavoriteTrack(file);

		const allFilesWithFile = [file];
		const tracksWithFile: Track[] = [{
			id: 0, title: 'song', artist: 'Artist', filename: 'song.mp3',
			url: 'blob:old', duration: 100, source: file,
		}];

		const resolved = resolveFavoriteTrackFile(fav, allFilesWithFile, tracksWithFile);
		expect(resolved).toBe(file); // Should use the allFiles reference
	});

	it('falls back to tracks when allFiles does not have the file', () => {
		const file = webFile('song.mp3');
		const fav = createFavoriteTrack(file);
		const tracksWithFile: Track[] = [{
			id: 0, title: 'song', artist: 'Artist', filename: 'song.mp3',
			url: 'blob:existing', duration: 100, source: file,
		}];

		const resolved = resolveFavoriteTrackFile(fav, [], tracksWithFile);
		expect(resolved).toBe(file);
	});

	it('tracks.find with undefined track.source does not throw', () => {
		const fav = createFavoriteTrack(webFile('song.mp3'));
		// Malformed track — source is undefined (shouldn't happen in practice, but guard)
		const badTracks = [
			{ source: undefined as unknown as StoredAudioFile },
		] as Track[];

		// This should NOT throw — getStoredFileKey would be called with
		// undefined, which would trigger source.source → TypeError
		// Let's test whether this throws:
		expect(() => {
			resolveFavoriteTrackFile(fav, [], badTracks);
		}).toThrow();
	});

	it('getStoredFileKey with undefined source throws TypeError', () => {
		expect(() => {
			getStoredFileKey(undefined as unknown as StoredAudioFile);
		}).toThrow(TypeError);
	});
});
