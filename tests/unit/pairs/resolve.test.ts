/**
 * The track-reference resolver (`$lib/pairs/resolve.ts`). Both functions are
 * pure, so the index is a plain array here: no deck, no library.
 */
import { describe, it, expect } from 'vitest';
import type { StoredAudioFile } from '$lib/models/music';
import { resolvePairingTrack, toTrackRef } from '$lib/pairs/resolve';
import type { PairingTrackRef } from '$lib/pairs/types';

const nativeFile: StoredAudioFile = {
	source: 'native',
	name: 'Atomic Habits.mp3',
	relativePath: 'books/Atomic Habits.mp3',
	path: '/storage/emulated/0/Books/Atomic Habits.mp3',
	mimeType: 'audio/mpeg',
	modifiedAt: 1700000000000,
};

const driveFile: StoredAudioFile = {
	source: 'drive',
	name: 'Rain.mp3',
	relativePath: 'music/Rain.mp3',
	fileId: 'abc123',
	mimeType: 'audio/mpeg',
	modifiedAt: 1700000000001,
	sizeBytes: 4096,
	webViewLink: 'https://drive.google.com/file/d/abc123/view',
};

describe('resolvePairingTrack', () => {
	it('round-trips a native ref', () => {
		const ref = toTrackRef(nativeFile);

		expect(ref).toEqual({
			key: 'n:books/Atomic Habits.mp3',
			name: 'Atomic Habits.mp3',
			relativePath: 'books/Atomic Habits.mp3',
			source: 'native',
			path: '/storage/emulated/0/Books/Atomic Habits.mp3',
			mimeType: 'audio/mpeg',
			modifiedAt: 1700000000000,
		});
		expect(resolvePairingTrack(ref, [])).toEqual(nativeFile);
	});

	it('round-trips a drive ref', () => {
		const ref = toTrackRef(driveFile);

		expect(ref).toEqual({
			key: 'd:abc123',
			name: 'Rain.mp3',
			relativePath: 'music/Rain.mp3',
			source: 'drive',
			fileId: 'abc123',
			mimeType: 'audio/mpeg',
			modifiedAt: 1700000000001,
			sizeBytes: 4096,
			webViewLink: 'https://drive.google.com/file/d/abc123/view',
		});
		expect(resolvePairingTrack(ref, [])).toEqual(driveFile);
	});

	it('returns the indexed file when the ref matches', () => {
		// The stored ref points at a path the file no longer has; the key is what
		// wins, so the caller gets the library's own object, not a rebuild.
		const ref: PairingTrackRef = {
			...(toTrackRef(nativeFile) as Extract<PairingTrackRef, { source: 'native' }>),
			path: '/moved/Atomic Habits.mp3',
		};

		const resolved = resolvePairingTrack(ref, [nativeFile]);

		expect(resolved).toBe(nativeFile);
		expect(resolved?.source === 'native' && resolved.path).toBe(
			'/storage/emulated/0/Books/Atomic Habits.mp3'
		);
	});

	it('reconstructs a file that is no longer indexed', () => {
		const ref = toTrackRef(driveFile);

		// The library holds an unrelated file, so the key lookup misses and the
		// ref's own `fileId` has to carry the resolution.
		const resolved = resolvePairingTrack(ref, [nativeFile]);

		expect(resolved).not.toBeNull();
		expect(resolved).toEqual(driveFile);
		expect(resolved).not.toBe(driveFile);
	});
});
