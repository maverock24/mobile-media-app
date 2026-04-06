/**
 * driveConfigSync.svelte.ts
 *
 * Svelte 5 rune-based store that manages the Drive appdata access token
 * and exposes upload/download helpers with:
 *   - Token refresh (re-requests silently when < 5 min remaining)
 *   - Conflict resolution via savedAt timestamp (last-write-wins)
 *   - Offline queue: pending save is replayed on reconnect
 *   - Differentiated error handling (auth vs rate-limit vs other)
 *   - Full settings sync: music, podcasts, mp3TrackPositions, appSettings, weatherSettings
 */

import {
	DRIVE_APPDATA_SCOPE,
	DriveApiError,
	downloadDriveConfig,
	uploadDriveConfig,
	buildDriveConfig,
	type DriveConfig,
} from '$lib/drive-config';
import { loadGoogleIdentityScript, getGoogleDriveClientId } from '$lib/google-drive';
import {
	musicSettings,
	podcastSettings,
	podcastData,
	mp3TrackPositions,
	appSettings,
	weatherSettings,
} from '$lib/stores/settings.svelte';

export type SyncStatus = 'idle' | 'syncing' | 'saved' | 'error';

// ISO timestamp of the last local write — updated whenever save() is called
// Used for conflict resolution: only apply Drive config if it's newer.
let localSavedAt = '';

class DriveConfigSync {
	accessToken  = $state('');
	expiresAt    = $state(0);
	expiresIn    = $state(3600); // seconds, from OAuth response
	status       = $state<SyncStatus>('idle');
	lastSyncedAt = $state<Date | null>(null);
	errorMessage = $state('');

	/** True when an offline save is waiting to be flushed. */
	pendingSave  = $state(false);

	private saveTimer: ReturnType<typeof setTimeout> | null = null;
	private refreshTimer: ReturnType<typeof setTimeout> | null = null;

	get isConnected() {
		return this.accessToken.length > 0 && Date.now() < this.expiresAt - 60_000;
	}

	// ─── Auth ──────────────────────────────────────────────────────────────────

	/** Request an appdata-scoped token (may prompt the user). */
	async connect(interactive = true): Promise<boolean> {
		try {
			const clientId = getGoogleDriveClientId();
			if (!clientId) return false;

			await loadGoogleIdentityScript();

			const { token, expiresIn } = await new Promise<{ token: string; expiresIn: number }>((resolve, reject) => {
				const client = window.google?.accounts?.oauth2.initTokenClient({
					client_id: clientId,
					scope: DRIVE_APPDATA_SCOPE,
					callback: (resp: { access_token?: string; expires_in?: number; error?: string; error_description?: string }) => {
						if (resp?.access_token) {
							resolve({ token: resp.access_token, expiresIn: resp.expires_in ?? 3600 });
						} else {
							reject(new Error(resp?.error_description || resp?.error || 'appdata auth failed'));
						}
					},
					error_callback: (e: { type?: string }) => reject(new Error(e.type || 'auth interrupted')),
				});
				if (!client) { reject(new Error('Google Identity unavailable')); return; }
				// interactive=true: show UI only when needed (not 'consent' which forces screen every time)
				// interactive=false: 'none' ensures truly silent — no popup, fails if unable
				client.requestAccessToken({ prompt: interactive ? '' : 'none' });
			});

			this._storeToken(token, expiresIn);
			return true;
		} catch {
			return false;
		}
	}

