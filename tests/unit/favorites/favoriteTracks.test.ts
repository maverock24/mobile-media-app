import { describe, it, expect, vi, beforeEach } from 'vitest';

// The module under test is fully dependency-injected: it imports only pure
// helpers from `$lib/models/music` and two type-only modules. So the "stores"
// it would otherwise reach (the favourites list, the toast sink and the
// YouTube panel) and every playback callback arrive as fakes below. There is
// no runtime store mock and no new dependency.
import {
	createFavoriteTracks,
	type FavoriteTracks,
	type FavoriteTracksOptions,
	type FavoriteTracksStore,
	type FavoriteTracksView,
} from '$lib/favorites/favoriteTracks';
import type { FavoriteTrack, StoredAudioFile } from '$lib/models/music';

// ── helpers ──────────────────────────────────────────────────

const web = (name = 'song.mp3', relativePath = name): StoredAudioFile => ({
	source: 'web', name, relativePath, file: new File([], name),
});

const native = (name = 'song.mp3', relativePath = name): StoredAudioFile => ({
	source: 'native', name, relativePath, path: `/store/${relativePath}`,
	mimeType: 'audio/mpeg', modifiedAt: 5,
});

const drive = (name = 'song.mp3', relativePath = name): StoredAudioFile => ({
	source: 'drive', name, relativePath, fileId: `id:${name}`,
	mimeType: 'audio/mpeg', modifiedAt: 7, sizeBytes: 9, webViewLink: 'link',
});

const youtubeFavorite = (videoId = 'vid1'): FavoriteTrack => ({
	key: `youtube:${videoId}`, name: videoId, title: videoId, artist: 'YouTube',
	source: 'youtube', videoId,
});

/** An inert view; tests override the fields they drive. */
function makeView(overrides: Partial<FavoriteTracksView> = {}): FavoriteTracksView {
	return { allFiles: [], tracks: [], isChangingTrack: false, ...overrides };
}

/** A fresh machine wired to inert fakes unless a test overrides them. */
function makeFavorites(overrides: Partial<FavoriteTracksOptions> = {}) {
	const view = overrides.view ?? makeView();
	const settings: FavoriteTracksStore = { favoriteTracks: [] };
	const initAudioContext = vi.fn();
	const beginQueue = vi.fn();
	const startPlayback = vi.fn().mockResolvedValue(true);
	const openYoutubePanel = vi.fn();
	const addToast = vi.fn();

	const favoriteTracks: FavoriteTracks = createFavoriteTracks({
		view, settings, initAudioContext, beginQueue, startPlayback, openYoutubePanel, addToast,
		...overrides,
	});

	return { favoriteTracks, view, settings, initAudioContext, beginQueue, startPlayback, openYoutubePanel, addToast };
}

beforeEach(() => {
	vi.clearAllMocks();
});

// ─────────────────────────────────────────────────────────────
// createFavoriteTrack — one branch per file source
// ─────────────────────────────────────────────────────────────

describe('createFavoriteTrack', () => {
	it('parses the filename and stores a web favourite without a file handle', () => {
		const { favoriteTracks } = makeFavorites();

		const favorite = favoriteTracks.createFavoriteTrack(web('A - B.mp3', 'Albums/A - B.mp3'));

		expect(favorite).toEqual({
			key: 'w:Albums/A - B.mp3', name: 'A - B.mp3', title: 'B', artist: 'A',
			relativePath: 'Albums/A - B.mp3', source: 'web',
		});
	});

	it('carries the native path, mime type and mtime', () => {
		const { favoriteTracks } = makeFavorites();

		const favorite = favoriteTracks.createFavoriteTrack(native('B.mp3', 'Albums/B.mp3'));

		expect(favorite).toEqual({
			key: 'n:Albums/B.mp3', name: 'B.mp3', title: 'B', artist: 'Unknown Artist',
			relativePath: 'Albums/B.mp3', source: 'native',
			path: '/store/Albums/B.mp3', mimeType: 'audio/mpeg', modifiedAt: 5,
		});
	});

	it('carries the Drive file id, size and link', () => {
		const { favoriteTracks } = makeFavorites();

		const favorite = favoriteTracks.createFavoriteTrack(drive('C.mp3', 'Albums/C.mp3'));

		expect(favorite).toEqual({
			key: 'd:id:C.mp3', name: 'C.mp3', title: 'C', artist: 'Unknown Artist',
			relativePath: 'Albums/C.mp3', source: 'drive',
			fileId: 'id:C.mp3', mimeType: 'audio/mpeg', modifiedAt: 7, sizeBytes: 9, webViewLink: 'link',
		});
	});
});

// ─────────────────────────────────────────────────────────────
// resolveFavoriteTrackFile — hit and miss
// ─────────────────────────────────────────────────────────────

