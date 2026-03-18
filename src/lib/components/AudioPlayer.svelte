<script lang="ts">
	import { essayPlayer } from '$lib/stores/essayPlayer.svelte';
	import { onMount } from 'svelte';

	let audioElement: HTMLAudioElement | undefined;

	// React to essay selection
	$effect(() => {
		if (essayPlayer.currentEssay && audioElement) {
			const audioUrl = essayPlayer.currentEssay.audioUrl;
			
			// Validate URL
			if (!audioUrl || audioUrl.trim() === '') {
				essayPlayer.setError('Invalid audio URL');
				return;
			}

			audioElement.src = audioUrl;
			essayPlayer.setError(null);

			// Reset current time on essay change
			audioElement.currentTime = 0;
			essayPlayer.updateCurrentTime(0);
		}
	});

	// React to play/pause state
	$effect(() => {
		if (!audioElement) return;

		if (essayPlayer.isPlaying) {
			audioElement.play().catch((err) => {
				essayPlayer.setError(`Playback failed: ${err.message}`);
				essayPlayer.pausePlayback();
			});
		} else {
			audioElement.pause();
		}
	});

	// React to volume changes
	$effect(() => {
		if (audioElement) {
			audioElement.volume = essayPlayer.volume;
		}
	});

	// React to playback rate changes
	$effect(() => {
		if (audioElement) {
			audioElement.playbackRate = essayPlayer.playbackRate;
		}
	});

	// React to seek/currentTime changes
	$effect(() => {
		if (audioElement && essayPlayer.currentTime !== audioElement.currentTime) {
			audioElement.currentTime = essayPlayer.currentTime;
		}
	});

	onMount(() => {
		if (!audioElement) return;

		// Handle timeupdate (progress tracking)
		const handleTimeUpdate = () => {
			if (audioElement && !essayPlayer.isSeeking) {
				essayPlayer.updateCurrentTime(audioElement.currentTime);
			}
		};

		// Handle duration metadata loaded
		const handleLoadedMetadata = () => {
			if (audioElement) {
				essayPlayer.updateDuration(audioElement.duration);
			}
		};

		// Handle playback started
		const handlePlay = () => {
			essayPlayer.startPlayback();
		};

		// Handle playback paused
		const handlePause = () => {
			essayPlayer.pausePlayback();
		};

		// Handle playback ended
		const handleEnded = () => {
			essayPlayer.pausePlayback();
			essayPlayer.updateCurrentTime(0);
		};

		// Handle errors
		const handleError = () => {
			if (audioElement && audioElement.error) {
				let errorMsg = 'Error loading audio';
				switch (audioElement.error.code) {
					case audioElement.error.MEDIA_ERR_NETWORK:
						errorMsg = 'Network error loading audio';
						break;
					case audioElement.error.MEDIA_ERR_DECODE:
						errorMsg = 'Error decoding audio file';
						break;
					case audioElement.error.MEDIA_ERR_SRC_NOT_SUPPORTED:
						errorMsg = 'Audio format not supported';
						break;
				}
				essayPlayer.setError(errorMsg);
			}
			essayPlayer.pausePlayback();
		};

		audioElement.addEventListener('timeupdate', handleTimeUpdate);
		audioElement.addEventListener('loadedmetadata', handleLoadedMetadata);
		audioElement.addEventListener('play', handlePlay);
		audioElement.addEventListener('pause', handlePause);
		audioElement.addEventListener('ended', handleEnded);
		audioElement.addEventListener('error', handleError);

		return () => {
			audioElement?.removeEventListener('timeupdate', handleTimeUpdate);
			audioElement?.removeEventListener('loadedmetadata', handleLoadedMetadata);
			audioElement?.removeEventListener('play', handlePlay);
			audioElement?.removeEventListener('pause', handlePause);
			audioElement?.removeEventListener('ended', handleEnded);
			audioElement?.removeEventListener('error', handleError);
		};
	});
</script>

<!-- Hidden audio element -->
<audio bind:this={audioElement} crossorigin="anonymous" preload="metadata"></audio>
