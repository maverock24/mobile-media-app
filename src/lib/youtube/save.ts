import { CapacitorHttp } from '@capacitor/core';
import { FilePicker } from '@capawesome/capacitor-file-picker';
import { DirectoryReader } from '$lib/native/directory-reader';
import { resolveYoutubeAudio } from './client';
import type { YoutubeQueueItem } from './queue';

/**
 * Save a YouTube track as an MP3 file on the device.
 *
 * YouTube serves AAC (`audio/mp4`), so a real MP3 needs a decode + re-encode:
 * the WebView's Web Audio API decodes the stream, and LAME (compiled to WASM by
 * `wasm-media-encoders`) encodes it. The bytes are fetched through
 * `CapacitorHttp` because googlevideo sends no CORS headers, so a WebView
 * `fetch` is blocked before the request leaves the app.
 *
 * The file is written through the existing `DirectoryReader.writeFile` SAF path,
 * after the user picks a folder with the Android folder picker.
 */

export type SavePhase = 'picking' | 'resolving' | 'downloading' | 'encoding' | 'saving';

export interface SaveProgress {
	phase: SavePhase;
	/** 0..1 within the phase, or null when the phase has no measurable progress. */
	ratio: number | null;
}

/** Samples per encoder call. LAME wants whole MPEG frames; 32 frames per chunk
 *  keeps each WASM call small enough to yield back to the UI between chunks. */
const CHUNK_SAMPLES = 1152 * 32;
/** LAME VBR quality 0 (best) to 9.999 (worst). 2 is a good size/quality balance. */
const MP3_VBR_QUALITY = 2;
const BASE64_CHUNK = 8192;
/** Bytes per range request. Keeps each base64 bridge payload well under 1 MB. */
const RANGE_CHUNK_BYTES = 512 * 1024;
/** decodeAudioData is one blocking call with no progress; bound it so it cannot hang. */
const DECODE_TIMEOUT_MS = 120_000;

/** Replace characters Android SAF and common media scanners reject. */
export function sanitizeMp3FileName(title: string): string {
	const cleaned = title
		// eslint-disable-next-line no-control-regex
		.replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
		.replace(/\s+/g, ' ')
		.trim()
		.replace(/\.+$/, '')
		.slice(0, 120)
		.trim();
	const base = cleaned || 'YouTube audio';
	return base.toLowerCase().endsWith('.mp3') ? base : `${base}.mp3`;
}

/** Base64 for a binary payload, chunked so a multi-MB file cannot blow the stack. */
export function base64FromBytes(bytes: Uint8Array): string {
	let binary = '';
	for (let offset = 0; offset < bytes.length; offset += BASE64_CHUNK) {
		binary += String.fromCharCode(...bytes.subarray(offset, offset + BASE64_CHUNK));
	}
	return btoa(binary);
}

export function bytesFromBase64(base64: string): Uint8Array {
	const payload = base64.includes(',') ? (base64.split(',').pop() ?? '') : base64;
	// Capacitor's Android bridge returns Base64.DEFAULT, which wraps lines.
	const binary = atob(payload.replace(/\s/g, ''));
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
	return bytes;
}

function yieldToUi(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(message)), ms);
		promise.then(
			(value) => { clearTimeout(timer); resolve(value); },
			(error: unknown) => { clearTimeout(timer); reject(error); },
		);
	});
}

function headerValue(headers: Record<string, string> | undefined, name: string): string | null {
	if (!headers) return null;
	const target = name.toLowerCase();
	for (const key of Object.keys(headers)) {
		if (key.toLowerCase() === target) return headers[key];
	}
	return null;
}

/**
 * Fetch the resolved googlevideo stream in byte-range chunks.
 *
 * A single `CapacitorHttp` binary response is handed to JS as one base64 string
 * over the Capacitor bridge; for a whole song that is several megabytes and the
 * call never settles (the row spinner hangs with no error). Ranges keep every
 * bridge payload under ~700 KB and expose the total size from `Content-Range`,
 * so the download reports real progress. Native HTTP is still required: the
 * stream host sends no CORS headers, so a WebView fetch cannot read it.
 */
export async function fetchYoutubeAudioBytes(
	audioUrl: string,
	onProgress?: (ratio: number | null) => void,
): Promise<Uint8Array> {
	const parts: Uint8Array[] = [];
	let total = 0;
	let totalBytes: number | null = null;

	for (;;) {
		const rangeEnd = total + RANGE_CHUNK_BYTES - 1;
		const response = await CapacitorHttp.get({
			url: audioUrl,
			responseType: 'arraybuffer',
			headers: { Range: `bytes=${total}-${rangeEnd}` },
			connectTimeout: 15_000,
			readTimeout: 30_000,
		});
		if (response.status < 200 || response.status >= 300) {
			throw new Error(`Download failed (HTTP ${response.status}).`);
		}

		const data: unknown = response.data;
		const chunk = typeof data === 'string'
			? bytesFromBase64(data)
			: data instanceof ArrayBuffer ? new Uint8Array(data) : null;
		if (!chunk) throw new Error('Unexpected download payload.');
		if (chunk.length === 0) break;

		parts.push(chunk);
		total += chunk.length;

		const contentRange = headerValue(response.headers, 'content-range');
		const totalMatch = contentRange ? /\/(\d+)\s*$/.exec(contentRange) : null;
		if (totalMatch) totalBytes = Number(totalMatch[1]);
		onProgress?.(totalBytes ? Math.min(1, total / totalBytes) : null);

		// 200 means the server ignored the Range and returned the whole body.
		if (response.status !== 206) break;
		if (chunk.length < RANGE_CHUNK_BYTES) break;
		if (totalBytes !== null && total >= totalBytes) break;

		await yieldToUi();
	}

	const bytes = new Uint8Array(total);
	let written = 0;
	for (const part of parts) {
		bytes.set(part, written);
		written += part.length;
	}
	return bytes;
}

