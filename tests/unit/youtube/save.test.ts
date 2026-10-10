import { describe, it, expect, vi } from 'vitest';

// save.ts reaches @capacitor/core transitively through the plugin modules.
vi.mock('@capacitor/core', () => ({
	Capacitor: {
		isNativePlatform: () => false,
		isPluginAvailable: () => false,
		getPlatform: () => 'web',
		convertFileSrc: (path: string) => path,
	},
	registerPlugin: () => ({}),
}));

vi.mock('@capawesome/capacitor-file-picker', () => ({
	FilePicker: { pickDirectory: vi.fn() },
}));

vi.mock('$lib/native/directory-reader', () => ({
	DirectoryReader: {
		rememberTreeUri: vi.fn(async () => {}),
		appendFileChunk: vi.fn(async () => ({ path: 'content://tree/Song.m4a' })),
	},
}));

vi.mock('$lib/native/youtube-audio', () => ({
	YoutubeAudio: {
		download: vi.fn(),
		readFileChunk: vi.fn(),
		release: vi.fn(async () => {}),
		addListener: vi.fn(async () => ({ remove: async () => {} })),
	},
}));

vi.mock('$lib/youtube/client', () => ({
	resolveYoutubeDownload: vi.fn(),
}));

import { FilePicker } from '@capawesome/capacitor-file-picker';
import { DirectoryReader } from '$lib/native/directory-reader';
import { YoutubeAudio } from '$lib/native/youtube-audio';
import { resolveYoutubeDownload } from '$lib/youtube/client';
import {
	base64FromBytes,
	bytesFromBase64,
	sanitizeAudioFileName,
	saveYoutubeItem,
	writeDownloadedFile,
} from '$lib/youtube/save';
import { markSavePhase, clearSavePhase, takeCrashedSavePhase } from '$lib/youtube/saveMarker';

/** A fake native reader returning real base64 of the requested size. */
function stubChunkedRead(totalBytes: number): void {
	vi.mocked(YoutubeAudio.readFileChunk).mockImplementation(async ({ offset, length }) => {
		const size = Math.max(0, Math.min(length, totalBytes - offset));
		return { data: base64FromBytes(new Uint8Array(size)), bytesRead: size, eof: offset + size >= totalBytes };
	});
}

