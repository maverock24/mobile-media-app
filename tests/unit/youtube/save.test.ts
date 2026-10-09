import { describe, it, expect, vi } from 'vitest';

// save.ts reaches @capacitor/core transitively (CapacitorHttp, registerPlugin), so
// mock the module rather than spying: CapacitorHttp's `get` is not an own property
// and vi.spyOn cannot patch it.
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

import { CapacitorHttp } from '@capacitor/core';
import { DirectoryReader } from '$lib/native/directory-reader';
import {
	sanitizeMp3FileName,
	base64FromBytes,
	bytesFromBase64,
	encodeAudioBufferToMp3,
	fetchYoutubeAudioBytes,
	writeMp3File,
} from '$lib/youtube/save';

const RANGE_CHUNK_BYTES = 512 * 1024;

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

		const encoded = base64FromBytes(bytes);
		const decoded = bytesFromBase64(encoded);

		expect(decoded.length).toBe(bytes.length);
		expect(decoded).toEqual(bytes);
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

describe('encodeAudioBufferToMp3', () => {
	it('encodes decoded PCM into a valid MP3 stream and reports progress', async () => {
		const sampleRate = 44100;
		const silence = new Float32Array(sampleRate); // 1 second mono
		const ratios: number[] = [];

		const mp3 = await encodeAudioBufferToMp3(
			{ numberOfChannels: 1, sampleRate, getChannelData: () => silence },
			(ratio) => ratios.push(ratio)
		);

		expect(mp3.length).toBeGreaterThan(0);
		// MPEG audio frame sync: 11 set bits.
		expect(mp3[0]).toBe(0xff);
		expect(mp3[1] & 0xe0).toBe(0xe0);
		expect(ratios.at(-1)).toBe(1);
	});
});

describe('fetchYoutubeAudioBytes', () => {
	it('downloads in ranges, assembles the bytes and reports progress', async () => {
		const full = new Uint8Array(RANGE_CHUNK_BYTES + 100);
		for (let index = 0; index < full.length; index += 1) full[index] = (index * 31) % 256;

		const ranges: string[] = [];
		const get = vi.mocked(CapacitorHttp.get);
		get.mockImplementation(async (options) => {
			const range = String(options.headers?.Range ?? '');
			ranges.push(range);
			const match = /bytes=(\d+)-(\d+)/.exec(range);
			const start = Number(match?.[1] ?? 0);
			const end = Math.min(Number(match?.[2] ?? full.length - 1), full.length - 1);
			const slice = full.subarray(start, end + 1);
			return {
				status: 206,
				headers: { 'Content-Range': `bytes ${start}-${end}/${full.length}` },
				data: base64FromBytes(slice),
				url: 'https://example.test/audio',
			};
		});

		const ratios: Array<number | null> = [];
		const bytes = await fetchYoutubeAudioBytes('https://example.test/audio', (ratio) => ratios.push(ratio));
		get.mockReset();

		expect(bytes).toEqual(full);
		expect(ranges).toEqual([`bytes=0-${RANGE_CHUNK_BYTES - 1}`, `bytes=${RANGE_CHUNK_BYTES}-${RANGE_CHUNK_BYTES + RANGE_CHUNK_BYTES - 1}`]);
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
