import { describe, it, expect } from 'vitest';
import { sanitizeMp3FileName, base64FromBytes, bytesFromBase64, encodeAudioBufferToMp3 } from '$lib/youtube/save';

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
