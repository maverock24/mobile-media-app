import { PUBLIC_GOOGLE_CLIENT_ID } from '$env/static/public';

const GOOGLE_IDENTITY_SCRIPT_SRC = 'https://accounts.google.com/gsi/client';

export const GOOGLE_DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.readonly';

export interface GoogleDriveTokenResponse {
	access_token: string;
	expires_in?: number;
	error?: string;
	error_description?: string;
	scope?: string;
	token_type?: string;
}

export interface GoogleDriveUser {
	displayName: string;
	emailAddress: string;
	photoLink?: string;
}

export interface GoogleDriveFile {
	id: string;
	name: string;
	mimeType: string;
	fileExtension?: string;
	modifiedTime?: string;
	size?: string;
	webViewLink?: string;
}

export interface GoogleDriveFolder {
	id: string;
	name: string;
	mimeType: string;
	webViewLink?: string;
}

export interface GoogleDriveStreamSession {
	url: string;
	dispose: () => void;
}

let scriptPromise: Promise<void> | null = null;

function ensureBrowser() {
	if (typeof window === 'undefined' || typeof document === 'undefined') {
		throw new Error('Google Drive is only available in the browser.');
	}
}

function buildGoogleApiUrl(path: string, searchParams?: URLSearchParams): string {
	const query = searchParams && searchParams.toString().length > 0 ? `?${searchParams.toString()}` : '';
	return `https://www.googleapis.com${path}${query}`;
}

async function googleApiFetch<T>(path: string, accessToken: string, searchParams?: URLSearchParams): Promise<T> {
	const response = await fetch(buildGoogleApiUrl(path, searchParams), {
		headers: {
			Authorization: `Bearer ${accessToken}`,
			Accept: 'application/json'
		}
	});

	if (!response.ok) {
		const message = await response.text().catch(() => '');
		throw new Error(message || `Google API request failed with ${response.status}`);
	}

	return (await response.json()) as T;
}

export function isGoogleDriveConfigured(): boolean {
	return Boolean(getGoogleDriveClientId());
}

export function getGoogleDriveClientId(): string {
	const runtimeClientId = typeof window !== 'undefined' ? window.__GOOGLE_CLIENT_ID__?.trim() : '';
	return runtimeClientId || PUBLIC_GOOGLE_CLIENT_ID?.trim() || '';
}

export async function loadGoogleIdentityScript(): Promise<void> {
	ensureBrowser();

	if (window.google?.accounts?.oauth2) {
		return;
	}

	if (!scriptPromise) {
		scriptPromise = new Promise<void>((resolve, reject) => {
			const existing = document.querySelector<HTMLScriptElement>(`script[src="${GOOGLE_IDENTITY_SCRIPT_SRC}"]`);

			if (existing) {
				existing.addEventListener('load', () => resolve(), { once: true });
				existing.addEventListener('error', () => reject(new Error('Unable to load Google Identity Services.')), {
					once: true
				});
				return;
			}

			const script = document.createElement('script');
			script.src = GOOGLE_IDENTITY_SCRIPT_SRC;
			script.async = true;
			script.defer = true;
			script.onload = () => resolve();
			script.onerror = () => reject(new Error('Unable to load Google Identity Services.'));
			document.head.appendChild(script);
		});
	}

	return scriptPromise;
}

export async function requestGoogleDriveAccessToken(options?: {
	clientId?: string;
	prompt?: string;
}): Promise<GoogleDriveTokenResponse> {
	const clientId = options?.clientId?.trim() || getGoogleDriveClientId();

	if (!clientId) {
		throw new Error('PUBLIC_GOOGLE_CLIENT_ID is not configured.');
	}

	await loadGoogleIdentityScript();

	return await new Promise<GoogleDriveTokenResponse>((resolve, reject) => {
		const tokenClient = window.google?.accounts?.oauth2.initTokenClient({
			client_id: clientId,
			scope: GOOGLE_DRIVE_SCOPE,
			callback: (response) => {
				if (!response?.access_token || response.error) {
					reject(new Error(response?.error_description || response?.error || 'Unable to authorize Google Drive access.'));
					return;
				}

				resolve({
					access_token: response.access_token,
					expires_in: response.expires_in,
					error: response.error,
					error_description: response.error_description,
					scope: response.scope,
					token_type: response.token_type,
				});
			},
			error_callback: (error) => {
				reject(new Error(error.type || 'Google authentication was interrupted.'));
			}
		});

		if (!tokenClient) {
			reject(new Error('Google Identity Services is unavailable.'));
			return;
		}

		tokenClient.requestAccessToken({ prompt: options?.prompt ?? '' });
	});
}

export async function revokeGoogleDriveAccess(accessToken: string): Promise<void> {
	if (!accessToken) {
		return;
	}

	await loadGoogleIdentityScript();

	await new Promise<void>((resolve) => {
		window.google?.accounts?.oauth2.revoke(accessToken, () => resolve());
	});
}

export async function fetchGoogleDriveUser(accessToken: string): Promise<GoogleDriveUser> {
	const response = await googleApiFetch<{ user: GoogleDriveUser }>('/drive/v3/about', accessToken, new URLSearchParams({
		fields: 'user(displayName,emailAddress,photoLink)'
	}));

	return response.user;
}

export async function fetchGoogleDriveFolder(accessToken: string, folderId: string): Promise<GoogleDriveFolder> {
	const normalizedFolderId = folderId.trim();
	if (!normalizedFolderId) {
		throw new Error('Google Drive folder ID is required.');
	}

	return await googleApiFetch<GoogleDriveFolder>(`/drive/v3/files/${normalizedFolderId}`, accessToken, new URLSearchParams({
		fields: 'id,name,mimeType,webViewLink'
	}));
}

