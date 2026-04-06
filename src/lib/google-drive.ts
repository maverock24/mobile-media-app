import { PUBLIC_GOOGLE_CLIENT_ID } from '$env/static/public';

const GOOGLE_IDENTITY_SCRIPT_SRC = 'https://accounts.google.com/gsi/client';

export const GOOGLE_DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
// Note: config sync uses drive.appdata scope — see src/lib/drive-config.ts

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
	/** Relative path within the selected root folder, e.g. "Rock/song.mp3". Set during BFS. */
	relativePath?: string;
}

export interface GoogleDriveFolder {
	id: string;
	name: string;
	mimeType: string;
	webViewLink?: string;
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
	const MAX_RETRIES = 3;
	for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
		const response = await fetch(buildGoogleApiUrl(path, searchParams), {
			headers: {
				Authorization: `Bearer ${accessToken}`,
				Accept: 'application/json'
			}
		});

		if (response.status === 429 || response.status === 403) {
			if (attempt < MAX_RETRIES) {
				const delay = Math.min(2 ** attempt * 1000, 30_000);
				await new Promise(r => setTimeout(r, delay));
				continue;
			}
		}

		if (!response.ok) {
			const message = await response.text().catch(() => '');
			throw new Error(message || `Google API request failed with ${response.status}`);
		}

		return (await response.json()) as T;
	}

	throw new Error('Google API request failed after retries');
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

export async function listGoogleDriveFolders(
	accessToken: string,
	parentId?: string
): Promise<GoogleDriveFolder[]> {
	const parent = parentId?.trim() || 'root';
	const response = await googleApiFetch<{ files?: GoogleDriveFolder[] }>(
		'/drive/v3/files',
		accessToken,
		new URLSearchParams({
			q: `trashed = false and mimeType = 'application/vnd.google-apps.folder' and '${parent}' in parents`,
			fields: 'files(id,name,mimeType,webViewLink)',
			pageSize: '100',
			orderBy: 'name',
			spaces: 'drive'
		})
	);
	return response.files ?? [];
}

export async function checkFolderHasSubfolders(accessToken: string, folderId: string): Promise<boolean> {
	const response = await googleApiFetch<{ files?: { id: string }[] }>(
		'/drive/v3/files',
		accessToken,
		new URLSearchParams({
			q: `trashed = false and mimeType = 'application/vnd.google-apps.folder' and '${folderId}' in parents`,
			fields: 'files(id)',
			pageSize: '1',
			spaces: 'drive'
		})
	);
	return (response.files?.length ?? 0) > 0;
}

function isMp3File(file: GoogleDriveFile): boolean {
	const extension = file.fileExtension?.toLowerCase();
	return extension === 'mp3' || file.mimeType === 'audio/mpeg' || file.name.toLowerCase().endsWith('.mp3');
}

async function fetchMp3FilesInFolder(accessToken: string, folderId: string): Promise<GoogleDriveFile[]> {
	const files: GoogleDriveFile[] = [];
	let pageToken = '';
	do {
		const searchParams = new URLSearchParams({
			q: `trashed = false and '${folderId}' in parents and mimeType contains 'audio/'`,
			fields: 'nextPageToken,files(id,name,mimeType,fileExtension,modifiedTime,size,webViewLink)',
			pageSize: '200',
			spaces: 'drive',
			orderBy: 'name_natural'
		});
		if (pageToken) searchParams.set('pageToken', pageToken);
		const response = await googleApiFetch<{ nextPageToken?: string; files?: GoogleDriveFile[] }>(
			'/drive/v3/files', accessToken, searchParams
		);
		files.push(...(response.files ?? []).filter(isMp3File));
		pageToken = response.nextPageToken ?? '';
	} while (pageToken);
	return files;
}

