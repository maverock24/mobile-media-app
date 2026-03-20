import { persisted } from '$lib/persisted.svelte';

// ─────────────────────────────────────────────────────────────
// App-level settings (theme, etc.)
// ─────────────────────────────────────────────────────────────
export const appSettings = persisted('app-settings', {
	theme: 'system' as 'light' | 'dark' | 'system',
	accentColor: 'slate' as 'slate' | 'blue' | 'violet' | 'rose' | 'orange' | 'green',
	fontSize: 'md' as 'sm' | 'md' | 'lg',
	reducedMotion: false,
	hapticFeedback: true
});

// ─────────────────────────────────────────────────────────────
// MP3 Player settings
// ─────────────────────────────────────────────────────────────
export const musicSettings = persisted('music-settings', {
	volume: 80,
	isMuted: false,
	isShuffle: false,
	isRepeat: false,
	librarySource: 'device' as 'device' | 'drive',
	nativeTreeUri: '',
	lastFolderName: '',
	driveFolderId: '',
	driveFolderName: '',
	lastTrackIndex: 0,
	lastTrackTimestamp: 0,  // seconds — saved on pause/steal for UX continuity
	crossfadeDuration: 0,   // seconds (0 = disabled)
	equalizerPreset: 'flat' as 'flat' | 'bass' | 'treble' | 'vocal' | 'classical' | 'custom',
	eqBands: [0, 0, 0, 0, 0, 0] as number[],  // gains in dB: 60Hz 170Hz 350Hz 1kHz 3.5kHz 10kHz
	playbackSpeed: 1.0,
	showAlbumArt: true,
	autoPlay: false,
	rewindOnPrev: true,    // restart track if >3s in, on prev press
	sortOrder: 'filename' as 'filename' | 'title' | 'artist',
	favoriteFolders: [] as Array<{ id: string; name: string; source: 'device' | 'drive'; treeUri?: string }>,
});

// ─────────────────────────────────────────────────────────────
// Podcast settings
// ─────────────────────────────────────────────────────────────
export const podcastSettings = persisted('podcast-settings', {
	playbackSpeed: 1.0,
	skipBackSeconds: 10,
	skipForwardSeconds: 30,
	autoPlayNext: true,
	trimSilence: false,
	boostVolume: false,
	defaultTab: 'subscribed' as 'subscribed' | 'discover',
	markPlayedThreshold: 90,  // % progress before marked as played
	autoMarkPlayed: true
});

// ─────────────────────────────────────────────────────────────
// Podcast data (subscriptions + episode progress)
// ─────────────────────────────────────────────────────────────
export interface PersistedEpisode {
	id:          string;
	title:       string;
	description: string;
	duration:    number;
	publishedAt: string;
	played:      boolean;
	progress:    number;  // 0-100
	positionSec: number;  // precise playback position in seconds (0 = from start)
	audioUrl:    string;
}
export interface PersistedPodcast {
	id:             number;
	itunesId:       number;
	title:          string;
	author:         string;
	category:       string;
	artworkUrl:     string;
	feedUrl:        string;
	subscribed:     boolean;
	episodes:       PersistedEpisode[];
	episodesLoaded: boolean;
}

export const podcastData = persisted('podcast-data', {
	podcasts:           [] as PersistedPodcast[],
	nextId:             0,
	lastEpisodeId:      '' as string,   // id of last-played episode
	lastPodcastId:      -1 as number,   // id of that episode's podcast
	lastPositionSec:    0 as number,    // playback position in seconds
});

// ─────────────────────────────────────────────────────────────
// MP3 per-track resume positions
// ─────────────────────────────────────────────────────────────
export const mp3TrackPositions = persisted('mp3-track-positions', {
	positions: {} as Record<string, number>   // trackKey → seconds
});

// ─────────────────────────────────────────────────────────────
// Weather settings  (v2 — cities now store lat/lon/timezone)
// ─────────────────────────────────────────────────────────────
export interface SavedCity {
	name: string;
	country: string;
	lat: number;
	lon: number;
	timezone: string;
}

export const weatherSettings = persisted('weather-settings-v2', {
	units: 'C' as 'C' | 'F',
	savedCities: [
		{ name: 'Berlin',   country: 'DE', lat: 52.52,  lon: 13.405,   timezone: 'Europe/Berlin' },
		{ name: 'London',   country: 'GB', lat: 51.509, lon: -0.118,   timezone: 'Europe/London' },
		{ name: 'New York', country: 'US', lat: 40.713, lon: -74.006,  timezone: 'America/New_York' },
	] as SavedCity[],
	activeCity: 'Berlin',
	windUnit: 'kmh' as 'kmh' | 'mph' | 'ms',
	showHourly: true,
	show7Day: true,
	showHumidity: true,
	showWind: true,
	showVisibility: true,
	showFeelsLike: true,
	refreshIntervalMin: 30,
	notificationsEnabled: false
});
