/**
 * Crash-surviving breadcrumb for the YouTube → MP3 save.
 *
 * A native crash (out of memory, or the platform media decoder dying) leaves no
 * JS error and no toast, so there is no way to tell which step killed the app.
 * The current phase is written to `localStorage` before each step and cleared on
 * success or a caught error. If the process dies mid-save the marker survives,
 * and the next launch reports the phase.
 */
const SAVE_PHASE_KEY = 'youtube-mp3-save-phase';

const PHASE_LABELS: Record<string, string> = {
	picking: 'choosing the folder',
	resolving: 'resolving the stream',
	downloading: 'downloading',
	encoding: 'decoding and encoding',
	saving: 'saving the file'
};

export function markSavePhase(phase: string): void {
	try {
		localStorage.setItem(SAVE_PHASE_KEY, phase);
	} catch {
		// Private mode / storage disabled: the breadcrumb is best effort.
	}
}

export function clearSavePhase(): void {
	try {
		localStorage.removeItem(SAVE_PHASE_KEY);
	} catch {
		// ignore
	}
}

/** Read and clear the marker. Returns a human label for the phase a previous
 *  run died in, or null when the last save finished (or never started). */
export function takeCrashedSavePhase(): string | null {
	try {
		const phase = localStorage.getItem(SAVE_PHASE_KEY);
		if (!phase) return null;
		localStorage.removeItem(SAVE_PHASE_KEY);
		return PHASE_LABELS[phase] ?? phase;
	} catch {
		return null;
	}
}
