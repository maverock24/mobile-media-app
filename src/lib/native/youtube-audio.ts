import { registerPlugin } from '@capacitor/core';

/**
 * Native Android bridge for the YouTube → MP3 save.
 *
 * The WebView cannot do this part safely: `decodeAudioData` materialises the
 * whole track as PCM (tens to hundreds of MB) and uses the WebView's media
 * decoder, which is what killed the app. Instead the download and the AAC/Opus
 * decode run natively (HttpURLConnection + MediaExtractor/MediaCodec), producing
 * a 16-bit PCM file on disk. JS then pulls it in bounded chunks and feeds the
 * LAME encoder, so peak memory stays small.
 */

export interface PreparePcmResult {
	/** Absolute path of the decoded 16-bit interleaved PCM file in the cache. */
	path: string;
	sampleRate: number;
	channels: 1 | 2;
	/** Total frames (samples per channel). */
	samples: number;
}

export interface PcmChunkResult {
	/** Base64 (no line wrapping) of the raw little-endian Int16 PCM bytes. */
	data: string;
	eof: boolean;
}

export interface YoutubeAudioProgressEvent {
	phase: 'download' | 'decode';
	received: number;
	/** Total bytes, or -1 when the server did not report a length. */
	total: number;
}

export interface YoutubeAudioPlugin {
	preparePcm(options: { url: string; id: string }): Promise<PreparePcmResult>;
	readPcmChunk(options: { path: string; offset: number; length: number }): Promise<PcmChunkResult>;
	release(options: { id: string }): Promise<void>;
	addListener(
		eventName: 'progress',
		listener: (event: YoutubeAudioProgressEvent) => void
	): Promise<{ remove: () => Promise<void> }>;
}

export const YoutubeAudio = registerPlugin<YoutubeAudioPlugin>('YoutubeAudio');
