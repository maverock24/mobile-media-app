import {
	downloadGoogleDriveJsonFile,
	ensureGoogleDriveFolder,
	findGoogleDriveFolderByName,
	findGoogleDriveFileByName,
	uploadGoogleDriveJsonFile,
	type GoogleDriveFolder,
} from '$lib/google-drive';
import { googleDriveSession } from '$lib/stores/googleDriveSession.svelte';
import { musicSettings, podcastData, radioData, weatherSettings } from '$lib/stores/settings.svelte';

const MEDIA_HUB_FOLDER_NAME = 'MediaHub';
const MEDIA_HUB_VERSION = 1;

const PODCASTS_FILE_NAME = 'podcasts.json';
const MUSIC_FILE_NAME = 'music.json';
const RADIO_FILE_NAME = 'radio.json';
const WEATHER_FILE_NAME = 'weather.json';

type SyncState = 'idle' | 'syncing' | 'saved' | 'error';

type MediaHubPayload<T> = {
	version: number;
	savedAt: string;
	data: T;
};

type PodcastsPayload = {
	podcasts: typeof podcastData.podcasts;
	lastEpisodeId: string;
	lastPodcastId: number;
	lastPositionSec: number;
};

type MusicPayload = {
	driveFolderId: string;
	driveFolderName: string;
	favoriteFolders: typeof musicSettings.favoriteFolders;
	favoriteTracks: typeof musicSettings.favoriteTracks;
};

type RadioPayload = {
	favorites: typeof radioData.favorites;
};

type WeatherPayload = {
	units: typeof weatherSettings.units;
	savedCities: typeof weatherSettings.savedCities;
	activeCity: string;
	windUnit: typeof weatherSettings.windUnit;
	showHourly: boolean;
	show7Day: boolean;
	showHumidity: boolean;
	showWind: boolean;
	showVisibility: boolean;
	showFeelsLike: boolean;
	refreshIntervalMin: number;
	notificationsEnabled: boolean;
};

function createPayload<T>(data: T): MediaHubPayload<T> {
	return {
		version: MEDIA_HUB_VERSION,
		savedAt: new Date().toISOString(),
		data
	};
}

class MediaHubSyncStore {
	state = $state<SyncState>('idle');
	error = $state('');
	lastSyncedAt = $state<Date | null>(null);
	folder = $state<GoogleDriveFolder | null>(null);

	private async ensureAuthorizedToken(interactive: boolean): Promise<string | null> {
		const token = await googleDriveSession.ensureAccessToken(interactive);
		if (!token) {
			this.state = 'error';
			this.error = googleDriveSession.error || 'Google Drive authorization failed.';
			return null;
		}

		this.error = '';
		return token;
	}

	private async ensureMediaHubFolder(accessToken: string): Promise<GoogleDriveFolder> {
		if (this.folder) {
			return this.folder;
		}

		this.folder = await ensureGoogleDriveFolder(accessToken, MEDIA_HUB_FOLDER_NAME);
		return this.folder;
	}

	async push(): Promise<boolean> {
		const accessToken = await this.ensureAuthorizedToken(true);
		if (!accessToken) {
			return false;
		}

		this.state = 'syncing';

		try {
			const folder = await this.ensureMediaHubFolder(accessToken);

			await Promise.all([
				uploadGoogleDriveJsonFile({
					accessToken,
					parentId: folder.id,
					fileName: PODCASTS_FILE_NAME,
					content: createPayload<PodcastsPayload>({
						podcasts: podcastData.podcasts,
						lastEpisodeId: podcastData.lastEpisodeId,
						lastPodcastId: podcastData.lastPodcastId,
						lastPositionSec: podcastData.lastPositionSec,
					})
				}),
				uploadGoogleDriveJsonFile({
					accessToken,
					parentId: folder.id,
					fileName: MUSIC_FILE_NAME,
					content: createPayload<MusicPayload>({
						driveFolderId: musicSettings.driveFolderId,
						driveFolderName: musicSettings.driveFolderName,
						favoriteFolders: musicSettings.favoriteFolders,
						favoriteTracks: musicSettings.favoriteTracks,
					})
				}),
				uploadGoogleDriveJsonFile({
					accessToken,
					parentId: folder.id,
					fileName: RADIO_FILE_NAME,
					content: createPayload<RadioPayload>({
						favorites: radioData.favorites,
					})
				}),
				uploadGoogleDriveJsonFile({
					accessToken,
					parentId: folder.id,
					fileName: WEATHER_FILE_NAME,
					content: createPayload<WeatherPayload>({
						units: weatherSettings.units,
						savedCities: weatherSettings.savedCities,
						activeCity: weatherSettings.activeCity,
						windUnit: weatherSettings.windUnit,
						showHourly: weatherSettings.showHourly,
						show7Day: weatherSettings.show7Day,
						showHumidity: weatherSettings.showHumidity,
						showWind: weatherSettings.showWind,
						showVisibility: weatherSettings.showVisibility,
						showFeelsLike: weatherSettings.showFeelsLike,
						refreshIntervalMin: weatherSettings.refreshIntervalMin,
						notificationsEnabled: weatherSettings.notificationsEnabled,
					})
				}),
			]);

			this.lastSyncedAt = new Date();
			this.state = 'saved';
			this.error = '';
			return true;
		} catch (error) {
			this.state = 'error';
			this.error = error instanceof Error ? error.message : 'Unable to push MediaHub data to Google Drive.';
			return false;
		}
	}

