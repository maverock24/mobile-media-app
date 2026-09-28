import { persisted } from '$lib/persisted.svelte';
import { normalizeListTileTone, type ListTileTone } from '$lib/utils/listTileTone';
import type { FavoriteTrack } from '$lib/models/music';

// ─────────────────────────────────────────────────────────────
// App-level settings (theme, etc.)
// ─────────────────────────────────────────────────────────────
export const appSettings = persisted('app-settings', {
	theme: 'system' as 'light' | 'dark' | 'system',
	accentColor: 'slate' as 'slate' | 'blue' | 'violet' | 'rose' | 'orange' | 'green',
	fontSize: 'md' as 'sm' | 'md' | 'lg',
	reducedMotion: false,
	hapticFeedback: true,
	driveMode: false,
	mediaControlsPosition: 'bottom' as 'top' | 'bottom',
	listTileTone: 'default' as ListTileTone,
	screenDimDelay: 0,  // seconds; 0 = off, presets: 30, 60, 120, 600
});

appSettings.listTileTone = normalizeListTileTone(appSettings.listTileTone);

// ─────────────────────────────────────────────────────────────
// Sleep timer settings
// ─────────────────────────────────────────────────────────────
export const sleepTimerSettings = persisted('sleep-timer-settings', {
	endsAt: 0,
	lastDurationMin: 30,
});

// ─────────────────────────────────────────────────────────────
// MP3 Player settings
// ─────────────────────────────────────────────────────────────
export const musicSettings = persisted('music-settings', {
	volume: 80,
	deckAVolume: 80,
	deckBVolume: 80,
	isMuted: false,
	isShuffle: false,
	isRepeat: false,
	librarySource: 'device' as 'device' | 'drive',
	nativeTreeUri: '',
	lastFolderName: '',
	driveFolderId: '',
	driveFolderName: '',
	lastTrackIndex: 0,
	lastTrackKey: '',  // stable file identity for resume after sort
	lastTrackTimestamp: 0,  // seconds — saved on pause/steal for UX continuity
	crossfadeDuration: 0,   // seconds (0 = disabled)
	equalizerPreset: 'flat' as 'flat' | 'bass' | 'treble' | 'vocal' | 'classical' | 'custom',
	eqBands: [0, 0, 0, 0, 0, 0] as number[],  // gains in dB: 60Hz 170Hz 350Hz 1kHz 3.5kHz 10kHz
	deckASpeed: 1.0,
	deckBSpeed: 1.0,
	showAlbumArt: true,
	autoPlay: false,
	rewindOnPrev: true,    // restart track if >3s in, on prev press
	/** YouTube queue: wrap to the first result after the last one ends. */
	youtubeQueueLoop: true,
	sortOrder: 'filename' as 'filename' | 'title' | 'artist',
	favoriteFolders: [] as Array<{ id: string; name: string; source: 'device' | 'drive'; treeUri?: string }>,
	favoriteTracks: [] as FavoriteTrack[],
	browsePath: [] as string[],
}, { debounceMs: 5000 });

// Migrate the legacy single playbackSpeed to per-deck speeds (Deck A / Deck B).
const _legacyMusicSpeed = (musicSettings as unknown as { playbackSpeed?: number }).playbackSpeed;
if (typeof _legacyMusicSpeed === 'number' && _legacyMusicSpeed > 0) {
	musicSettings.deckASpeed = _legacyMusicSpeed;
	musicSettings.deckBSpeed = _legacyMusicSpeed;
}

// ─────────────────────────────────────────────────────────────
// Podcast settings
// ─────────────────────────────────────────────────────────────
export const podcastSettings = persisted('podcast-settings', {
	playbackSpeed: 1.0,
	skipBackSeconds: 10,
	skipForwardSeconds: 30,
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
}, {
	// Persist a size-bounded snapshot: episode bodies are the bulk of this blob
	// (every subscription's full episode list, re-fetched into memory), and if it
	// ever exceeds the WebView localStorage quota the write throws — which used to
	// permanently kill this store's persistence effect, silently losing ALL
	// subscriptions on the next restart. Keep the payload small enough to always
	// fit: retain the full subscription manifest (tiny) but only a bounded window
	// of episodes per podcast, preferring ones the user has progress on, then the
	// newest. The full episode list stays in memory and is re-merged on refresh.
	trim: (state) => {
		const MAX_EPISODES_PER_PODCAST = 120;
		const podcasts = state.podcasts.map((p) => {
			const eps = p.episodes ?? [];
			if (eps.length <= MAX_EPISODES_PER_PODCAST) return p;
			const kept = eps.filter((e) => e.played || (e.progress ?? 0) > 0 || (e.positionSec ?? 0) > 0);
			const wanted = MAX_EPISODES_PER_PODCAST - kept.length;
			// eps is newest-first (older pages are appended), so take the newest.
			const newest = wanted > 0 ? eps.slice(0, wanted) : [];
			return { ...p, episodes: [...newest, ...kept] };
		});
		return { ...state, podcasts };
	},
});

// ─────────────────────────────────────────────────────────────
// MP3 per-track resume positions
// ─────────────────────────────────────────────────────────────
export const mp3TrackPositions = persisted('mp3-track-positions', {
	positions: {} as Record<string, number>   // trackKey → seconds
});

if (Object.keys(mp3TrackPositions.positions).length > 0) {
	mp3TrackPositions.positions = {};
}

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

// ─────────────────────────────────────────────────────────────
// Radio stations (favorites)
// ─────────────────────────────────────────────────────────────
export interface RadioStation {
stationuuid:  string;
name:         string;
url_resolved: string;
favicon:      string;
country:      string;
tags:         string;
codec:        string;
bitrate:      number;
votes:        number;
}

export const radioData = persisted('radio-data', {
favorites: [] as RadioStation[],
}, { debounceMs: 3000 });
