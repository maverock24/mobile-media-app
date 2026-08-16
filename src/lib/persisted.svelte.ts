/**
 * Generic localStorage-backed Svelte 5 store.
 * Returns a reactive $state object that auto-saves to localStorage on every change.
 *
 * Usage:
 *   const prefs = persisted('my-key', { volume: 80, theme: 'dark' });
 *   prefs.volume = 60;  // automatically saved
 */
import { untrack } from 'svelte';

export function persisted<T extends object>(key: string, defaults: T, _opts?: {
	/** @deprecated Kept for API compatibility — writes are now synchronous. */
	debounceMs?: number;
}): T {
	let stored: T = defaults;
	if (typeof localStorage !== 'undefined') {
		try {
			const raw = localStorage.getItem(key);
			if (raw) stored = { ...defaults, ...JSON.parse(raw) };
		} catch {
			stored = defaults;
		}
	}

	// Deep-copy so we don't mutate the defaults object
	const state = $state<T>(structuredClone(stored));

	function flushToLocalStorage() {
		if (typeof localStorage === 'undefined') return;
		localStorage.setItem(key, JSON.stringify(state));
	}

	// Write synchronously on every change. A debounce (previously 2.5s) caused
	// data loss on Android when the app was backgrounded/killed before the timer
	// fired — e.g. a newly subscribed podcast reverting on reopen. All persisted
	// stores change at discrete, low-frequency events (subscribe, pause, settings
	// toggle, …), so a synchronous write is cheap and guarantees persistence.
	//
	// untrack() is critical: JSON.stringify(state) reads every nested field, and
	// doing that inside the tracking $effect would create reactive dependencies on
	// all of them (e.g. favoriteTracks[42].title). We only want top-level keys.
	function scheduleFlush() {
		untrack(() => flushToLocalStorage());
	}

	$effect.root(() => {
		$effect(() => {
			// Read each top-level key to establish fine-grained reactivity.
			// Using Object.keys(defaults) ensures we only track keys that exist
			// at init time.
			for (const k of Object.keys(defaults)) {
				void (state as Record<string, unknown>)[k];
			}
			scheduleFlush();
		});

		if (typeof window === 'undefined') return;

		const flushNow = () => flushToLocalStorage();
		const flushWhenHidden = () => {
			if (document.visibilityState === 'hidden') flushNow();
		};

		window.addEventListener('pagehide', flushNow);
		window.addEventListener('beforeunload', flushNow);
		document.addEventListener('visibilitychange', flushWhenHidden);
		// Capacitor native apps don't reliably update document.visibilityState
		// when backgrounded/closed — also flush on the Capacitor 'pause' event.
		document.addEventListener('pause', flushNow);

		return () => {
			window.removeEventListener('pagehide', flushNow);
			window.removeEventListener('beforeunload', flushNow);
			document.removeEventListener('visibilitychange', flushWhenHidden);
			document.removeEventListener('pause', flushNow);
		};
	});

	return state;
}