	/** Silently refresh the token (no user prompt). Returns true if successful. */
	async silentRefresh(): Promise<boolean> {
		try {
			const clientId = getGoogleDriveClientId();
			if (!clientId) return false;

			await loadGoogleIdentityScript();

			const { token, expiresIn } = await new Promise<{ token: string; expiresIn: number }>((resolve, reject) => {
				const client = window.google?.accounts?.oauth2.initTokenClient({
					client_id: clientId,
					scope: DRIVE_APPDATA_SCOPE,
					callback: (resp: { access_token?: string; expires_in?: number; error?: string; error_description?: string }) => {
						if (resp?.access_token) {
							resolve({ token: resp.access_token, expiresIn: resp.expires_in ?? 3600 });
						} else {
							reject(new Error(resp?.error_description || resp?.error || 'silent refresh failed'));
						}
					},
					error_callback: (e: { type?: string }) => reject(new Error(e.type || 'silent refresh interrupted')),
				});
				if (!client) { reject(new Error('Google Identity unavailable')); return; }
				// 'none' = truly silent: returns error instead of showing a popup
				client.requestAccessToken({ prompt: 'none' });
			});

			this._storeToken(token, expiresIn);
			return true;
		} catch {
			return false;
		}
	}

	private _storeToken(token: string, expiresIn: number) {
		this.accessToken = token;
		this.expiresIn   = expiresIn;
		this.expiresAt   = Date.now() + expiresIn * 1000;

		// Schedule a silent refresh at 80% of the token lifetime (before 60s guard fires)
		const refreshAfterMs = Math.max(0, (expiresIn * 0.8 - 60) * 1000);
		if (this.refreshTimer) clearTimeout(this.refreshTimer);
		this.refreshTimer = setTimeout(async () => {
			this.refreshTimer = null;
			const ok = await this.silentRefresh();
			if (ok && this.pendingSave) {
				// Flush offline queue now that we have a fresh token
				this.pendingSave = false;
				void this.save();
			}
		}, refreshAfterMs);
	}

	// ─── Download & apply ──────────────────────────────────────────────────────

