import { describe, it, expect, vi } from 'vitest';
import { LIBRARY_RESCAN_EVENT, requestLibraryRescan } from '$lib/stores/musicView.svelte';

// The music view is mounted twice (one instance per deck) and every instance
// listens for the rescan event, so the request has to reach all of them. Only
// the signal is testable here: the listener that rebuilds the index lives in the
// view's `$effect`, and the panel that dispatches it needs a device.

describe('requestLibraryRescan', () => {
	it('reaches every listener, which is how both decks rescan', () => {
		const deckA = vi.fn();
		const deckB = vi.fn();
		window.addEventListener(LIBRARY_RESCAN_EVENT, deckA);
		window.addEventListener(LIBRARY_RESCAN_EVENT, deckB);

		try {
			requestLibraryRescan();

			expect(deckA).toHaveBeenCalledTimes(1);
			expect(deckB).toHaveBeenCalledTimes(1);
		} finally {
			window.removeEventListener(LIBRARY_RESCAN_EVENT, deckA);
			window.removeEventListener(LIBRARY_RESCAN_EVENT, deckB);
		}
	});

	it('pins the event name the mounted views subscribe to', () => {
		// A rename that misses a listener would silently stop refreshing the
		// library, which is exactly the bug this signal exists to fix.
		expect(LIBRARY_RESCAN_EVENT).toBe('music-library:rescan');
	});
});
