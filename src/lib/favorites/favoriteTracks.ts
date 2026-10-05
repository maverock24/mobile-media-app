/**
 * favoriteTracks.ts — one deck's track-favourite machine.
 *
 * Extracted from `Mp3PlayerView.svelte` (PR 5 of docs/refactoring-plan.md).
 * Owns the create/resolve/check/toggle/remove helpers, the batched resolver the
 * favourite play uses to build its queue, and `playFavoriteTrack`, the entry
 * point the favourites list and the now-playing star call.
 *
 * Seam: `createFavoriteTracks` is a factory, not a module singleton. Two decks
 * mount at once (the `deck` prop), so a shared instance would let deck A's
 * `playFavoriteTrack` answer for deck B. This module is rune-free — a plain
 * `.ts` cannot hold `$state` — so the deck keeps its reactive state and every
 * closure dependency arrives as an injected option:
 *
 *  - `view.allFiles` and `view.tracks` (read-only getters): where
 *    `resolveFavoriteTrackFile` looks for a loaded file before falling back to
 *    reconstructing one from the favourite's own metadata. `view.tracks` is
 *    `player.state.tracks`, so this also finds a queued track whose file is no
 *    longer in the library index.
 *  - `view.isChangingTrack` (get/set): the per-deck re-entrancy guard
 *    `playFavoriteTrack` checks and holds across its `await`.
 *  - `settings.favoriteTracks` (get/set): the shared persisted favourites list
 *    (`musicSettings.favoriteTracks`). It is global, not per-deck, so both
 *    decks read and write the same list; it is injected as the store object
 *    itself so the write still lands on the reactive store, not a copy.
 *  - the playback entry points `initAudioContext`, `beginQueue` and
 *    `startPlayback`, owned by the view.
 *  - `openYoutubePanel`: a YouTube favourite has no file to resolve, so it is
 *    handed to the panel instead of the deck queue.
 *  - `addToast`: the toast sink, for the two "not available" warnings.
 *
 * The two deriveds that read this machine stay in the view, because they also
 * read view state (`fileSearchQuery`, `musicSettings.lastTrackIndex`,
 * `currentTrack`): `filteredFavoriteTracks` filters `resolveFavoriteTrackFile`
 * results, and `currentTrackIsFavorite` asks `isFavoriteTrack` about the
 * currently playing track. They call the instance rather than same-named
 * wrappers.
 *
 * Behaviour preserved from the view:
 *  - `createFavoriteTrack`'s parse (`parseFilename`) and stored shape, branch by
 *    branch, including the per-branch `source` so the union discriminant stays
 *    narrow;
 *  - `resolveFavoriteTrackFile`'s two-step lookup (library index first, then the
 *    live queue) and its per-source reconstruction fallback, returning `null`
 *    for a web favourite that is not loaded and for a native/drive favourite
 *    with no path / file id;
 *  - `isFavoriteTrack`'s `Array.isArray` guard against corrupt persisted data;
 *  - `toggleFavoriteTrack`'s add-and-remove semantics (remove when the key
 *    exists, otherwise append the freshly built favourite);
 *  - `removeFavoriteTrack`'s key match;
 *  - `getResolvedFavoriteTrackFiles`'s batch: resolve every favourite in stored
 *    order, skip the unresolved, and de-duplicate by stored file key;
 *  - `playFavoriteTrack`'s guard order — bail while another track is changing;
 *    hand YouTube to the panel; warn when the favourite cannot be resolved; init
 *    the audio context; then resolve the batch, warn if it is empty, and start
 *    the queue at the favourite's index with `preserveOrder`, releasing
 *    `isChangingTrack` in `finally`.
 */
import {
	getStoredFileKey,
	getRelativePath,
	isYoutubeFavorite,
	parseFilename,
	type FavoriteTrack,
	type StoredAudioFile,
} from '$lib/models/music';
import type { PlayerTrack } from '$lib/audio/player.svelte';
import type { AddToastOptions } from '$lib/stores/toastStore.svelte';

/** A file row's identity, as the queue entry the resolver inspects. */
type QueueTrack = Pick<PlayerTrack, 'source'>;

/**
 * The view-owned state the favourite machine reads and writes. Every field is
 * the deck's reactive state; the deck passes an accessor so this rune-free
 * module can read and replace it without owning it.
 */
export interface FavoriteTracksView {
	/** The deck's file list; the library-index half of the resolve lookup. */
	readonly allFiles: StoredAudioFile[];
	/** The deck's live queue; the second half of the resolve lookup. */
	readonly tracks: QueueTrack[];
	/** The per-deck re-entrancy guard across `playFavoriteTrack`'s await. */
	isChangingTrack: boolean;
}

/** The shared persisted favourites list (`musicSettings.favoriteTracks`). */
export interface FavoriteTracksStore {
	favoriteTracks: FavoriteTrack[];
}

export interface FavoriteTracksOptions {
	/** The view-owned state the module reads and writes. */
	view: FavoriteTracksView;
	/** The shared persisted favourites list, passed by reference. */
	settings: FavoriteTracksStore;
	/** The view's lazy AudioContext init, run before the queue starts. */
	initAudioContext(): void;
	/** The deck's queue bookkeeping, run before a new favourite queue. */
	beginQueue(folder: string, options?: { selectionLoop?: boolean }): void;
	/** Hand a built queue to the player and start it at `index`. */
	startPlayback(
		files: StoredAudioFile[],
		index: number,
		options?: { selectionLoop?: boolean; preserveOrder?: boolean; suppressAlert?: boolean }
	): Promise<boolean>;
	/** Hand a YouTube favourite to the panel, which re-resolves its stream. */
	openYoutubePanel(videoId?: string): void;
	/** The toast sink, for the two "not available" warnings. */
	addToast(options: AddToastOptions): unknown;
}