	/**
	 * Download config from Drive and apply it to all local stores.
	 * Conflict rule: Drive config wins only if its savedAt is newer than the last local save.
	 */
	async downloadAndApply(): Promise<DriveConfig | null> {
		if (!this.isConnected) return null;
		this.status = 'syncing';
		try {
			const config = await downloadDriveConfig(this.accessToken);
			if (!config) {
				this.status = 'idle';
				return null;
			}

			// Conflict resolution: skip apply if local data is newer
			const driveTime  = config.savedAt ? Date.parse(config.savedAt) : 0;
			const localTime  = localSavedAt   ? Date.parse(localSavedAt)   : 0;
			if (localTime > driveTime) {
				// Local is newer — push local state to Drive instead
				this.status = 'idle';
				void this.save();
				return null;
			}

			// Apply music settings
			const m = config.music;
			if (m) {
				if (m.driveFolderId      !== undefined) musicSettings.driveFolderId      = m.driveFolderId;
				if (m.driveFolderName    !== undefined) musicSettings.driveFolderName    = m.driveFolderName;
				if (m.favoriteFolders    !== undefined) musicSettings.favoriteFolders    = m.favoriteFolders;
				if (m.playbackSpeed      !== undefined) musicSettings.playbackSpeed      = m.playbackSpeed;
				if (m.equalizerPreset    !== undefined) musicSettings.equalizerPreset    = m.equalizerPreset as typeof musicSettings.equalizerPreset;
				if (m.eqBands            !== undefined) musicSettings.eqBands            = m.eqBands;
				if (m.sortOrder          !== undefined) musicSettings.sortOrder          = m.sortOrder as typeof musicSettings.sortOrder;
				if (m.crossfadeDuration  !== undefined) musicSettings.crossfadeDuration  = m.crossfadeDuration;
				if (m.volume             !== undefined) musicSettings.volume             = m.volume;
				if (m.isShuffle          !== undefined) musicSettings.isShuffle          = m.isShuffle;
				if (m.isRepeat           !== undefined) musicSettings.isRepeat           = m.isRepeat;
			}

			// Apply podcast settings
			const ps = config.podcastSettings;
			if (ps) {
				if (ps.playbackSpeed       !== undefined) podcastSettings.playbackSpeed       = ps.playbackSpeed;
				if (ps.skipBackSeconds     !== undefined) podcastSettings.skipBackSeconds      = ps.skipBackSeconds;
				if (ps.skipForwardSeconds  !== undefined) podcastSettings.skipForwardSeconds   = ps.skipForwardSeconds;
				if (ps.autoPlayNext        !== undefined) podcastSettings.autoPlayNext         = ps.autoPlayNext;
				if (ps.trimSilence         !== undefined) podcastSettings.trimSilence          = ps.trimSilence;
				if (ps.boostVolume         !== undefined) podcastSettings.boostVolume          = ps.boostVolume;
				if (ps.defaultTab          !== undefined) podcastSettings.defaultTab           = ps.defaultTab as typeof podcastSettings.defaultTab;
				if (ps.markPlayedThreshold !== undefined) podcastSettings.markPlayedThreshold  = ps.markPlayedThreshold;
				if (ps.autoMarkPlayed      !== undefined) podcastSettings.autoMarkPlayed       = ps.autoMarkPlayed;
			}

			// Apply podcast data
			if (config.podcasts        !== undefined) podcastData.podcasts       = config.podcasts;
			if (config.lastEpisodeId   !== undefined) podcastData.lastEpisodeId  = config.lastEpisodeId;
			if (config.lastPodcastId   !== undefined) podcastData.lastPodcastId  = config.lastPodcastId;
			if (config.lastPositionSec !== undefined) podcastData.lastPositionSec = config.lastPositionSec;

			// Apply mp3 track positions (merge: Drive wins per-track)
			if (config.mp3TrackPositions && typeof config.mp3TrackPositions === 'object') {
				mp3TrackPositions.positions = {
					...mp3TrackPositions.positions,
					...config.mp3TrackPositions,
				};
			}

			// Apply app settings
			const as = config.appSettings;
			if (as) {
				if (as.theme         !== undefined) appSettings.theme         = as.theme as typeof appSettings.theme;
				if (as.accentColor   !== undefined) appSettings.accentColor   = as.accentColor as typeof appSettings.accentColor;
				if (as.fontSize      !== undefined) appSettings.fontSize      = as.fontSize as typeof appSettings.fontSize;
				if (as.reducedMotion !== undefined) appSettings.reducedMotion = as.reducedMotion;
				if (as.hapticFeedback !== undefined) appSettings.hapticFeedback = as.hapticFeedback;
			}

			// Apply weather settings
			const ws = config.weatherSettings;
			if (ws) {
				if (ws.units          !== undefined) weatherSettings.units         = ws.units;
				if (ws.savedCities    !== undefined) weatherSettings.savedCities   = ws.savedCities;
				if (ws.activeCity     !== undefined) weatherSettings.activeCity    = ws.activeCity;
				if (ws.windUnit       !== undefined) weatherSettings.windUnit      = ws.windUnit;
				if (ws.showHourly     !== undefined) weatherSettings.showHourly    = ws.showHourly;
				if (ws.show7Day       !== undefined) weatherSettings.show7Day      = ws.show7Day;
				if (ws.showHumidity   !== undefined) weatherSettings.showHumidity  = ws.showHumidity;
				if (ws.showWind       !== undefined) weatherSettings.showWind      = ws.showWind;
				if (ws.showVisibility !== undefined) weatherSettings.showVisibility = ws.showVisibility;
				if (ws.showFeelsLike  !== undefined) weatherSettings.showFeelsLike  = ws.showFeelsLike;
			}

			localSavedAt = config.savedAt;
			this.lastSyncedAt = new Date();
			this.status = 'saved';
			return config;
		} catch (err) {
			this._handleError(err);
			return null;
		}
	}

	// ─── Save ──────────────────────────────────────────────────────────────────

