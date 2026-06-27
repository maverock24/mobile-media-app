import { Capacitor } from '@capacitor/core';
import { Filesystem } from '@capacitor/filesystem';
import { downloadGoogleDriveFile } from '$lib/google-drive';
import { googleDriveSession } from '$lib/stores/googleDriveSession.svelte';
import type { StoredAudioFile } from '$lib/stores/library.svelte';

export interface ResolvedAudio {
	/** A URL the <audio> element can load (object URL, Capacitor bridge URL, …). */
	url: string;
	/** Release any object URL created for this resolution. Safe to call repeatedly. */
	revoke: () => void;
}

export function bytesFromBase64(data: string): Uint8Array {
	const base64 = data.includes(',') ? (data.split(',').pop() ?? '') : data;
	const normalized = base64.replace(/\s/g, '');
	const binary = atob(normalized);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

export function arrayBufferFromBytes(bytes: Uint8Array): ArrayBuffer {
	return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export async function blobFromNativePath(path: string, mimeType?: string): Promise<Blob> {
	try {
		const result = await Filesystem.readFile({ path });
		if (result.data instanceof Blob) return result.data;
		return new Blob([arrayBufferFromBytes(bytesFromBase64(result.data))], { type: mimeType ?? 'audio/mpeg' });
	} catch {
		// Fall back to HTTP bridge reads below.
	}

	const candidates = [Capacitor.convertFileSrc(path), path];
	for (const candidate of candidates) {
		try {
			const response = await fetch(candidate);
			if (response.ok) return await response.blob();
		} catch {
			// try next candidate
		}
	}
	throw new Error(`Unable to read selected file at ${path}`);
}

/**
 * Resolve a library file (web / native device / Google Drive) into a URL that an
 * HTMLAudioElement can play. Mirrors Mp3PlayerView's resolution logic but is
 * self-contained so it can be reused (e.g. by the Mixer) without coupling to the
 * music view's component state.
 */
export async function resolveStoredFileToUrl(file: StoredAudioFile): Promise<ResolvedAudio> {
	if (file.source === 'web') {
		const url = URL.createObjectURL(file.file);
		return { url, revoke: () => URL.revokeObjectURL(url) };
	}

	if (file.source === 'native') {
		// Fast path: Capacitor exposes a local HTTP bridge URL that streams the file
		// progressively (range requests) — no need to read it fully into memory.
		const bridge = Capacitor.convertFileSrc(file.path);
		if (bridge && bridge !== file.path) {
			return { url: bridge, revoke: () => {} };
		}
		const blob = await blobFromNativePath(file.path, file.mimeType);
		const url = URL.createObjectURL(blob);
		return { url, revoke: () => URL.revokeObjectURL(url) };
	}

	// Google Drive
	const accessToken = googleDriveSession.accessToken;
	if (!accessToken) {
		throw new Error('Your Google Drive session has expired. Sign in again to continue.');
	}
	const downloaded = await downloadGoogleDriveFile({
		accessToken,
		fileId: file.fileId,
		fileName: file.name,
		mimeType: file.mimeType,
		modifiedAt: file.modifiedAt,
	});
	const url = URL.createObjectURL(downloaded);
	return { url, revoke: () => URL.revokeObjectURL(url) };
}
