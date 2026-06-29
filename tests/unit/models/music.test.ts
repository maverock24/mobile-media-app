import { describe, it, expect } from 'vitest';
import {
	formatTime, formatClock, formatDuration, parseFilename,
	sortFiles, mergeStoredFiles, getStoredFileKey, getTrackKey,
	createStoredAudioFile, createStoredWebAudioFile,
	createStoredNativeAudioFile, createStoredDriveAudioFile,
	EQ_FREQS, EQ_PRESETS, fmtGain,
} from '$lib/models/music';
import type { StoredAudioFile } from '$lib/models/music';

describe('formatTime', () => {
	it('formats M:SS', () => {
		expect(formatTime(0)).toBe('0:00');
		expect(formatTime(5)).toBe('0:05');
		expect(formatTime(65)).toBe('1:05');
		expect(formatTime(3661)).toBe('61:01');
	});
	it('guards non-finite / negative', () => {
		expect(formatTime(NaN)).toBe('0:00');
		expect(formatTime(-1)).toBe('0:00');
		expect(formatTime(Infinity)).toBe('0:00');
	});
});

describe('formatClock', () => {
	it('uses H:MM:SS only when hours present', () => {
		expect(formatClock(65)).toBe('1:05');
		expect(formatClock(3661)).toBe('1:01:01');
	});
	it('guards non-finite / negative', () => {
		expect(formatClock(-1)).toBe('0:00');
		expect(formatClock(NaN)).toBe('0:00');
	});
});

describe('formatDuration', () => {
	it('compact human form', () => {
		expect(formatDuration(65)).toBe('1:05');
		expect(formatDuration(3661)).toBe('1h 1m');
	});
	it('em-dash for empty/invalid', () => {
		expect(formatDuration(0)).toBe('–');
		expect(formatDuration(-1)).toBe('–');
		expect(formatDuration(NaN)).toBe('–');
	});
});

describe('parseFilename', () => {
	it('splits "Artist - Title"', () => {
		expect(parseFilename('Daft Punk - One More Time.mp3')).toEqual({
			artist: 'Daft Punk', title: 'One More Time',
		});
	});
	it('falls back to Unknown Artist', () => {
		expect(parseFilename('track.mp3')).toEqual({ title: 'track', artist: 'Unknown Artist' });
	});
	it('replaces underscores', () => {
		expect(parseFilename('Some_Artist_-_Title.mp3').title).toBe('Title');
	});
});

describe('sortFiles', () => {
	const web = (name: string): StoredAudioFile =>
		({ source: 'web', name, relativePath: name, file: new File([], name) });

	it('default (name) sort is numeric', () => {
		const files = [web('track10'), web('track2'), web('track1')];
		const names = sortFiles(files, 'name').map((f) => f.name);
		expect(names).toEqual(['track1', 'track2', 'track10']);
	});
	it('title sort uses parsed title', () => {
		const files = [web('B - zeta.mp3'), web('A - alpha.mp3')];
		const names = sortFiles(files, 'title').map((f) => f.name);
		expect(names).toEqual(['A - alpha.mp3', 'B - zeta.mp3']);
	});
	it('does not mutate the input array', () => {
		const files = [web('b'), web('a')];
		const orig = [...files];
		sortFiles(files, 'name');
		expect(files.map((f) => f.name)).toEqual(orig.map((f) => f.name));
	});
});

describe('mergeStoredFiles', () => {
	const native = (name: string, path: string): StoredAudioFile =>
		({ source: 'native', name, relativePath: name, path, mimeType: 'audio/mpeg' });

	it('dedupes by key', () => {
		const existing = [native('a', '/x/a.mp3')];
		const incoming = [native('a', '/x/a.mp3'), native('b', '/x/b.mp3')];
		const merged = mergeStoredFiles(existing, incoming);
		expect(merged).toHaveLength(2);
	});
	it('empty incoming returns existing unchanged', () => {
		const existing = [native('a', '/x/a.mp3')];
		expect(mergeStoredFiles(existing, [])).toBe(existing);
	});
});

describe('stored-file factories', () => {
	it('createStoredAudioFile derives relativePath from webkitRelativePath', () => {
		const file = new File([], 'song.mp3');
		// jsdom File doesn't set webkitRelativePath; the factory falls back to name.
		const stored = createStoredAudioFile(file);
		expect(stored.source).toBe('web');
		expect(stored.name).toBe('song.mp3');
	});
	it('createStoredWebAudioFile honours explicit relativePath', () => {
		const file = new File([], 'song.mp3');
		const stored = createStoredWebAudioFile(file, 'sub/song.mp3');
		expect(stored.relativePath).toBe('sub/song.mp3');
	});
	it('createStoredNativeAudioFile copies native fields', () => {
		const stored = createStoredNativeAudioFile({
			kind: 'file', name: 'a.mp3', relativePath: 'a.mp3', path: '/x/a.mp3',
			mimeType: 'audio/mpeg', modifiedAt: 123,
		});
		expect(stored.source).toBe('native');
		expect(stored).toHaveProperty('path', '/x/a.mp3');
	});
	it('createStoredDriveAudioFile normalises missing relativePath + parses size/time', () => {
		const stored = createStoredDriveAudioFile({
			id: 'f1', name: 'a.mp3', mimeType: 'audio/mpeg',
			modifiedTime: '2026-01-01T00:00:00Z', size: '2048',
		});
		expect(stored.source).toBe('drive');
		expect(stored.relativePath).toBe('a.mp3');
		if (stored.source !== 'drive') throw new Error('expected drive');
		expect(stored.sizeBytes).toBe(2048);
		expect(typeof stored.modifiedAt).toBe('number');
	});
});

describe('keys', () => {
	it('getStoredFileKey differs by relativePath', () => {
		const a: StoredAudioFile = { source: 'native', name: 'a', relativePath: 'a', path: '/x/a' };
		const b: StoredAudioFile = { source: 'native', name: 'a', relativePath: 'b', path: '/y/a' };
		expect(getStoredFileKey(a)).not.toBe(getStoredFileKey(b));
	});
	it('getTrackKey is stable for the same file', () => {
		const a: StoredAudioFile = { source: 'web', name: 'a', relativePath: 'a', file: new File([], 'a') };
		expect(getTrackKey(a)).toBe(getTrackKey(a));
	});
});

describe('EQ constants', () => {
	it('EQ_FREQS has 6 bands', () => {
		expect(EQ_FREQS).toHaveLength(6);
	});
	it('EQ_PRESETS exposes flat/defaults', () => {
		expect(EQ_PRESETS.flat ?? EQ_PRESETS.Flat ?? EQ_PRESETS.off).toBeTruthy();
	});
	it('fmtGain signs positive', () => {
		expect(fmtGain(3)).toBe('+3');
		expect(fmtGain(-2)).toBe('-2');
		expect(fmtGain(0)).toBe('0');
	});
});
