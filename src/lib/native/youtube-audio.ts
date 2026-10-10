import { registerPlugin } from '@capacitor/core';

/**
 * Native Android bridge for the YouTube → file save.
 *
 * The WebView cannot fetch googlevideo directly: the stream host sends no CORS
 * headers, and pulling a whole song into JS holds it all in the WebView. The
 * download therefore runs natively (`HttpURLConnection`), and JS only ever reads
 * the cached result back in bounded chunks to copy it into the picked folder.
 *
 * The bytes are stored exactly as YouTube served them. No decoding, no
 * re-encoding, so nothing materialises the track as PCM.
 */

export interface DownloadResult {
	/** Absolute path of the downloaded stream in the cache. */
	path: string;
	/** Bytes on disk. */
	size: number;
}

export interface FileChunkResult {
	/** Base64 (no line wrapping) of the bytes read. */
	data: string;
	/** Bytes the native side actually read. */
	bytesRead: number;
	eof: boolean;
}

export interface YoutubeAudioProgressEvent {
	/** Bytes downloaded so far. */
	received: number;
	/** Total bytes, or -1 when the length is unknown. */
	total: number;
}

export interface YoutubeAudioPlugin {
	download(options: {
		url: string;
		id: string;
		/** Byte size from the resolver, when YouTube reported one. */
		expectedBytes?: number;
	}): Promise<DownloadResult>;
	readFileChunk(options: { path: string; offset: number; length: number }): Promise<FileChunkResult>;
	release(options: { id: string }): Promise<void>;
	addListener(
		eventName: 'progress',
		listener: (event: YoutubeAudioProgressEvent) => void
	): Promise<{ remove: () => Promise<void> }>;
}

export const YoutubeAudio = registerPlugin<YoutubeAudioPlugin>('YoutubeAudio');
