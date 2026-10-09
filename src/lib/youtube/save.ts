import { FilePicker } from '@capawesome/capacitor-file-picker';
import { DirectoryReader } from '$lib/native/directory-reader';
import { YoutubeAudio, type PreparePcmResult } from '$lib/native/youtube-audio';
import { resolveYoutubeAudio } from './client';
import type { YoutubeQueueItem } from './queue';
import { clearSavePhase, markSavePhase } from './saveMarker';

/**
 * Save a YouTube track as an MP3 file on the device.
 *
 * The download and the AAC/Opus decode run in native Android code
 * (`YoutubeAudioPlugin`), which writes a 16-bit PCM file to the cache. JS pulls
 * that file in bounded chunks and feeds LAME (compiled to WASM by
 * `wasm-media-encoders`), then writes the MP3 into the folder the user picked.
 *
 * Why not `AudioContext.decodeAudioData`: it has to materialise the whole track
 * as PCM in the WebView (tens to hundreds of MB) and runs through the WebView
 * media decoder. Both of those crashed the app on device. Native decode plus
 * chunked PCM keeps peak memory small.
 */

export type SavePhase = 'picking' | 'resolving' | 'downloading' | 'encoding' | 'saving';

export interface SaveProgress {
	phase: SavePhase;
	/** 0..1 within the phase, or null when the phase has no measurable progress. */
	ratio: number | null;
}

const BASE64_CHUNK = 8192;
/** Bytes per SAF write call. A whole-song base64 string over the Capacitor bridge
 *  is what crashed the app, so the write is chunked like the PCM read. */
const WRITE_CHUNK_BYTES = 256 * 1024;
/** Frames per LAME call. 1152 is one MPEG frame; 32 frames per chunk keeps each
 *  WASM call small and each native read payload bounded. */
const FRAMES_PER_CHUNK = 1152 * 32;
/** LAME VBR quality 0 (best) to 9.999 (worst). 2 is a good size/quality balance. */
const MP3_VBR_QUALITY = 2;

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
	// Strip all whitespace: Capacitor's Android bridge returns Base64.DEFAULT.
	const binary = atob(payload.replace(/\s/g, ''));
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
	return bytes;
}

function yieldToUi(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Convert interleaved little-endian Int16 PCM into the planar float arrays LAME
 * wants. Exported because it is the one piece of the PCM path a unit test can
 * check without a device.
 */
export function interleavedInt16ToPlanarFloats(
	bytes: Uint8Array,
	channels: 1 | 2,
): { left: Float32Array; right: Float32Array | null } {
	const view = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.length / 2));
	const frames = Math.floor(view.length / channels);
	const left = new Float32Array(frames);
	const right = channels === 2 ? new Float32Array(frames) : null;
	for (let index = 0; index < frames; index += 1) {
		left[index] = view[index * channels] / 32768;
		if (right) right[index] = view[index * channels + 1] / 32768;
	}
	return { left, right };
}

