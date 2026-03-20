/**
 * drive-config.ts
 *
 * Syncs a JSON config file named "media-hub-config.json" stored in the
 * Google Drive App Data folder (appDataFolder space — private to this app,
 * not visible in the user's Drive).
 *
 * Scope required: https://www.googleapis.com/auth/drive.appdata
 *
 * The config captures the portable parts of the user's preferences:
 *   - Favorite folders (Drive folder IDs + names)
 *   - Last selected Drive folder
 *   - Podcast subscriptions (feed URLs + metadata)
 *   - Podcast episode progress
 *   - Music playback settings (speed, EQ preset, sort order, etc.)
 *   - Podcast playback settings
 */

import type { PersistedPodcast } from '$lib/stores/settings.svelte';

export const DRIVE_APPDATA_SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
const CONFIG_FILE_NAME = 'media-hub-config.json';
const CONFIG_VERSION = 1;

export interface DriveConfigFavoriteFolder {
	id: string;
	name: string;
	source: 'device' | 'drive';
	treeUri?: string;
}

export interface DriveConfigMusicSettings {
	driveFolderId: string;
	driveFolderName: string;
	favoriteFolders: DriveConfigFavoriteFolder[];
	playbackSpeed: number;
	equalizerPreset: string;
	eqBands: number[];
	sortOrder: string;
	crossfadeDuration: number;
	volume: number;
	isShuffle: boolean;
	isRepeat: boolean;
}

export interface DriveConfigPodcastSettings {
	playbackSpeed: number;
	skipBackSeconds: number;
	skipForwardSeconds: number;
	autoPlayNext: boolean;
	trimSilence: boolean;
	boostVolume: boolean;
	defaultTab: string;
	markPlayedThreshold: number;
	autoMarkPlayed: boolean;
}

export interface DriveConfig {
	version: number;
	savedAt: string; // ISO timestamp
	music: DriveConfigMusicSettings;
	podcastSettings: DriveConfigPodcastSettings;
	podcasts: PersistedPodcast[];
	lastEpisodeId: string;
	lastPodcastId: number;
	lastPositionSec: number;
}

// ─── Low-level Drive API helpers ──────────────────────────────────────────────

async function appdataFetch<T>(
	path: string,
	accessToken: string,
	options?: RequestInit & { params?: URLSearchParams }
): Promise<T> {
	const query = options?.params?.toString();
	const url = `https://www.googleapis.com${path}${query ? `?${query}` : ''}`;
	const response = await fetch(url, {
		...options,
		headers: {
			Authorization: `Bearer ${accessToken}`,
			Accept: 'application/json',
			...(options?.headers ?? {}),
		},
	});
	if (!response.ok) {
		const text = await response.text().catch(() => '');
		throw new Error(text || `Drive appdata request failed: ${response.status}`);
	}
	if (response.status === 204) return undefined as T;
	return response.json() as Promise<T>;
}

/** Find the file ID of the config file in the appDataFolder, or null. */
async function findConfigFileId(accessToken: string): Promise<string | null> {
	const res = await appdataFetch<{ files?: { id: string }[] }>(
		'/drive/v3/files',
		accessToken,
		{
			params: new URLSearchParams({
				spaces: 'appDataFolder',
				q: `name = '${CONFIG_FILE_NAME}' and trashed = false`,
				fields: 'files(id)',
				pageSize: '1',
			}),
		}
	);
	return res.files?.[0]?.id ?? null;
}

/** Download and parse the config file. Returns null if not found. */
export async function downloadDriveConfig(accessToken: string): Promise<DriveConfig | null> {
	const fileId = await findConfigFileId(accessToken);
	if (!fileId) return null;

	const response = await fetch(
		`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
		{ headers: { Authorization: `Bearer ${accessToken}` } }
	);
	if (!response.ok) return null;

	try {
		return (await response.json()) as DriveConfig;
	} catch {
		return null;
	}
}

/** Upload (create or update) the config file. */
export async function uploadDriveConfig(accessToken: string, config: DriveConfig): Promise<void> {
	const existingId = await findConfigFileId(accessToken);
	const body = JSON.stringify(config, null, 2);
	const blob = new Blob([body], { type: 'application/json' });

	if (existingId) {
		// PATCH (update content only, keep metadata)
		const form = new FormData();
		form.append('file', blob, CONFIG_FILE_NAME);
		await fetch(
			`https://www.googleapis.com/upload/drive/v3/files/${existingId}?uploadType=multipart`,
			{
				method: 'PATCH',
				headers: { Authorization: `Bearer ${accessToken}` },
				body: buildMultipartBody({ name: CONFIG_FILE_NAME }, body),
			}
		);
	} else {
		// POST (create)
		await fetch(
			'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart',
			{
				method: 'POST',
				headers: { Authorization: `Bearer ${accessToken}` },
				body: buildMultipartBody(
					{ name: CONFIG_FILE_NAME, parents: ['appDataFolder'] },
					body
				),
			}
		);
	}
}

function buildMultipartBody(metadata: object, jsonContent: string): Blob {
	const boundary = '----MediaHubConfigBoundary';
	const metaPart =
		`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
		JSON.stringify(metadata) +
		`\r\n`;
	const dataPart =
		`--${boundary}\r\nContent-Type: application/json\r\n\r\n` +
		jsonContent +
		`\r\n--${boundary}--`;
	return new Blob([metaPart + dataPart], {
		type: `multipart/related; boundary=${boundary}`,
	});
}

// ─── Config serialization helpers ─────────────────────────────────────────────

export function buildDriveConfig(
	music: DriveConfigMusicSettings,
	podcastSettings: DriveConfigPodcastSettings,
	podcasts: PersistedPodcast[],
	lastEpisodeId: string,
	lastPodcastId: number,
	lastPositionSec: number,
): DriveConfig {
	return {
		version: CONFIG_VERSION,
		savedAt: new Date().toISOString(),
		music,
		podcastSettings,
		podcasts,
		lastEpisodeId,
		lastPodcastId,
		lastPositionSec,
	};
}