describe('resolveFavoriteTrackFile', () => {
	it('returns the loaded library file by key (hit)', () => {
		const loaded = native('A.mp3');
		const { favoriteTracks } = makeFavorites({ view: { allFiles: [loaded], tracks: [], isChangingTrack: false } });

		expect(favoriteTracks.resolveFavoriteTrackFile(favoriteTracks.createFavoriteTrack(loaded))).toBe(loaded);
	});

	it('falls back to the live queue when the file left the library index', () => {
		const queued = drive('Q.mp3');
		const { favoriteTracks } = makeFavorites({ view: { allFiles: [], tracks: [{ source: queued }], isChangingTrack: false } });

		expect(favoriteTracks.resolveFavoriteTrackFile(favoriteTracks.createFavoriteTrack(queued))).toBe(queued);
	});

	it('reconstructs a native favourite from its stored metadata', () => {
		const { favoriteTracks } = makeFavorites();

		expect(favoriteTracks.resolveFavoriteTrackFile(favoriteTracks.createFavoriteTrack(native('N.mp3', 'N.mp3'))))
			.toEqual(native('N.mp3', 'N.mp3'));
	});

	it('reconstructs a drive favourite from its stored metadata', () => {
		const { favoriteTracks } = makeFavorites();

		expect(favoriteTracks.resolveFavoriteTrackFile(favoriteTracks.createFavoriteTrack(drive('D.mp3'))))
			.toEqual(drive('D.mp3'));
	});

	it('returns null for a web favourite that is not loaded (miss)', () => {
		const { favoriteTracks } = makeFavorites();

		expect(favoriteTracks.resolveFavoriteTrackFile(favoriteTracks.createFavoriteTrack(web('gone.mp3')))).toBeNull();
	});
});

// ─────────────────────────────────────────────────────────────
// isFavoriteTrack
// ─────────────────────────────────────────────────────────────

describe('isFavoriteTrack', () => {
	it('matches by stored key', () => {
		const file = native('A.mp3');
		const { favoriteTracks, settings } = makeFavorites();
		settings.favoriteTracks = [favoriteTracks.createFavoriteTrack(file)];

		expect(favoriteTracks.isFavoriteTrack(file)).toBe(true);
		expect(favoriteTracks.isFavoriteTrack(native('other.mp3'))).toBe(false);
	});

	it('returns false for corrupt persisted data (non-array guard)', () => {
		const { favoriteTracks, settings } = makeFavorites();
		(settings as { favoriteTracks: unknown }).favoriteTracks = 'broken';

		expect(favoriteTracks.isFavoriteTrack(native('A.mp3'))).toBe(false);
	});
});

// ─────────────────────────────────────────────────────────────
// toggleFavoriteTrack — add then remove
// ─────────────────────────────────────────────────────────────

describe('toggleFavoriteTrack', () => {
	it('appends the favourite when the key is absent', () => {
		const file = native('A.mp3');
		const { favoriteTracks, settings } = makeFavorites();

		favoriteTracks.toggleFavoriteTrack(file);

		expect(settings.favoriteTracks).toEqual([favoriteTracks.createFavoriteTrack(file)]);
	});

	it('removes by key when it is already present', () => {
		const keep = native('keep.mp3');
		const drop = native('drop.mp3');
		const { favoriteTracks, settings } = makeFavorites();
		settings.favoriteTracks = [favoriteTracks.createFavoriteTrack(keep), favoriteTracks.createFavoriteTrack(drop)];

		favoriteTracks.toggleFavoriteTrack(drop);

		expect(settings.favoriteTracks).toEqual([favoriteTracks.createFavoriteTrack(keep)]);
	});

	it('adds onto an empty list when the persisted value is not an array', () => {
		const file = native('A.mp3');
		const { favoriteTracks, settings } = makeFavorites();
		(settings as { favoriteTracks: unknown }).favoriteTracks = null;

		favoriteTracks.toggleFavoriteTrack(file);

		expect(settings.favoriteTracks).toEqual([favoriteTracks.createFavoriteTrack(file)]);
	});
});

// ─────────────────────────────────────────────────────────────
// removeFavoriteTrack
// ─────────────────────────────────────────────────────────────

describe('removeFavoriteTrack', () => {
	it('drops the matching key and keeps the rest', () => {
		const keep = native('keep.mp3');
		const drop = native('drop.mp3');
		const { favoriteTracks, settings } = makeFavorites();
		settings.favoriteTracks = [favoriteTracks.createFavoriteTrack(keep), favoriteTracks.createFavoriteTrack(drop)];

		favoriteTracks.removeFavoriteTrack('n:drop.mp3');

		expect(settings.favoriteTracks).toEqual([favoriteTracks.createFavoriteTrack(keep)]);
	});

	it('yields an empty list for corrupt persisted data', () => {
		const { favoriteTracks, settings } = makeFavorites();
		(settings as { favoriteTracks: unknown }).favoriteTracks = 42;

		favoriteTracks.removeFavoriteTrack('n:any.mp3');

		expect(settings.favoriteTracks).toEqual([]);
	});
});

// ─────────────────────────────────────────────────────────────
// getResolvedFavoriteTrackFiles — the batch
// ─────────────────────────────────────────────────────────────

