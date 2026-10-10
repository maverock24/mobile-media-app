import { FilePicker } from '@capawesome/capacitor-file-picker';
import { DirectoryReader } from '$lib/native/directory-reader';
import { YoutubeAudio, type DownloadResult } from '$lib/native/youtube-audio';
import { resolveYoutubeDownload } from './client';
import type { YoutubeQueueItem } from './queue';
import { clearSavePhase, markSavePhase } from './saveMarker';

/**
 * Save a YouTube track to a folder on the device.
 *
 * The bytes are written exactly as YouTube serves them, which is AAC in an MP4
 * container (`.m4a`), one of the extensions the app's own player reads. There is
 * no decode and no re-encode: the previous implementation ran native
 * `MediaCodec` decode into a cache file, pulled all of it back through the
 * Capacitor bridge as base64 to feed LAME, and then wrote the result out again.
 * That path needed tens of megabytes of scratch space, hundreds of bridge round
 * trips per track, and it crashed on device.
 *
 * Now the download runs natively (`YoutubeAudioPlugin`) because googlevideo
 * sends no CORS headers, and JS copies the cached file into the picked folder in
 * bounded chunks. Peak memory is one chunk and its base64 copy.
 */

export type SavePhase = 'picking' | 'resolving' | 'downloading' | 'saving';

export interface SaveProgress {
	phase: SavePhase;
	/** 0..1 within the phase, or null when the phase has no measurable progress. */
	ratio: number | null;
}

const BASE64_CHUNK = 8192;
/** Bytes per local read and per SAF write. Keeps every Capacitor bridge payload
 *  far below the size that has historically killed the WebView. */
const CHUNK_BYTES = 256 * 1024;

/** Replace characters Android SAF and common media scanners reject. */
export function sanitizeAudioFileName(title: string, extension: string): string {
	const cleaned = title
		// eslint-disable-next-line no-control-regex
		.replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
		.replace(/\s+/g, ' ')
		.trim()
		.replace(/\.+$/, '')
		.slice(0, 120)
		.trim();
	const base = cleaned || 'YouTube audio';
	const suffix = `.${extension}`;
	return base.toLowerCase().endsWith(suffix) ? base : `${base}${suffix}`;
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

export interface WriteDownloadedFileOptions {
	treeUri: string;
	fileName: string;
	mimeType: string;
	/** Absolute path of the file the native plugin downloaded into the cache. */
	sourcePath: string;
	/** Size the native side reported. The write is verified against it. */
	size: number;
	onProgress?: (ratio: number) => void;
}

/**
 * Copy a downloaded file into the picked folder, one bounded chunk at a time.
 * The first write creates the document and the rest append, so the WebView
 * never holds the whole track and no single bridge payload is large.
 */
export async function writeDownloadedFile(options: WriteDownloadedFileOptions): Promise<string> {
	const { treeUri, fileName, mimeType, sourcePath, size, onProgress } = options;
	try {
		await DirectoryReader.rememberTreeUri({ treeUri });
	} catch {
		// A transient grant is normally enough for the immediate writes below.
	}

	let written = 0;
	let path = '';
	for (let offset = 0; offset < size; offset += CHUNK_BYTES) {
		const length = Math.min(CHUNK_BYTES, size - offset);
		const chunk = await YoutubeAudio.readFileChunk({ path: sourcePath, offset, length });
		if (chunk.bytesRead === 0) break;

		const result = await DirectoryReader.appendFileChunk({
			treeUri,
			fileName,
			mimeType,
			// Already base64 from the native read; re-encoding it here would only
			// add a decode and an encode per chunk.
			data: chunk.data,
			create: written === 0,
		});
		path = result.path;
		written += chunk.bytesRead;
		onProgress?.(size > 0 ? Math.min(1, written / size) : 0);
		await yieldToUi();
	}

	if (written !== size) {
		// A short file is worse than a failed save: it looks like a track and is
		// not one. The append path cannot truncate afterwards, so report instead.
		throw new Error(`Only ${written} of ${size} bytes could be written.`);
	}
	return path;
}

export interface SaveYoutubeOptions {
	onProgress?: (progress: SaveProgress) => void;
}

/**
 * Pick a folder, download the item natively, then copy it there.
 * Resolves with the new document's URI.
 */
export async function saveYoutubeItem(
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
		const source = await resolveYoutubeDownload(item.videoId);

		onProgress?.({ phase: 'downloading', ratio: 0 });
		markSavePhase('downloading');
		const progressHandle = await YoutubeAudio.addListener('progress', (event) => {
			onProgress?.({
				phase: 'downloading',
				ratio: event.total > 0 ? event.received / event.total : null,
			});
		});

		let downloaded: DownloadResult;
		try {
			downloaded = await YoutubeAudio.download({
				url: source.audioUrl,
				id: item.videoId,
				expectedBytes: source.contentLength ?? undefined,
			});
		} finally {
			await progressHandle.remove();
		}

		try {
			onProgress?.({ phase: 'saving', ratio: 0 });
			markSavePhase('saving');
			return await writeDownloadedFile({
				treeUri,
				fileName: sanitizeAudioFileName(source.title || item.title, source.extension),
				mimeType: source.mimeType,
				sourcePath: downloaded.path,
				size: downloaded.size,
				onProgress: (ratio) => onProgress?.({ phase: 'saving', ratio }),
			});
		} finally {
			void YoutubeAudio.release({ id: item.videoId }).catch(() => {});
		}
	} finally {
		// Cleared on success and on a caught error. Only a crash leaves it behind.
		clearSavePhase();
	}
}