	/** Upload the current local state to Drive. Queues if offline. */
	async save(): Promise<void> {
		if (!this.isConnected) {
			// Try silent refresh first
			const refreshed = await this.silentRefresh();
			if (!refreshed) {
				this.pendingSave = true;
				return;
			}
		}

		this.status = 'syncing';
		try {
			const now = new Date().toISOString();
			const config = buildDriveConfig(
				{
					driveFolderId:     musicSettings.driveFolderId,
					driveFolderName:   musicSettings.driveFolderName,
					favoriteFolders:   musicSettings.favoriteFolders,
					playbackSpeed:     musicSettings.playbackSpeed,
					equalizerPreset:   musicSettings.equalizerPreset,
					eqBands:           [...musicSettings.eqBands],
					sortOrder:         musicSettings.sortOrder,
					crossfadeDuration: musicSettings.crossfadeDuration,
					volume:            musicSettings.volume,
					isShuffle:         musicSettings.isShuffle,
					isRepeat:          musicSettings.isRepeat,
				},
				{
					playbackSpeed:       podcastSettings.playbackSpeed,
					skipBackSeconds:     podcastSettings.skipBackSeconds,
					skipForwardSeconds:  podcastSettings.skipForwardSeconds,
					autoPlayNext:        podcastSettings.autoPlayNext,
					trimSilence:         podcastSettings.trimSilence,
					boostVolume:         podcastSettings.boostVolume,
					defaultTab:          podcastSettings.defaultTab,
					markPlayedThreshold: podcastSettings.markPlayedThreshold,
					autoMarkPlayed:      podcastSettings.autoMarkPlayed,
				},
				podcastData.podcasts,
				podcastData.lastEpisodeId,
				podcastData.lastPodcastId,
				podcastData.lastPositionSec,
				{ ...mp3TrackPositions.positions },
				{
					theme:          appSettings.theme,
					accentColor:    appSettings.accentColor,
					fontSize:       appSettings.fontSize,
					reducedMotion:  appSettings.reducedMotion,
					hapticFeedback: appSettings.hapticFeedback,
				},
				{
					units:           weatherSettings.units,
					savedCities:     weatherSettings.savedCities,
					activeCity:      weatherSettings.activeCity,
					windUnit:        weatherSettings.windUnit,
					showHourly:      weatherSettings.showHourly,
					show7Day:        weatherSettings.show7Day,
					showHumidity:    weatherSettings.showHumidity,
					showWind:        weatherSettings.showWind,
					showVisibility:  weatherSettings.showVisibility,
					showFeelsLike:   weatherSettings.showFeelsLike,
				},
			);
			// Override savedAt with the timestamp we computed before the upload
			config.savedAt = now;
			await uploadDriveConfig(this.accessToken, config);
			localSavedAt = now;
			this.pendingSave = false;
			this.lastSyncedAt = new Date();
			this.status = 'saved';
		} catch (err) {
			this._handleError(err);
		}
	}

	/** Schedule a debounced save (3 s after last call). */
	scheduleSave() {
		if (this.saveTimer) clearTimeout(this.saveTimer);
		this.saveTimer = setTimeout(() => {
			this.saveTimer = null;
			void this.save();
		}, 3000);
	}

	// ─── Error handling ────────────────────────────────────────────────────────

	private _handleError(err: unknown) {
		if (err instanceof DriveApiError) {
			if (err.isAuthError) {
				// Token is invalid — clear it so isConnected becomes false
				this.accessToken = '';
				this.expiresAt = 0;
				this.errorMessage = 'Google Drive session expired. Please reconnect.';
			} else if (err.isRateLimited) {
				this.errorMessage = 'Google Drive rate limit reached. Will retry shortly.';
				// Retry after 10 s
				setTimeout(() => void this.save(), 10_000);
			} else if (err.isNotFound) {
				this.errorMessage = 'Config file not found on Drive.';
			} else {
				this.errorMessage = `Drive error (${err.status}): ${err.message}`;
			}
		} else {
			this.errorMessage = err instanceof Error ? err.message : 'Sync failed';
		}
		this.status = 'error';
	}

	// ─── Lifecycle ────────────────────────────────────────────────────────────

	disconnect() {
		this.accessToken = '';
		this.expiresAt   = 0;
		this.pendingSave = false;
		if (this.saveTimer)    { clearTimeout(this.saveTimer);    this.saveTimer    = null; }
		if (this.refreshTimer) { clearTimeout(this.refreshTimer); this.refreshTimer = null; }
		this.status = 'idle';
	}
}

export const driveConfigSync = new DriveConfigSync();

