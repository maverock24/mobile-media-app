/**
 * Shared coordinator so that only one audio source (music or podcast)
 * plays at a time. Views register a stop-callback and call claimAudio
 * when they start playback.
 */

const stopFns: Partial<Record<'music' | 'podcast', () => void>> = {};

export function registerAudioSource(id: 'music' | 'podcast', stopFn: () => void) {
	stopFns[id] = stopFn;
}

export function claimAudio(id: 'music' | 'podcast') {
	const other = id === 'music' ? 'podcast' : 'music';
	stopFns[other]?.();
}