/** Per-deck track favourites and the resolve-and-play machine behind them. */
export interface FavoriteTracks {
	createFavoriteTrack(file: StoredAudioFile): FavoriteTrack;
	resolveFavoriteTrackFile(favorite: FavoriteTrack): StoredAudioFile | null;
	isFavoriteTrack(file: StoredAudioFile): boolean;
	toggleFavoriteTrack(file: StoredAudioFile): void;
	removeFavoriteTrack(key: string): void;
	getResolvedFavoriteTrackFiles(): StoredAudioFile[];
	playFavoriteTrack(favorite: FavoriteTrack): Promise<void>;
}

export function createFavoriteTracks(opts: FavoriteTracksOptions): FavoriteTracks {
	const { view } = opts;

	function createFavoriteTrack(file: StoredAudioFile): FavoriteTrack {
		const parsed = parseFilename(file.name);
		// `source` is added per branch so TS keeps the discriminant narrow —
		// spreading file.source here would widen it to the whole union and no
		// longer match any FavoriteTrack member.
		const baseFavorite = {
			key: getStoredFileKey(file),
			name: file.name,
			title: parsed.title,
			artist: parsed.artist,
			relativePath: getRelativePath(file),
		};

		if (file.source === 'native') {
			return {
				...baseFavorite,
				source: 'native',
				path: file.path,
				mimeType: file.mimeType,
				modifiedAt: file.modifiedAt,
			};
		}

		if (file.source === 'drive') {
			return {
				...baseFavorite,
				source: 'drive',
				fileId: file.fileId,
				mimeType: file.mimeType,
				modifiedAt: file.modifiedAt,
				sizeBytes: file.sizeBytes,
				webViewLink: file.webViewLink,
			};
		}

		return { ...baseFavorite, source: 'web' };
	}

	function resolveFavoriteTrackFile(favorite: FavoriteTrack): StoredAudioFile | null {
		const loadedFile = view.allFiles.find((file) => getStoredFileKey(file) === favorite.key)
			?? view.tracks.find((track) => getStoredFileKey(track.source) === favorite.key)?.source;
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

	function isFavoriteTrack(file: StoredAudioFile): boolean {
		const key = getStoredFileKey(file);
		return Array.isArray(opts.settings.favoriteTracks)
			? opts.settings.favoriteTracks.some((favorite) => favorite.key === key)
			: false;
	}

	function toggleFavoriteTrack(file: StoredAudioFile): void {
		const favorite = createFavoriteTrack(file);
		const current = Array.isArray(opts.settings.favoriteTracks) ? opts.settings.favoriteTracks : [];
		const exists = current.some((entry) => entry.key === favorite.key);
		opts.settings.favoriteTracks = exists
			? current.filter((entry) => entry.key !== favorite.key)
			: [...current, favorite];
	}

	function removeFavoriteTrack(key: string): void {
		const current = Array.isArray(opts.settings.favoriteTracks) ? opts.settings.favoriteTracks : [];
		opts.settings.favoriteTracks = current.filter((favorite) => favorite.key !== key);
	}

	function getResolvedFavoriteTrackFiles(): StoredAudioFile[] {
		const seen = new Set<string>();
		const files: StoredAudioFile[] = [];

		const favorites = Array.isArray(opts.settings.favoriteTracks) ? opts.settings.favoriteTracks : [];
		for (const favorite of favorites) {
			const file = resolveFavoriteTrackFile(favorite);
			if (!file) continue;
			const key = getStoredFileKey(file);
			if (seen.has(key)) continue;
			seen.add(key);
			files.push(file);
		}

		return files;
	}

	async function playFavoriteTrack(favorite: FavoriteTrack): Promise<void> {
		if (view.isChangingTrack) return;

		// A YouTube favorite has no file to resolve, and its stream URL is
		// short-lived and IP-bound, so it can never join the music deck queue.
		// Hand off to the YouTube panel, which re-resolves and owns that audio.
		if (isYoutubeFavorite(favorite)) {
			opts.openYoutubePanel(favorite.videoId);
			return;
		}

		const resolvedTrack = resolveFavoriteTrackFile(favorite);
		if (!resolvedTrack) {
			opts.addToast({ message: 'This favorite track is not available in the current library.', type: 'warning' });
			return;
		}

		opts.initAudioContext();
		view.isChangingTrack = true;
		try {
			const files = getResolvedFavoriteTrackFiles();
			if (files.length === 0) {
				opts.addToast({ message: 'No favorite tracks are currently available.', type: 'warning' });
				return;
			}

			// Load tracks in display order (not sorted), so playback follows
			// the same order the user sees in the favorites list.
			const nextIndex = files.findIndex((file) => getStoredFileKey(file) === favorite.key);
			opts.beginQueue('Favorite Tracks');
			await opts.startPlayback(files, Math.max(0, nextIndex), { preserveOrder: true });
		} finally {
			view.isChangingTrack = false;
		}
	}

	return {
		createFavoriteTrack,
		resolveFavoriteTrackFile,
		isFavoriteTrack,
		toggleFavoriteTrack,
		removeFavoriteTrack,
		getResolvedFavoriteTrackFiles,
		playFavoriteTrack
	};
}
