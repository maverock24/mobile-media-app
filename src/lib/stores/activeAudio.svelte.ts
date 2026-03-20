/**
 * Shared coordinator so that only one audio source (music, podcast, or essay)
 * plays at a time. Views register a stop-callback and call claimAudio
 * when they start playback.
 */

export type AudioSourceId = 'music' | 'podcast' | 'essay';

const stopFns: Partial<Record<AudioSourceId, () => void>> = {};

export function registerAudioSource(id: AudioSourceId, stopFn: () => void) {
	stopFns[id] = stopFn;
}

export function claimAudio(id: AudioSourceId) {
	for (const other of Object.keys(stopFns) as AudioSourceId[]) {
		if (other !== id) stopFns[other]?.();
	}
}