async function fetchSubfolderEntries(accessToken: string, folderId: string): Promise<{ id: string; name: string }[]> {
	const entries: { id: string; name: string }[] = [];
	let pageToken = '';
	do {
		const searchParams = new URLSearchParams({
			q: `trashed = false and mimeType = 'application/vnd.google-apps.folder' and '${folderId}' in parents`,
			fields: 'nextPageToken,files(id,name)',
			pageSize: '100',
			spaces: 'drive'
		});
		if (pageToken) searchParams.set('pageToken', pageToken);
		const response = await googleApiFetch<{ nextPageToken?: string; files?: { id: string; name: string }[] }>(
			'/drive/v3/files', accessToken, searchParams
		);
		entries.push(...(response.files ?? []));
		pageToken = response.nextPageToken ?? '';
	} while (pageToken);
	return entries;
}

export type DriveScanBatch = {
	files: GoogleDriveFile[];
	foldersScanned: number;
	foldersQueued: number;
};

// Number of Drive folders fetched concurrently during BFS traversal.
const DRIVE_SCAN_CONCURRENCY = 3;

/**
 * Streams MP3 files from a Google Drive folder tree using concurrent BFS.
 * Yields batches as each round of folders is scanned so the UI can update progressively.
 */
export async function* streamGoogleDriveMp3Files(
	accessToken: string,
	options?: { folderId?: string; signal?: AbortSignal }
): AsyncGenerator<DriveScanBatch> {
	const rootFolderId = options?.folderId?.trim();
	const signal = options?.signal;

	if (!rootFolderId) {
		// No folder filter: flat search of entire Drive, yield page by page
		let pageToken = '';
		do {
			if (signal?.aborted) return;
			const searchParams = new URLSearchParams({
				q: "trashed = false and mimeType contains 'audio/'",
				fields: 'nextPageToken,files(id,name,mimeType,fileExtension,modifiedTime,size,webViewLink)',
				pageSize: '200',
				spaces: 'drive',
				orderBy: 'name_natural'
			});
			if (pageToken) searchParams.set('pageToken', pageToken);
			const response = await googleApiFetch<{ nextPageToken?: string; files?: GoogleDriveFile[] }>(
				'/drive/v3/files', accessToken, searchParams
			);
			const batch = (response.files ?? []).filter(isMp3File);
			pageToken = response.nextPageToken ?? '';
			yield { files: batch, foldersScanned: 1, foldersQueued: pageToken ? 1 : 0 };
		} while (pageToken);
		return;
	}

	// Concurrent BFS: process up to DRIVE_SCAN_CONCURRENCY folders simultaneously per round.
	type QueueEntry = { id: string; path: string[] };
	const pending: QueueEntry[] = [{ id: rootFolderId, path: [] }];
	let foldersScanned = 0;

	while (pending.length > 0) {
		if (signal?.aborted) return;

		// Take up to CONCURRENCY folders from the front of the queue
		const round = pending.splice(0, DRIVE_SCAN_CONCURRENCY);

		const results = await Promise.all(
			round.map(({ id, path }) =>
				Promise.all([
					fetchMp3FilesInFolder(accessToken, id),
					fetchSubfolderEntries(accessToken, id)
				]).then(([files, subfolders]) => ({ path, files, subfolders }))
			)
		);

		const batchFiles: GoogleDriveFile[] = [];
		for (const { path, files, subfolders } of results) {
			for (const file of files) {
				file.relativePath = path.length > 0 ? [...path, file.name].join('/') : file.name;
			}
			batchFiles.push(...files);
			foldersScanned++;
			for (const sub of subfolders) {
				pending.push({ id: sub.id, path: [...path, sub.name] });
			}
		}

		yield { files: batchFiles, foldersScanned, foldersQueued: pending.length };
	}
}

export async function listGoogleDriveMp3Files(
	accessToken: string,
	options?: { folderId?: string }
): Promise<GoogleDriveFile[]> {
	const all: GoogleDriveFile[] = [];
	for await (const batch of streamGoogleDriveMp3Files(accessToken, options)) {
		all.push(...batch.files);
	}
	return all;
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