/** Pull the decoded PCM from native in bounded chunks and encode it as MP3. */
export async function encodePcmToMp3(
	pcm: PreparePcmResult,
	onProgress?: (ratio: number) => void,
): Promise<Uint8Array> {
	// Loaded on demand so the WASM encoder stays out of the startup bundle.
	const { createMp3Encoder } = await import('wasm-media-encoders');
	const encoder = await createMp3Encoder();
	encoder.configure({ sampleRate: pcm.sampleRate, channels: pcm.channels, vbrQuality: MP3_VBR_QUALITY });

	const bytesPerFrame = 2 * pcm.channels;
	const chunkBytes = FRAMES_PER_CHUNK * bytesPerFrame;
	const totalBytes = pcm.samples * bytesPerFrame;
	const parts: Uint8Array[] = [];
	let total = 0;
	let offset = 0;

	for (;;) {
		const remaining = totalBytes - offset;
		if (remaining <= 0) break;
		const length = Math.min(chunkBytes, remaining);
		const { data, eof } = await YoutubeAudio.readPcmChunk({ path: pcm.path, offset, length });
		const bytes = bytesFromBase64(data);
		if (bytes.length === 0) break;

		offset += bytes.length;
		const { left, right } = interleavedInt16ToPlanarFloats(bytes, pcm.channels);
		// `out` is owned by the encoder and will be overwritten, so copy it.
		const out = right ? encoder.encode([left, right]) : encoder.encode([left]);
		const copy = out.slice();
		parts.push(copy);
		total += copy.length;
		onProgress?.(totalBytes > 0 ? Math.min(1, offset / totalBytes) : 0);
		if (eof) break;
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

/**
 * Persist the encoded MP3 into the SAF folder, one small chunk at a time.
 * A single base64 string of a whole song over the Capacitor bridge crashed the
 * app; 256 KB per call keeps every payload small.
 */
export async function writeMp3File(
	treeUri: string,
	fileName: string,
	mp3: Uint8Array,
	onProgress?: (ratio: number) => void,
): Promise<string> {
	try {
		await DirectoryReader.rememberTreeUri({ treeUri });
	} catch {
		// A transient grant is normally enough for the immediate writes below.
	}

	let path = '';
	for (let offset = 0; offset < mp3.length; offset += WRITE_CHUNK_BYTES) {
		const chunk = mp3.subarray(offset, offset + WRITE_CHUNK_BYTES);
		const result = await DirectoryReader.appendFileChunk({
			treeUri,
			fileName,
			mimeType: 'audio/mpeg',
			data: base64FromBytes(chunk),
			create: offset === 0,
		});
		path = result.path;
		onProgress?.(Math.min(1, (offset + chunk.length) / mp3.length));
	}
	return path;
}

export interface SaveYoutubeOptions {
	onProgress?: (progress: SaveProgress) => void;
}

/**
 * Pick a folder, download and decode the item natively, encode MP3 and write it
 * there. Resolves with the new file's URI.
 */
export async function saveYoutubeItemToMp3(
	item: YoutubeQueueItem,
	options: SaveYoutubeOptions = {},
): Promise<string> {
	const { onProgress } = options;
	try {
		onProgress?.({ phase: 'picking', ratio: null });
		markSavePhase('picking');
		const { path: treeUri } = await FilePicker.pickDirectory();

		onProgress?.({ phase: 'resolving', ratio: null });
		markSavePhase('resolving');
		const source = await resolveYoutubeAudio(item.videoId);

		onProgress?.({ phase: 'downloading', ratio: null });
		markSavePhase('downloading');
		const progressHandle = await YoutubeAudio.addListener('progress', (event) => {
			if (event.phase !== 'download') return;
			onProgress?.({
				phase: 'downloading',
				ratio: event.total > 0 ? event.received / event.total : null,
			});
		});

		let pcm: PreparePcmResult;
		try {
			pcm = await YoutubeAudio.preparePcm({ url: source.audioUrl, id: item.videoId });
		} finally {
			await progressHandle.remove();
		}

		try {
			onProgress?.({ phase: 'encoding', ratio: 0 });
			markSavePhase('encoding');
			const mp3Bytes = await encodePcmToMp3(pcm, (ratio) => {
				onProgress?.({ phase: 'encoding', ratio });
			});

			onProgress?.({ phase: 'saving', ratio: 0 });
			markSavePhase('saving');
			return await writeMp3File(
				treeUri,
				sanitizeMp3FileName(source.title || item.title),
				mp3Bytes,
				(ratio) => onProgress?.({ phase: 'saving', ratio }),
			);
		} finally {
			void YoutubeAudio.release({ id: item.videoId }).catch(() => {});
		}
	} finally {
		// Cleared on success and on a caught error. Only a crash leaves it behind.
		clearSavePhase();
	}
}
