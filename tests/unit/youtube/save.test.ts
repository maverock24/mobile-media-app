import { describe, it, expect, vi } from 'vitest';

// save.ts reaches @capacitor/core transitively through the plugin modules.
vi.mock('@capacitor/core', () => ({
	CapacitorHttp: { get: vi.fn() },
	Capacitor: {
		isNativePlatform: () => false,
		isPluginAvailable: () => false,
		getPlatform: () => 'web',
		convertFileSrc: (path: string) => path,
	},
	registerPlugin: () => ({}),
}));

vi.mock('$lib/native/directory-reader', () => ({
	DirectoryReader: {
		rememberTreeUri: vi.fn(async () => {}),
		appendFileChunk: vi.fn(async () => ({ path: 'content://tree/Song.mp3' })),
		writeFile: vi.fn(),
	},
}));

vi.mock('$lib/native/youtube-audio', () => ({
	YoutubeAudio: {
		preparePcm: vi.fn(),
		readPcmChunk: vi.fn(),
		release: vi.fn(async () => {}),
		addListener: vi.fn(async () => ({ remove: async () => {} })),
	},
}));

import { DirectoryReader } from '$lib/native/directory-reader';
import { YoutubeAudio } from '$lib/native/youtube-audio';
import {
	sanitizeMp3FileName,
	base64FromBytes,
	bytesFromBase64,
	interleavedInt16ToPlanarFloats,
	encodePcmToMp3,
	writeMp3File,
} from '$lib/youtube/save';
import { markSavePhase, clearSavePhase, takeCrashedSavePhase } from '$lib/youtube/saveMarker';

describe('sanitizeMp3FileName', () => {
	it('appends .mp3 and keeps an existing extension', () => {
		expect(sanitizeMp3FileName('Song Title')).toBe('Song Title.mp3');
		expect(sanitizeMp3FileName('Song Title.mp3')).toBe('Song Title.mp3');
	});

	it('replaces filesystem-illegal characters and collapses spaces', () => {
		expect(sanitizeMp3FileName('A/B: "C" ?')).toBe('A B C.mp3');
	});

	it('falls back to a default name when nothing usable remains', () => {
		expect(sanitizeMp3FileName('   ')).toBe('YouTube audio.mp3');
		expect(sanitizeMp3FileName('///')).toBe('YouTube audio.mp3');
	});

	it('strips trailing dots and truncates long titles', () => {
		expect(sanitizeMp3FileName('Trailing...')).toBe('Trailing.mp3');
		expect(sanitizeMp3FileName('x'.repeat(300)).length).toBeLessThanOrEqual(124);
	});
});

describe('base64 chunking', () => {
	it('round-trips a payload larger than the internal chunk size', () => {
		const bytes = new Uint8Array(200_000);
		for (let index = 0; index < bytes.length; index += 1) bytes[index] = index % 256;

		expect(bytesFromBase64(base64FromBytes(bytes))).toEqual(bytes);
	});

	it('accepts a data URL and ignores surrounding whitespace', () => {
		const bytes = new Uint8Array([1, 2, 3, 4, 5]);
		const encoded = base64FromBytes(bytes);
		expect(bytesFromBase64(`data:audio/mpeg;base64,${encoded}`)).toEqual(bytes);
		expect(bytesFromBase64(`  ${encoded}  `)).toEqual(bytes);
	});

	it('decodes Base64.DEFAULT line-wrapped output (Capacitor Android)', () => {
		const bytes = new Uint8Array(300);
		for (let index = 0; index < bytes.length; index += 1) bytes[index] = (index * 7) % 256;
		const wrapped = base64FromBytes(bytes).replace(/(.{76})/g, '$1\n');
		expect(bytesFromBase64(wrapped)).toEqual(bytes);
	});
});

describe('interleavedInt16ToPlanarFloats', () => {
	it('de-interleaves stereo samples into planar floats', () => {
		const samples = new Int16Array([0, 32767, -32768, 16384]);
		const { left, right } = interleavedInt16ToPlanarFloats(new Uint8Array(samples.buffer), 2);

		expect(Array.from(left)).toEqual([0, -1]);
		expect(right).not.toBeNull();
		expect(right?.[0]).toBeCloseTo(32767 / 32768, 5);
		expect(right?.[1]).toBeCloseTo(0.5, 5);
	});

	it('returns no right channel for mono', () => {
		const samples = new Int16Array([1000, -1000]);
		const { left, right } = interleavedInt16ToPlanarFloats(new Uint8Array(samples.buffer), 1);
		expect(right).toBeNull();
		expect(Array.from(left)).toEqual([1000 / 32768, -1000 / 32768]);
	});
});

describe('encodePcmToMp3', () => {
	it('reads the native PCM in chunks and produces a valid MP3', async () => {
		const sampleRate = 44100;
		const channels = 1 as const;
		const samples = sampleRate; // 1 second
		const totalBytes = samples * 2 * channels;

		vi.mocked(YoutubeAudio.readPcmChunk).mockImplementation(async ({ offset, length }) => {
			const size = Math.min(length, totalBytes - offset);
			return {
				data: base64FromBytes(new Uint8Array(size)),
				eof: offset + size >= totalBytes,
			};
		});

		const ratios: number[] = [];
		const mp3 = await encodePcmToMp3(
			{ path: 'pcm', sampleRate, channels, samples },
			(ratio) => ratios.push(ratio),
		);

		expect(YoutubeAudio.readPcmChunk).toHaveBeenCalledTimes(2);
		expect(mp3.length).toBeGreaterThan(0);
		// MPEG audio frame sync: 11 set bits.
		expect(mp3[0]).toBe(0xff);
		expect(mp3[1] & 0xe0).toBe(0xe0);
		expect(ratios.at(-1)).toBe(1);
	});
});

describe('writeMp3File', () => {
	it('writes the MP3 in bounded chunks, creating the file on the first call', async () => {
		const append = vi.mocked(DirectoryReader.appendFileChunk);
		append.mockClear();
		const writeChunk = 256 * 1024;
		const mp3 = new Uint8Array(writeChunk * 2 + 10);
		const ratios: number[] = [];

		await writeMp3File('content://tree', 'Song.mp3', mp3, (ratio) => ratios.push(ratio));

		expect(append).toHaveBeenCalledTimes(3);
		expect(append.mock.calls[0][0].create).toBe(true);
		expect(append.mock.calls[1][0].create).toBe(false);
		expect(append.mock.calls[0][0].fileName).toBe('Song.mp3');
		// Every bridge payload is small enough to survive.
		expect(append.mock.calls[0][0].data.length).toBeLessThan(400_000);
		expect(bytesFromBase64(append.mock.calls[0][0].data).length).toBe(writeChunk);
		expect(ratios.at(-1)).toBe(1);
	});
});

describe('saveMarker', () => {
	it('remembers the phase a crash left behind, once', () => {
		clearSavePhase();
		expect(takeCrashedSavePhase()).toBeNull();

		markSavePhase('encoding');
		expect(takeCrashedSavePhase()).toBe('decoding and encoding');
		// Consumed: a second read reports nothing.
		expect(takeCrashedSavePhase()).toBeNull();
	});

	it('clears the marker on a completed save', () => {
		markSavePhase('saving');
		clearSavePhase();
		expect(takeCrashedSavePhase()).toBeNull();
	});
});
