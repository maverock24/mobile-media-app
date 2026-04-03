/**
 * Generic localStorage-backed Svelte 5 store.
 * Returns a reactive $state object that auto-saves to localStorage on every change.
 *
 * Usage:
 *   const prefs = persisted('my-key', { volume: 80, theme: 'dark' });
 *   prefs.volume = 60;  // automatically saved
 */
export function persisted<T extends object>(key: string, defaults: T): T {
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

	let _debounceTimer: ReturnType<typeof setTimeout> | null = null;
	function scheduleFlush() {
		if (_debounceTimer !== null) clearTimeout(_debounceTimer);
		_debounceTimer = setTimeout(() => {
			_debounceTimer = null;
			flushToLocalStorage();
		}, 2500); // Increased from 500ms to reduce JSON.stringify lag on large lists
	}

	// Watch for any change and write back to localStorage (debounced to avoid
	// writing on every audio timeupdate tick at 60fps)
	$effect.root(() => {
		$effect(() => {
			// Accessing JSON.stringify triggers fine-grained reactivity on all fields.
			JSON.stringify(state); // track deps without writing immediately
			scheduleFlush();
		});

		if (typeof window === 'undefined') return;

		const flushBeforeUnload = () => {
			// Flush immediately on unload — can't wait for debounce
			if (_debounceTimer !== null) { clearTimeout(_debounceTimer); _debounceTimer = null; }
			flushToLocalStorage();
		};
		const flushWhenHidden = () => {
			if (document.visibilityState === 'hidden') {
				if (_debounceTimer !== null) { clearTimeout(_debounceTimer); _debounceTimer = null; }
				flushToLocalStorage();
			}
		};

		window.addEventListener('pagehide', flushBeforeUnload);
		window.addEventListener('beforeunload', flushBeforeUnload);
		document.addEventListener('visibilitychange', flushWhenHidden);

		return () => {
			window.removeEventListener('pagehide', flushBeforeUnload);
			window.removeEventListener('beforeunload', flushBeforeUnload);
			document.removeEventListener('visibilitychange', flushWhenHidden);
		};
	});

	return state;
}
