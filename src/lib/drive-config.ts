/**
 * drive-config.ts
 *
 * Syncs a JSON config file named "media-hub-config.json" stored in the
 * Google Drive App Data folder (appDataFolder space — private to this app,
 * not visible in the user's Drive).
 *
 * Scope required: https://www.googleapis.com/auth/drive.appdata
 *
 * Version history:
 *   v1 — original (music, podcasts, podcast settings)
 *   v2 — added: mp3TrackPositions, appSettings, weatherSettings
 */

import type { PersistedPodcast, SavedCity } from '$lib/stores/settings.svelte';

export const DRIVE_APPDATA_SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
const CONFIG_FILE_NAME = 'media-hub-config.json';
const CONFIG_VERSION = 2;

// ─── Typed error for HTTP status differentiation ──────────────────────────────

export class DriveApiError extends Error {
	constructor(
		public readonly status: number,
		message: string,
	) {
		super(message);
		this.name = 'DriveApiError';
	}
	get isAuthError()    { return this.status === 401 || this.status === 403; }
	get isNotFound()     { return this.status === 404; }
	get isRateLimited()  { return this.status === 429; }
}

// ─── Interfaces ───────────────────────────────────────────────────────────────

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

export interface DriveConfigAppSettings {
	theme: string;
	accentColor: string;
	fontSize: string;
	reducedMotion: boolean;
	hapticFeedback: boolean;
}

export interface DriveConfigWeatherSettings {
	units: 'C' | 'F';
	savedCities: SavedCity[];
	activeCity: string;
	windUnit: 'kmh' | 'mph' | 'ms';
	showHourly: boolean;
	show7Day: boolean;
	showHumidity: boolean;
	showWind: boolean;
	showVisibility: boolean;
	showFeelsLike: boolean;
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
	// v2 additions
	mp3TrackPositions?: Record<string, number>;
	appSettings?: DriveConfigAppSettings;
	weatherSettings?: DriveConfigWeatherSettings;
}

// ─── Schema validation ────────────────────────────────────────────────────────

/** Returns a validated + migrated DriveConfig, or null if the payload is corrupt. */
export function validateAndMigrateDriveConfig(raw: unknown): DriveConfig | null {
	if (!raw || typeof raw !== 'object') return null;
	const obj = raw as Record<string, unknown>;

	// Must have version and savedAt at minimum
	if (typeof obj.version !== 'number') return null;
	if (typeof obj.savedAt !== 'string') return null;

	// Migrate v1 → v2: mp3TrackPositions, appSettings, weatherSettings are optional → OK
	// Future migrations go here as version increments

	// Basic structural checks
	if (obj.music !== undefined && typeof obj.music !== 'object') return null;
	if (obj.podcastSettings !== undefined && typeof obj.podcastSettings !== 'object') return null;
	if (obj.podcasts !== undefined && !Array.isArray(obj.podcasts)) return null;

	return obj as unknown as DriveConfig;
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
		throw new DriveApiError(response.status, text || `Drive API error: ${response.status}`);
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

/** Download and parse the config file. Returns null if not found. Throws DriveApiError on HTTP errors. */
export async function downloadDriveConfig(accessToken: string): Promise<DriveConfig | null> {
	const fileId = await findConfigFileId(accessToken);
	if (!fileId) return null;

	const response = await fetch(
		`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
		{ headers: { Authorization: `Bearer ${accessToken}` } }
	);

	if (!response.ok) {
		const text = await response.text().catch(() => '');
		throw new DriveApiError(response.status, text || `Drive download failed: ${response.status}`);
	}

	let parsed: unknown;
	try {
		parsed = await response.json();
	} catch {
		throw new Error('Drive config file contains invalid JSON');
	}

	const config = validateAndMigrateDriveConfig(parsed);
	if (!config) throw new Error('Drive config file has an unexpected format');
	return config;
}

/**
 * Upload (create or update) the config file.
 * Throws DriveApiError on HTTP errors so callers can handle auth vs rate-limit vs other.
 */
export async function uploadDriveConfig(accessToken: string, config: DriveConfig): Promise<void> {
	const existingId = await findConfigFileId(accessToken);
	const body = JSON.stringify(config, null, 2);
	// Use a random boundary to avoid any collision with JSON content
	const boundary = `MediaHubBoundary${Math.random().toString(36).slice(2)}`;

	if (existingId) {
		const res = await fetch(
			`https://www.googleapis.com/upload/drive/v3/files/${existingId}?uploadType=multipart`,
			{
				method: 'PATCH',
				headers: { Authorization: `Bearer ${accessToken}` },
				body: buildMultipartBody({ name: CONFIG_FILE_NAME }, body, boundary),
			}
		);
		if (!res.ok) {
			const text = await res.text().catch(() => '');
			throw new DriveApiError(res.status, text || `Drive upload failed: ${res.status}`);
		}
	} else {
		const res = await fetch(
			'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart',
			{
				method: 'POST',
				headers: { Authorization: `Bearer ${accessToken}` },
				body: buildMultipartBody(
					{ name: CONFIG_FILE_NAME, parents: ['appDataFolder'] },
					body,
					boundary,
				),
			}
		);
		if (!res.ok) {
			const text = await res.text().catch(() => '');
			throw new DriveApiError(res.status, text || `Drive create failed: ${res.status}`);
		}
	}
}

function buildMultipartBody(metadata: object, jsonContent: string, boundary: string): Blob {
	const metaPart =
		`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
		JSON.stringify(metadata) +
		`\r\n`;
	const dataPart =
		`--${boundary}\r\nContent-Type: application/json\r\n\r\n` +
		jsonContent +
		`\r\n--${boundary}--`;
	return new Blob([metaPart + dataPart], {
		type: `multipart/related; boundary="${boundary}"`,
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
	mp3TrackPositions: Record<string, number>,
	appSettings: DriveConfigAppSettings,
	weatherSettings: DriveConfigWeatherSettings,
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
		mp3TrackPositions,
		appSettings,
		weatherSettings,
	};
}
