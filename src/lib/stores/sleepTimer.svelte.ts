import { mediaEngine } from './mediaEngine.svelte';
import { sleepTimerSettings } from './settings.svelte';
import { addToast } from './toastStore.svelte';

const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;

export const SLEEP_TIMER_PRESETS = [15, 30, 45, 60] as const;

export const sleepTimer = $state({
	endsAt: sleepTimerSettings.endsAt,
	remainingMs: 0,
	isActive: false,
	lastDurationMin: sleepTimerSettings.lastDurationMin,
});

let syncInterval: ReturnType<typeof setInterval> | null = null;
let initialized = false;

function setTimerActive(endsAt: number) {
	sleepTimer.endsAt = endsAt;
	sleepTimerSettings.endsAt = endsAt;
	sleepTimer.isActive = endsAt > Date.now();
}

function stopPlaybackForSleepTimer() {
	if (!mediaEngine.isPlaying) return;
	mediaEngine._onPause?.() ?? mediaEngine.pause();
}

function stopTicking() {
	if (syncInterval !== null) {
		clearInterval(syncInterval);
		syncInterval = null;
	}
}

function ensureTicking() {
	if (!sleepTimer.isActive || syncInterval !== null || typeof window === 'undefined') return;
	syncInterval = window.setInterval(() => {
		syncSleepTimer();
	}, SECOND_MS);
	}

function expireSleepTimer() {
	const hadActiveTimer = sleepTimer.endsAt > 0;
	const wasPlaying = mediaEngine.isPlaying;
	setTimerActive(0);
	sleepTimer.remainingMs = 0;
	stopTicking();
	if (!hadActiveTimer) return;
	stopPlaybackForSleepTimer();
	addToast({
		message: wasPlaying ? 'Sleep timer stopped playback.' : 'Sleep timer finished.',
		type: 'info',
		autoDismissMs: 3500,
	});
	}

export function syncSleepTimer() {
	sleepTimer.lastDurationMin = sleepTimerSettings.lastDurationMin;
	const endsAt = sleepTimerSettings.endsAt;
	if (!endsAt) {
		setTimerActive(0);
		sleepTimer.remainingMs = 0;
		stopTicking();
		return;
	}

	const remainingMs = Math.max(0, endsAt - Date.now());
	sleepTimer.remainingMs = remainingMs;
	setTimerActive(endsAt);
	if (remainingMs <= 0) {
		expireSleepTimer();
		return;
	}

	ensureTicking();
	}

export function setSleepTimer(minutes: number) {
	const normalizedMinutes = Math.max(1, Math.round(minutes));
	sleepTimerSettings.lastDurationMin = normalizedMinutes;
	sleepTimer.lastDurationMin = normalizedMinutes;
	setTimerActive(Date.now() + normalizedMinutes * MINUTE_MS);
	syncSleepTimer();
	}

export function clearSleepTimer(options: { silent?: boolean } = {}) {
	const hadActiveTimer = sleepTimer.endsAt > 0;
	setTimerActive(0);
	sleepTimer.remainingMs = 0;
	stopTicking();
	if (hadActiveTimer && !options.silent) {
		addToast({ message: 'Sleep timer cleared.', type: 'info', autoDismissMs: 2500 });
	}
	}

export function formatSleepTimerRemaining(remainingMs: number): string {
	if (remainingMs <= 0) return 'Off';
	const totalSeconds = Math.ceil(remainingMs / SECOND_MS);
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;
	if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`;
	if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
	return `${seconds}s`;
	}

export function initSleepTimer() {
	if (initialized || typeof window === 'undefined') return;
	initialized = true;
	syncSleepTimer();

	const syncFromLifecycle = () => {
		syncSleepTimer();
	};

	window.addEventListener('focus', syncFromLifecycle);
	window.addEventListener('pageshow', syncFromLifecycle);
	document.addEventListener('visibilitychange', syncFromLifecycle);
	window.addEventListener('beforeunload', () => stopTicking(), { once: true });
	}