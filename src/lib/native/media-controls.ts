import { registerPlugin } from '@capacitor/core';

export interface MediaControlsPlugin {
	ensureNotificationPermission(): Promise<{ granted: boolean }>;
	updateNowPlaying(options: {
		title: string;
		artist: string;
		album?: string;
		durationSec?: number;
	}): Promise<void>;
	updatePlaybackState(options: {
		isPlaying: boolean;
		positionSec: number;
		durationSec: number;
	}): Promise<void>;
	setTransportAvailability(options: {
		hasNext: boolean;
		hasPrevious: boolean;
	}): Promise<void>;
	clear(): Promise<void>;
	addListener(
		eventName: 'mediaAction',
		listenerFunc: (event: { action: string; positionSec?: number }) => void
	): Promise<{ remove: () => Promise<void> }>;
}

export const MediaControls = registerPlugin<MediaControlsPlugin>('MediaControls');