/**
 * Reactive store for Essay Player state management
 */

import type { EssayMetadata } from '$lib/models/essay';

export const essayPlayer = $state.raw({
	currentEssay: null as EssayMetadata | null,
	isPlaying: false,
	currentTime: 0, // in seconds
	progress: 0, // 0-100
	duration: 0, // in seconds
	volume: 0.8, // 0-1
	playbackRate: 1.0, // 0.75, 1.0, 1.25, 1.5
	isSeeking: false, // race condition prevention
	error: null as string | null, // error state

	selectEssay(essay: EssayMetadata) {
		this.currentEssay = essay;
		this.currentTime = 0;
		this.progress = 0;
		this.duration = essay.duration;
		this.isPlaying = false;
	},

	startPlayback() {
		this.isPlaying = true;
	},

	pausePlayback() {
		this.isPlaying = false;
	},

	togglePlayback() {
		this.isPlaying = !this.isPlaying;
	},

	seekTo(time: number) {
		this.isSeeking = true;
		this.currentTime = time;
		if (this.duration > 0) {
			this.progress = Math.min(100, Math.max(0, Math.round((time / this.duration) * 100)));
		}
		// Debounce 100ms before finishing seek
		setTimeout(() => {
			this.isSeeking = false;
		}, 100);
	},

	updateProgress(time: number, duration: number) {
		this.currentTime = time;
		this.progress = duration > 0 ? Math.round((time / duration) * 100) : 0;
	},

	updateCurrentTime(seconds: number) {
		this.currentTime = seconds;
		if (this.duration > 0) {
			this.progress = Math.min(100, Math.max(0, Math.round((seconds / this.duration) * 100)));
		}
	},

	updateDuration(seconds: number) {
		this.duration = seconds;
	},

	setVolume(vol: number) {
		this.volume = Math.max(0, Math.min(1, vol));
	},

	setPlaybackRate(rate: number) {
		if ([0.75, 1.0, 1.25, 1.5].includes(rate)) {
			this.playbackRate = rate;
		}
	},

	setError(errorMessage: string | null) {
		this.error = errorMessage;
	},

	reset() {
		this.currentEssay = null;
		this.isPlaying = false;
		this.currentTime = 0;
		this.progress = 0;
		this.duration = 0;
		this.volume = 0.8;
		this.playbackRate = 1.0;
		this.isSeeking = false;
		this.error = null;
	}
});