describe('sanitizeAudioFileName', () => {
	it('appends the container extension and keeps an existing one', () => {
		expect(sanitizeAudioFileName('Song Title', 'm4a')).toBe('Song Title.m4a');
		expect(sanitizeAudioFileName('Song Title.m4a', 'm4a')).toBe('Song Title.m4a');
		expect(sanitizeAudioFileName('SONG TITLE.M4A', 'm4a')).toBe('SONG TITLE.M4A');
	});

	it('does not mistake another extension for the target one', () => {
		expect(sanitizeAudioFileName('Song.mp3', 'm4a')).toBe('Song.mp3.m4a');
	});

	it('replaces filesystem-illegal characters and collapses spaces', () => {
		expect(sanitizeAudioFileName('A/B: "C" ?', 'm4a')).toBe('A B C.m4a');
	});

	it('falls back to a default name when nothing usable remains', () => {
		expect(sanitizeAudioFileName('   ', 'm4a')).toBe('YouTube audio.m4a');
		expect(sanitizeAudioFileName('///', 'm4a')).toBe('YouTube audio.m4a');
	});

	it('strips trailing dots and truncates long titles', () => {
		expect(sanitizeAudioFileName('Trailing...', 'm4a')).toBe('Trailing.m4a');
		expect(sanitizeAudioFileName('x'.repeat(300), 'm4a').length).toBeLessThanOrEqual(124);
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

describe('writeDownloadedFile', () => {
	it('copies the cached file in bounded chunks, creating the document on the first call', async () => {
		const append = vi.mocked(DirectoryReader.appendFileChunk);
		append.mockClear();
		stubChunkedRead(256 * 1024 * 2 + 10);
		const ratios: number[] = [];

		await writeDownloadedFile({
			treeUri: 'content://tree',
			fileName: 'Song.m4a',
			mimeType: 'audio/mp4',
			sourcePath: '/cache/yt-x.audio',
			size: 256 * 1024 * 2 + 10,
			onProgress: (ratio) => ratios.push(ratio),
		});

		expect(append).toHaveBeenCalledTimes(3);
		expect(append.mock.calls[0][0].create).toBe(true);
		expect(append.mock.calls[1][0].create).toBe(false);
		expect(append.mock.calls[0][0].fileName).toBe('Song.m4a');
		expect(append.mock.calls[0][0].mimeType).toBe('audio/mp4');
		// Every bridge payload is small enough to survive.
		expect(append.mock.calls[0][0].data.length).toBeLessThan(400_000);
		expect(bytesFromBase64(append.mock.calls[0][0].data).length).toBe(256 * 1024);
		expect(ratios.at(-1)).toBe(1);
	});

	it('fails instead of leaving a short file behind', async () => {
		vi.mocked(YoutubeAudio.readFileChunk).mockResolvedValue({
			data: '',
			bytesRead: 0,
			eof: true,
		});

		await expect(
			writeDownloadedFile({
				treeUri: 'content://tree',
				fileName: 'Song.m4a',
				mimeType: 'audio/mp4',
				sourcePath: '/cache/yt-x.audio',
				size: 4096,
			}),
		).rejects.toThrow(/Only 0 of 4096 bytes/);
	});
});

describe('saveYoutubeItem', () => {
	it('downloads the resolved container and copies it under the right name', async () => {
		vi.mocked(FilePicker.pickDirectory).mockResolvedValue({ path: 'content://tree' } as never);
		vi.mocked(resolveYoutubeDownload).mockResolvedValue({
			videoId: 'dQw4w9WgXcQ',
			audioUrl: 'https://rr1---sn-x.googlevideo.com/videoplayback?itag=140',
			title: 'A Song',
			mimeType: 'audio/mp4',
			extension: 'm4a',
			contentLength: 4_194_304,
		});
		vi.mocked(YoutubeAudio.download).mockResolvedValue({ path: '/cache/yt-x.audio', size: 4_194_304 });
		stubChunkedRead(4_194_304);
		const append = vi.mocked(DirectoryReader.appendFileChunk);
		append.mockClear();
		append.mockResolvedValue({ path: 'content://tree/A Song.m4a' });

		const path = await saveYoutubeItem({
			videoId: 'dQw4w9WgXcQ',
			title: 'A Song',
			subtitle: 'Artist',
			durationSeconds: 210,
			durationLabel: '3:30',
			thumbnailUrl: '',
		});

		expect(path).toBe('content://tree/A Song.m4a');
		expect(vi.mocked(YoutubeAudio.download).mock.calls[0][0]).toEqual({
			url: 'https://rr1---sn-x.googlevideo.com/videoplayback?itag=140',
			id: 'dQw4w9WgXcQ',
			expectedBytes: 4_194_304,
		});
		expect(append.mock.calls[0][0].fileName).toBe('A Song.m4a');
		expect(append.mock.calls[0][0].mimeType).toBe('audio/mp4');
		// The cache is dropped whether or not the copy succeeded.
		expect(vi.mocked(YoutubeAudio.release)).toHaveBeenCalledWith({ id: 'dQw4w9WgXcQ' });
	});

	it('reports the download size when the resolver had none', async () => {
		vi.mocked(FilePicker.pickDirectory).mockResolvedValue({ path: 'content://tree' } as never);
		vi.mocked(resolveYoutubeDownload).mockResolvedValue({
			videoId: 'dQw4w9WgXcQ',
			audioUrl: 'https://x/videoplayback',
			title: 'A Song',
			mimeType: 'audio/mp4',
			extension: 'm4a',
			contentLength: null,
		});
		vi.mocked(YoutubeAudio.download).mockClear();
		vi.mocked(YoutubeAudio.download).mockResolvedValue({ path: '/cache/yt-x.audio', size: 2048 });
		stubChunkedRead(2048);
		vi.mocked(DirectoryReader.appendFileChunk).mockResolvedValue({ path: 'content://tree/A Song.m4a' });

		await saveYoutubeItem({
			videoId: 'dQw4w9WgXcQ',
			title: 'A Song',
			subtitle: 'Artist',
			durationSeconds: 210,
			durationLabel: '3:30',
			thumbnailUrl: '',
		});

		expect(vi.mocked(YoutubeAudio.download).mock.calls[0][0].expectedBytes).toBeUndefined();
	});
});

describe('saveMarker', () => {
	it('remembers the phase a crash left behind, once', () => {
		clearSavePhase();
		expect(takeCrashedSavePhase()).toBeNull();

		markSavePhase('downloading');
		expect(takeCrashedSavePhase()).toBe('downloading');
		// Consumed: a second read reports nothing.
		expect(takeCrashedSavePhase()).toBeNull();
	});

	it('clears the marker on a completed save', () => {
		markSavePhase('saving');
		clearSavePhase();
		expect(takeCrashedSavePhase()).toBeNull();
	});
});
