<script lang="ts">
	import { Capacitor } from '@capacitor/core';
	import { Filesystem } from '@capacitor/filesystem';
	import {
		canStreamGoogleDriveFile,
		createGoogleDriveStreamSession,
		downloadGoogleDriveFile
	} from '$lib/google-drive';
	import { googleDriveSession } from '$lib/stores/googleDriveSession.svelte';
	import { essayPlayer } from '$lib/stores/essayPlayer.svelte';
	import { onMount } from 'svelte';

	let audioElement: HTMLAudioElement | undefined;
	let cleanupCurrentSource: (() => void) | undefined;
	let selectedEssayId = '';

	function bytesFromBase64(data: string): Uint8Array {
		const base64 = data.includes(',') ? (data.split(',').pop() ?? '') : data;
		const normalized = base64.replace(/\s/g, '');
		const binary = atob(normalized);
		const bytes = new Uint8Array(binary.length);

		for (let index = 0; index < binary.length; index += 1) {
			bytes[index] = binary.charCodeAt(index);
		}

		return bytes;
	}

	function arrayBufferFromBytes(bytes: Uint8Array): ArrayBuffer {
		return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
	}

	async function blobFromNativePath(path: string, mimeType?: string): Promise<Blob> {
		try {
			const result = await Filesystem.readFile({ path });
			if (result.data instanceof Blob) {
				return result.data;
			}

			return new Blob([arrayBufferFromBytes(bytesFromBase64(result.data))], {
				type: mimeType ?? 'audio/mpeg'
			});
		} catch {
			// Fall back to HTTP bridge reads for file:// paths if native read fails.
		}

		const candidates = [Capacitor.convertFileSrc(path), path];

		for (const candidate of candidates) {
			try {
				const response = await fetch(candidate);
				if (response.ok) {
					return await response.blob();
				}
			} catch {
				// try next candidate
			}
		}

		throw new Error('Unable to read the selected essay file.');
	}

	function clearSource() {
		cleanupCurrentSource?.();
		cleanupCurrentSource = undefined;
		if (audioElement) {
			audioElement.pause();
			audioElement.removeAttribute('src');
			audioElement.load();
		}
	}

	async function prepareSource() {
		if (!audioElement || !essayPlayer.currentEssay) return false;

		const essay = essayPlayer.currentEssay;
		if (essay.id !== selectedEssayId) {
			clearSource();
			selectedEssayId = essay.id;
		}

		if (audioElement.src) {
			return true;
		}

		try {
			if (essay.source === 'drive' && essay.googleDriveFileId) {
				const accessToken = await googleDriveSession.ensureAccessToken(false);
				if (!accessToken) {
					essayPlayer.setError('Sign in to Google Drive from the Login tab to play this essay.');
					return false;
				}

				if (canStreamGoogleDriveFile(essay.mimeType)) {
					const streamSession = await createGoogleDriveStreamSession({
						accessToken,
						fileId: essay.googleDriveFileId,
						mimeType: essay.mimeType
					});

					cleanupCurrentSource = streamSession.dispose;
					audioElement.src = streamSession.url;
				} else {
					const file = await downloadGoogleDriveFile({
						accessToken,
						fileId: essay.googleDriveFileId,
						fileName: `${essay.title}.mp3`,
						mimeType: essay.mimeType
					});

					const objectUrl = URL.createObjectURL(file);
					cleanupCurrentSource = () => URL.revokeObjectURL(objectUrl);
					audioElement.src = objectUrl;
				}
			} else if (essay.source === 'native' && essay.nativePath) {
				const blob = await blobFromNativePath(essay.nativePath, essay.mimeType);
				const objectUrl = URL.createObjectURL(blob);
				cleanupCurrentSource = () => URL.revokeObjectURL(objectUrl);
				audioElement.src = objectUrl;
			} else {
				const audioUrl = essay.audioUrl;
				if (!audioUrl || audioUrl.trim() === '') {
					essayPlayer.setError('Invalid audio URL');
					return false;
				}

				audioElement.src = audioUrl;
			}

			audioElement.currentTime = 0;
			audioElement.load();
			essayPlayer.setError(null);
			essayPlayer.updateCurrentTime(0);
			return true;
		} catch (err) {
			essayPlayer.setError(err instanceof Error ? err.message : 'Unable to prepare audio playback.');
			return false;
		}
	}

	// React to essay selection
	$effect(() => {
		if (!essayPlayer.currentEssay) {
			selectedEssayId = '';
			clearSource();
		}
	});

	// React to play/pause state
	$effect(() => {
		if (!audioElement) return;

		if (essayPlayer.isPlaying) {
			void (async () => {
				const ready = await prepareSource();
				if (!ready) {
					essayPlayer.pausePlayback();
					return;
				}

				audioElement.play().catch((err) => {
					essayPlayer.setError(`Playback failed: ${err.message}`);
					essayPlayer.pausePlayback();
				});
			})();
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
			clearSource();
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