export async function listGoogleDriveMp3Files(
	accessToken: string,
	options?: { folderId?: string }
): Promise<GoogleDriveFile[]> {
	const files: GoogleDriveFile[] = [];
	let pageToken = '';
	const folderId = options?.folderId?.trim();

	do {
		const query = folderId
			? `trashed = false and '${folderId}' in parents and mimeType contains 'audio/'`
			: "trashed = false and mimeType contains 'audio/'";

		const searchParams = new URLSearchParams({
			fields: 'nextPageToken,files(id,name,mimeType,fileExtension,modifiedTime,size,webViewLink)',
			pageSize: '200',
			q: query,
			spaces: 'drive',
			orderBy: 'name_natural'
		});

		if (pageToken) {
			searchParams.set('pageToken', pageToken);
		}

		const response = await googleApiFetch<{ nextPageToken?: string; files?: GoogleDriveFile[] }>(
			'/drive/v3/files',
			accessToken,
			searchParams
		);

		files.push(...(response.files ?? []).filter((file) => {
			const extension = file.fileExtension?.toLowerCase();
			return extension === 'mp3' || file.mimeType === 'audio/mpeg' || file.name.toLowerCase().endsWith('.mp3');
		}));

		pageToken = response.nextPageToken ?? '';
	} while (pageToken);

	return files;
}

function getSupportedStreamMimeType(mimeType?: string): string | null {
	if (typeof window === 'undefined' || typeof MediaSource === 'undefined') {
		return null;
	}

	const candidates = [mimeType, 'audio/mpeg', 'audio/mp3'].filter((value, index, values): value is string => {
		return Boolean(value) && values.indexOf(value) === index;
	});

	for (const candidate of candidates) {
		if (MediaSource.isTypeSupported(candidate)) {
			return candidate;
		}
	}

	return null;
}

function waitForSourceBufferIdle(sourceBuffer: SourceBuffer): Promise<void> {
	if (!sourceBuffer.updating) {
		return Promise.resolve();
	}

	return new Promise<void>((resolve) => {
		const handleUpdateEnd = () => {
			sourceBuffer.removeEventListener('updateend', handleUpdateEnd);
			resolve();
		};

		sourceBuffer.addEventListener('updateend', handleUpdateEnd, { once: true });
	});
}

export function canStreamGoogleDriveFile(mimeType?: string): boolean {
	return getSupportedStreamMimeType(mimeType) !== null;
}

export async function createGoogleDriveStreamSession(options: {
	accessToken: string;
	fileId: string;
	mimeType?: string;
}): Promise<GoogleDriveStreamSession> {
	const supportedMimeType = getSupportedStreamMimeType(options.mimeType);

	if (!supportedMimeType) {
		throw new Error('Streaming is not supported for this audio format in the current browser.');
	}

	const mediaSource = new MediaSource();
	const url = URL.createObjectURL(mediaSource);
	const abortController = new AbortController();
	let disposed = false;

	const dispose = () => {
		if (disposed) {
			return;
		}

		disposed = true;
		abortController.abort();

		try {
			if (mediaSource.readyState === 'open') {
				mediaSource.endOfStream();
			}
		} catch {
			// Ignore teardown failures during track changes.
		}
	};

	mediaSource.addEventListener('sourceopen', () => {
		void (async () => {
			try {
				const sourceBuffer = mediaSource.addSourceBuffer(supportedMimeType);
				sourceBuffer.mode = 'sequence';

				const response = await fetch(`https://www.googleapis.com/drive/v3/files/${options.fileId}?alt=media`, {
					headers: {
						Authorization: `Bearer ${options.accessToken}`
					},
					signal: abortController.signal
				});

				if (!response.ok) {
					const message = await response.text().catch(() => '');
					throw new Error(message || `Unable to stream Google Drive file (${response.status}).`);
				}

				if (!response.body) {
					const buffer = await response.arrayBuffer();
					await waitForSourceBufferIdle(sourceBuffer);
					sourceBuffer.appendBuffer(buffer);
					await waitForSourceBufferIdle(sourceBuffer);
					if (!disposed && mediaSource.readyState === 'open') {
						mediaSource.endOfStream();
					}
					return;
				}

				const reader = response.body.getReader();

				while (!disposed) {
					const { done, value } = await reader.read();
					if (done) {
						break;
					}

					if (!value || value.byteLength === 0) {
						continue;
					}

					await waitForSourceBufferIdle(sourceBuffer);
					sourceBuffer.appendBuffer(value);
				}

				await waitForSourceBufferIdle(sourceBuffer);
				if (!disposed && mediaSource.readyState === 'open') {
					mediaSource.endOfStream();
				}
			} catch (error) {
				if (abortController.signal.aborted) {
					return;
				}

				console.error('Google Drive streaming failed.', error);
				try {
					if (mediaSource.readyState === 'open') {
						mediaSource.endOfStream('network');
					}
				} catch {
					// Ignore stream shutdown failures after an upstream error.
				}
			}
		})();
	}, { once: true });

	return { url, dispose };
}

export async function downloadGoogleDriveFile(options: {
	accessToken: string;
	fileId: string;
	fileName: string;
	mimeType?: string;
	modifiedAt?: number;
}): Promise<File> {
	const response = await fetch(`https://www.googleapis.com/drive/v3/files/${options.fileId}?alt=media`, {
		headers: {
			Authorization: `Bearer ${options.accessToken}`
		}
	});

	if (!response.ok) {
		const message = await response.text().catch(() => '');
		throw new Error(message || `Unable to download Google Drive file (${response.status}).`);
	}

	const blob = await response.blob();
	return new File([blob], options.fileName, {
		type: options.mimeType ?? blob.type ?? 'audio/mpeg',
		lastModified: options.modifiedAt ?? Date.now()
	});
}