export interface DecodedAudio {
	numberOfChannels: number;
	sampleRate: number;
	getChannelData(channel: number): Float32Array;
}

/** Encode decoded PCM as MP3 (LAME via WASM), yielding to the UI between chunks. */
export async function encodeAudioBufferToMp3(
	decoded: DecodedAudio,
	onProgress?: (ratio: number) => void,
): Promise<Uint8Array> {
	const channels: 1 | 2 = decoded.numberOfChannels >= 2 ? 2 : 1;
	// Loaded on demand so the WASM encoder stays out of the startup bundle.
	const { createMp3Encoder } = await import('wasm-media-encoders');
	const encoder = await createMp3Encoder();
	encoder.configure({ sampleRate: decoded.sampleRate, channels, vbrQuality: MP3_VBR_QUALITY });

	const left = decoded.getChannelData(0);
	const right = channels === 2 ? decoded.getChannelData(1) : null;
	const parts: Uint8Array[] = [];
	let total = 0;

	for (let offset = 0; offset < left.length; offset += CHUNK_SAMPLES) {
		const end = Math.min(offset + CHUNK_SAMPLES, left.length);
		const leftChunk = left.subarray(offset, end);
		const chunk = right
			? encoder.encode([leftChunk, right.subarray(offset, end)])
			: encoder.encode([leftChunk]);
		// `chunk` is owned by the encoder and will be overwritten, so copy it.
		const copy = chunk.slice();
		parts.push(copy);
		total += copy.length;
		onProgress?.(end / left.length);
		await yieldToUi();
	}

	const tail = encoder.finalize();
	if (tail.length > 0) {
		const copy = tail.slice();
		parts.push(copy);
		total += copy.length;
	}

	const mp3 = new Uint8Array(total);
	let written = 0;
	for (const part of parts) {
		mp3.set(part, written);
		written += part.length;
	}
	return mp3;
}

/** Decode the AAC/Opus stream and re-encode it as MP3. */
export async function transcodeToMp3(
	input: Uint8Array,
	onProgress?: (ratio: number) => void,
): Promise<Uint8Array> {
	const audioContext = new AudioContext();
	let decoded: AudioBuffer;
	try {
		// decodeAudioData detaches the buffer, so hand it a copy.
		decoded = await withTimeout(
			audioContext.decodeAudioData(input.slice().buffer as ArrayBuffer),
			DECODE_TIMEOUT_MS,
			'Audio decode timed out.',
		);
	} finally {
		void audioContext.close().catch(() => {});
	}
	return encodeAudioBufferToMp3(decoded, onProgress);
}

export interface SaveYoutubeOptions {
	onProgress?: (progress: SaveProgress) => void;
}

/**
 * Pick a folder, download the item, transcode it to MP3 and write it there.
 * Resolves with the new file's URI.
 */
export async function saveYoutubeItemToMp3(
	item: YoutubeQueueItem,
	options: SaveYoutubeOptions = {},
): Promise<string> {
	const { onProgress } = options;

	onProgress?.({ phase: 'picking', ratio: null });
	const { path: treeUri } = await FilePicker.pickDirectory();

	onProgress?.({ phase: 'resolving', ratio: null });
	const source = await resolveYoutubeAudio(item.videoId);

	onProgress?.({ phase: 'downloading', ratio: null });
	const audioBytes = await fetchYoutubeAudioBytes(source.audioUrl, (ratio) => {
		onProgress?.({ phase: 'downloading', ratio });
	});

	onProgress?.({ phase: 'encoding', ratio: 0 });
	const mp3Bytes = await transcodeToMp3(audioBytes, (ratio) => {
		onProgress?.({ phase: 'encoding', ratio });
	});

	onProgress?.({ phase: 'saving', ratio: null });
	try {
		await DirectoryReader.rememberTreeUri({ treeUri });
	} catch {
		// A transient grant is normally enough for the immediate write below.
	}
	const { path } = await DirectoryReader.writeFile({
		treeUri,
		fileName: sanitizeMp3FileName(source.title || item.title),
		mimeType: 'audio/mpeg',
		data: base64FromBytes(mp3Bytes),
	});
	return path;
}
