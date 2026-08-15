/**
 * Generic localStorage-backed Svelte 5 store.
 * Returns a reactive $state object that auto-saves to localStorage on every change.
 *
 * Usage:
 *   const prefs = persisted('my-key', { volume: 80, theme: 'dark' });
 *   prefs.volume = 60;  // automatically saved
 */
export function persisted<T extends object>(key: string, defaults: T, opts?: {
	/** Debounce delay in ms before writing to localStorage (default: 2500).
	 *  Use a longer value for stores with large arrays that change rarely. */
	debounceMs?: number;
}): T {
	const debounceMs = opts?.debounceMs ?? 2500;

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
		}, debounceMs);
	}

	// Watch for any change and write back to localStorage (debounced).
	// Important: we touch ONLY top-level keys to establish reactivity — NOT
	// JSON.stringify(state) which would create reactive dependencies on every
	// nested field (e.g. favoriteTracks[42].title).  Touching just the top-level
	// keys means adding/removing items or replacing arrays triggers persist,
	// but mutating a nested object inside an array does not (which is correct —
	// the serialize is a deep copy anyway, so identity changes are enough).
	$effect.root(() => {
		$effect(() => {
			// Read each top-level key to establish fine-grained reactivity.
			// Using Object.keys(defaults) ensures we only track keys that exist
			// at init time; if later code adds new keys we won't track them,
			// but that's rare and the unload flush catches them anyway.
			for (const k of Object.keys(defaults)) {
				void (state as Record<string, unknown>)[k];
			}
			scheduleFlush();
		});

		if (typeof window === 'undefined') return;

		const flushPending = () => {
			if (_debounceTimer !== null) { clearTimeout(_debounceTimer); _debounceTimer = null; }
			flushToLocalStorage();
		};

		const flushBeforeUnload = () => {
			// Flush immediately on unload — can't wait for debounce
			flushPending();
		};
		const flushWhenHidden = () => {
			if (document.visibilityState === 'hidden') {
				flushPending();
			}
		};

		window.addEventListener('pagehide', flushBeforeUnload);
		window.addEventListener('beforeunload', flushBeforeUnload);
		document.addEventListener('visibilitychange', flushWhenHidden);
		// Capacitor native apps don't reliably update document.visibilityState
		// when the app is backgrounded or closed (the WebView keeps reporting
		// 'visible'). Flush pending debounced writes on the Capacitor 'pause'
		// lifecycle event so changes aren't lost when the app is killed.
		document.addEventListener('pause', flushPending);

		return () => {
			window.removeEventListener('pagehide', flushBeforeUnload);
			window.removeEventListener('beforeunload', flushBeforeUnload);
			document.removeEventListener('visibilitychange', flushWhenHidden);
			document.removeEventListener('pause', flushPending);
		};
	});

	return state;
}
