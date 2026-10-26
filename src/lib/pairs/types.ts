/**
 * types.ts — the serialisable shapes the A/B pairing store persists (D4).
 *
 * `PairingTrackRef` mirrors the file-carrying variants of `FavoriteTrack`
 * (`$lib/models/music.ts:36-42`) minus `title`/`artist`, so reconstruction
 * without the library index has a proven shape: `key` is always
 * `getStoredFileKey(file)` and `name` + `relativePath` are denormalised so a
 * row can be rendered and a native/drive file rebuilt after a restart. The
 * `youtube` variant does not exist here: a pairing's B side is a background
 * file, and the A side is an audiobook, so nothing in a pair is a stream.
 *
 * Only JSON-safe fields are kept. A `web` ref carries no `File` — a live blob
 * cannot be serialised — which is why a web file resolves only while it is
 * still indexed (see `resolve.ts`).
 */

/** One side of a pair: which stored file it is, and enough to rebuild it. */
export type PairingTrackRef =
	| { key: string; name: string; relativePath: string; source: 'web' }
	| {
			key: string;
			name: string;
			relativePath: string;
			source: 'native';
			path: string;
			mimeType?: string;
			modifiedAt?: number;
	  }
	| {
			key: string;
			name: string;
			relativePath: string;
			source: 'drive';
			fileId: string;
			mimeType?: string;
			modifiedAt?: number;
			sizeBytes?: number;
			webViewLink?: string;
	  };

/**
 * One saved scene. `durationSec` sits on the pair rather than on the track ref
 * (D4 amendment) because a duration cannot be recovered once the file moves.
 */
export interface AbPairing {
	id: number;
	name: string;
	savedAt: number;
	/** Deck A: the audiobook. Always present. */
	a: PairingTrackRef;
	/** Deck B: the background track. `null` for an audiobook-only pair. */
	b: PairingTrackRef | null;
	bVolume: number;
	bSpeed: number;
	positionSec: number;
	durationSec: number;
}