	async fetchAndApply(): Promise<boolean> {
		const accessToken = await this.ensureAuthorizedToken(true);
		if (!accessToken) {
			return false;
		}

		this.state = 'syncing';

		try {
			const folder = this.folder ?? (await findGoogleDriveFolderByName(accessToken, MEDIA_HUB_FOLDER_NAME));
			if (!folder) {
				this.state = 'error';
				this.error = 'No MediaHub data was found in Google Drive yet.';
				return false;
			}

			this.folder = folder;

			const [podcastsFile, musicFile, radioFile, weatherFile] = await Promise.all([
				findGoogleDriveFileByName(accessToken, PODCASTS_FILE_NAME, folder.id),
				findGoogleDriveFileByName(accessToken, MUSIC_FILE_NAME, folder.id),
				findGoogleDriveFileByName(accessToken, RADIO_FILE_NAME, folder.id),
				findGoogleDriveFileByName(accessToken, WEATHER_FILE_NAME, folder.id),
			]);

			if (podcastsFile) {
				const payload = await downloadGoogleDriveJsonFile<MediaHubPayload<PodcastsPayload>>(accessToken, podcastsFile.id);
				podcastData.podcasts = payload.data.podcasts;
				podcastData.lastEpisodeId = payload.data.lastEpisodeId;
				podcastData.lastPodcastId = payload.data.lastPodcastId;
				podcastData.lastPositionSec = payload.data.lastPositionSec;
			}

			if (musicFile) {
				const payload = await downloadGoogleDriveJsonFile<MediaHubPayload<MusicPayload>>(accessToken, musicFile.id);
				musicSettings.driveFolderId = payload.data.driveFolderId;
				musicSettings.driveFolderName = payload.data.driveFolderName;
				musicSettings.favoriteFolders = payload.data.favoriteFolders;
				musicSettings.favoriteTracks = payload.data.favoriteTracks;
			}

			if (radioFile) {
				const payload = await downloadGoogleDriveJsonFile<MediaHubPayload<RadioPayload>>(accessToken, radioFile.id);
				radioData.favorites = payload.data.favorites;
			}

			if (weatherFile) {
				const payload = await downloadGoogleDriveJsonFile<MediaHubPayload<WeatherPayload>>(accessToken, weatherFile.id);
				weatherSettings.units = payload.data.units;
				weatherSettings.savedCities = payload.data.savedCities;
				weatherSettings.activeCity = payload.data.activeCity;
				weatherSettings.windUnit = payload.data.windUnit;
				weatherSettings.showHourly = payload.data.showHourly;
				weatherSettings.show7Day = payload.data.show7Day;
				weatherSettings.showHumidity = payload.data.showHumidity;
				weatherSettings.showWind = payload.data.showWind;
				weatherSettings.showVisibility = payload.data.showVisibility;
				weatherSettings.showFeelsLike = payload.data.showFeelsLike;
				weatherSettings.refreshIntervalMin = payload.data.refreshIntervalMin;
				weatherSettings.notificationsEnabled = payload.data.notificationsEnabled;
			}

			this.lastSyncedAt = new Date();
			this.state = 'saved';
			this.error = '';
			return true;
		} catch (error) {
			this.state = 'error';
			this.error = error instanceof Error ? error.message : 'Unable to fetch MediaHub data from Google Drive.';
			return false;
		}
	}
}

export const mediaHubSync = new MediaHubSyncStore();