describe('getResolvedFavoriteTrackFiles', () => {
	it('skips the unresolved and de-duplicates by key, in stored order', () => {
		const a = native('A.mp3', 'A.mp3');
		const b = drive('B.mp3', 'B.mp3');
		const { favoriteTracks, settings } = makeFavorites();
		settings.favoriteTracks = [
			favoriteTracks.createFavoriteTrack(a),
			favoriteTracks.createFavoriteTrack(web('missing.mp3')),
			favoriteTracks.createFavoriteTrack(a), // same key as the first
			favoriteTracks.createFavoriteTrack(b),
		];

		expect(favoriteTracks.getResolvedFavoriteTrackFiles()).toEqual([a, b]);
	});

	it('returns an empty batch for corrupt persisted data', () => {
		const { favoriteTracks, settings } = makeFavorites();
		(settings as { favoriteTracks: unknown }).favoriteTracks = {};

		expect(favoriteTracks.getResolvedFavoriteTrackFiles()).toEqual([]);
	});
});

// ─────────────────────────────────────────────────────────────
// playFavoriteTrack
// ─────────────────────────────────────────────────────────────

describe('playFavoriteTrack', () => {
	it('starts the queue at the favourite index when the favourite resolves', async () => {
		const first = native('A.mp3', 'A.mp3');
		const second = native('B.mp3', 'B.mp3');
		const view = makeView({ allFiles: [first, second] });
		const { favoriteTracks, settings, initAudioContext, beginQueue, startPlayback } = makeFavorites({ view });
		settings.favoriteTracks = [favoriteTracks.createFavoriteTrack(first), favoriteTracks.createFavoriteTrack(second)];

		await favoriteTracks.playFavoriteTrack(settings.favoriteTracks[1]);

		expect(initAudioContext).toHaveBeenCalledTimes(1);
		expect(beginQueue).toHaveBeenCalledWith('Favorite Tracks');
		expect(startPlayback).toHaveBeenCalledWith([first, second], 1, { preserveOrder: true });
		expect(view.isChangingTrack).toBe(false);
	});

	it('warns and does not start when the favourite cannot be resolved', async () => {
		const { favoriteTracks, view, initAudioContext, startPlayback, addToast } = makeFavorites();
		const favorite = favoriteTracks.createFavoriteTrack(web('gone.mp3'));

		await favoriteTracks.playFavoriteTrack(favorite);

		expect(addToast).toHaveBeenCalledWith({ message: 'This favorite track is not available in the current library.', type: 'warning' });
		expect(initAudioContext).not.toHaveBeenCalled();
		expect(startPlayback).not.toHaveBeenCalled();
		expect(view.isChangingTrack).toBe(false);
	});

	it('warns and resets the guard when the resolved favourite yields an empty batch', async () => {
		const file = native('A.mp3', 'A.mp3');
		const view = makeView({ allFiles: [file] });
		const { favoriteTracks, settings, startPlayback, addToast } = makeFavorites({ view });
		// The favourite resolves from the index but is not in the persisted list,
		// so building the batch from the list yields nothing.
		settings.favoriteTracks = [];
		const favorite = favoriteTracks.createFavoriteTrack(file);

		await favoriteTracks.playFavoriteTrack(favorite);

		expect(addToast).toHaveBeenCalledWith({ message: 'No favorite tracks are currently available.', type: 'warning' });
		expect(startPlayback).not.toHaveBeenCalled();
		expect(view.isChangingTrack).toBe(false);
	});

	it('bails while another track is already changing', async () => {
		const file = native('A.mp3');
		const view = makeView({ allFiles: [file] });
		const { favoriteTracks, settings, startPlayback } = makeFavorites({ view });
		settings.favoriteTracks = [favoriteTracks.createFavoriteTrack(file)];
		view.isChangingTrack = true;

		await favoriteTracks.playFavoriteTrack(settings.favoriteTracks[0]);

		expect(startPlayback).not.toHaveBeenCalled();
		expect(view.isChangingTrack).toBe(true);
	});

	it('hands a YouTube favourite to the panel instead of the deck', async () => {
		const { favoriteTracks, openYoutubePanel, startPlayback } = makeFavorites();

		await favoriteTracks.playFavoriteTrack(youtubeFavorite('abc123'));

		expect(openYoutubePanel).toHaveBeenCalledWith('abc123');
		expect(startPlayback).not.toHaveBeenCalled();
	});

	it('releases the guard in finally when the queue start throws', async () => {
		const file = native('A.mp3');
		const view = makeView({ allFiles: [file] });
		const { favoriteTracks, settings, startPlayback } = makeFavorites({ view });
		settings.favoriteTracks = [favoriteTracks.createFavoriteTrack(file)];
		startPlayback.mockRejectedValue(new Error('boom'));

		await expect(favoriteTracks.playFavoriteTrack(settings.favoriteTracks[0])).rejects.toThrow('boom');
		expect(view.isChangingTrack).toBe(false);
	});
});
