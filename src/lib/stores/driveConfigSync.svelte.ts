/**
 * driveConfigSync.svelte.ts
 *
 * Svelte 5 rune-based store that manages the Drive appdata access token
 * and exposes upload/download helpers with status tracking.
 */

import {
	DRIVE_APPDATA_SCOPE,
	downloadDriveConfig,
	uploadDriveConfig,
	buildDriveConfig,
	type DriveConfig,
} from '$lib/drive-config';
import { loadGoogleIdentityScript, getGoogleDriveClientId } from '$lib/google-drive';
import { musicSettings, podcastSettings, podcastData } from '$lib/stores/settings.svelte';

export type SyncStatus = 'idle' | 'syncing' | 'saved' | 'error';

class DriveConfigSync {
	accessToken   = $state('');
	expiresAt     = $state(0);
	status        = $state<SyncStatus>('idle');
	lastSyncedAt  = $state<Date | null>(null);
	errorMessage  = $state('');

	private saveTimer: ReturnType<typeof setTimeout> | null = null;

	get isConnected() {
		return this.accessToken.length > 0 && Date.now() < this.expiresAt - 60_000;
	}

	/** Request an appdata-scoped token (may prompt the user). */
	async connect(interactive = true): Promise<boolean> {
		try {
			const clientId = getGoogleDriveClientId();
			if (!clientId) return false;

			await loadGoogleIdentityScript();

			const token = await new Promise<string>((resolve, reject) => {
				const client = window.google?.accounts?.oauth2.initTokenClient({
					client_id: clientId,
					scope: DRIVE_APPDATA_SCOPE,
					callback: (resp: { access_token?: string; expires_in?: number; error?: string; error_description?: string }) => {
						if (resp?.access_token) {
							resolve(resp.access_token);
						} else {
							reject(new Error(resp?.error_description || resp?.error || 'appdata auth failed'));
						}
					},
					error_callback: (e: { type?: string }) => reject(new Error(e.type || 'auth interrupted')),
				});
				if (!client) { reject(new Error('Google Identity unavailable')); return; }
				client.requestAccessToken({ prompt: interactive ? 'consent' : '' });
			});

			const expiresIn = 3600;
			this.accessToken = token;
			this.expiresAt = Date.now() + expiresIn * 1000;
			return true;
		} catch {
			return false;
		}
	}

	/** Download config from Drive and apply it to all local stores. */
	async downloadAndApply(): Promise<DriveConfig | null> {
		if (!this.isConnected) return null;
		this.status = 'syncing';
		try {
			const config = await downloadDriveConfig(this.accessToken);
			if (!config) {
				this.status = 'idle';
				return null;
			}

			// Apply music settings
			const m = config.music;
			if (m) {
				if (m.driveFolderId  !== undefined) musicSettings.driveFolderId  = m.driveFolderId;
				if (m.driveFolderName !== undefined) musicSettings.driveFolderName = m.driveFolderName;
				if (m.favoriteFolders !== undefined) musicSettings.favoriteFolders = m.favoriteFolders;
				if (m.playbackSpeed   !== undefined) musicSettings.playbackSpeed   = m.playbackSpeed;
				if (m.equalizerPreset !== undefined) musicSettings.equalizerPreset = m.equalizerPreset as typeof musicSettings.equalizerPreset;
				if (m.eqBands         !== undefined) musicSettings.eqBands         = m.eqBands;
				if (m.sortOrder       !== undefined) musicSettings.sortOrder        = m.sortOrder as typeof musicSettings.sortOrder;
				if (m.crossfadeDuration !== undefined) musicSettings.crossfadeDuration = m.crossfadeDuration;
				if (m.volume          !== undefined) musicSettings.volume           = m.volume;
				if (m.isShuffle       !== undefined) musicSettings.isShuffle        = m.isShuffle;
				if (m.isRepeat        !== undefined) musicSettings.isRepeat         = m.isRepeat;
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

			// Apply podcast data (subscriptions + progress)
			if (config.podcasts !== undefined) podcastData.podcasts       = config.podcasts;
			if (config.lastEpisodeId  !== undefined) podcastData.lastEpisodeId  = config.lastEpisodeId;
			if (config.lastPodcastId  !== undefined) podcastData.lastPodcastId  = config.lastPodcastId;
			if (config.lastPositionSec !== undefined) podcastData.lastPositionSec = config.lastPositionSec;

			this.lastSyncedAt = new Date();
			this.status = 'saved';
			return config;
		} catch (err) {
			this.errorMessage = err instanceof Error ? err.message : 'Sync failed';
			this.status = 'error';
			return null;
		}
	}

	/** Upload the current local state to Drive. Debounced by 3 s when called via scheduleSave. */
	async save(): Promise<void> {
		if (!this.isConnected) return;
		this.status = 'syncing';
		try {
			const config = buildDriveConfig(
				{
					driveFolderId:    musicSettings.driveFolderId,
					driveFolderName:  musicSettings.driveFolderName,
					favoriteFolders:  musicSettings.favoriteFolders,
					playbackSpeed:    musicSettings.playbackSpeed,
					equalizerPreset:  musicSettings.equalizerPreset,
					eqBands:          [...musicSettings.eqBands],
					sortOrder:        musicSettings.sortOrder,
					crossfadeDuration: musicSettings.crossfadeDuration,
					volume:           musicSettings.volume,
					isShuffle:        musicSettings.isShuffle,
					isRepeat:         musicSettings.isRepeat,
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
			);
			await uploadDriveConfig(this.accessToken, config);
			this.lastSyncedAt = new Date();
			this.status = 'saved';
		} catch (err) {
			this.errorMessage = err instanceof Error ? err.message : 'Save failed';
			this.status = 'error';
		}
	}

	/** Schedule a debounced save (3 s after last call). */
	scheduleSave() {
		if (!this.isConnected) return;
		if (this.saveTimer) clearTimeout(this.saveTimer);
		this.saveTimer = setTimeout(() => {
			this.saveTimer = null;
			void this.save();
		}, 3000);
	}

	disconnect() {
		this.accessToken = '';
		this.expiresAt = 0;
		this.status = 'idle';
		this.lastSyncedAt = null;
		if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
	}
}

export const driveConfigSync = new DriveConfigSync();
