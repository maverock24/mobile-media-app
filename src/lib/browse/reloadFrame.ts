/**
 * reloadFrame.ts — one coalesced callback per animation frame.
 *
 * The browse list is rebuilt from the whole file array (`buildBrowseEntries`), so
 * two reload requests inside one frame are one rebuild. Two callers share this
 * boundary: `browseNavigation.scheduleBrowseEntries` (the view's reload effect)
 * and `deviceLibrary`'s streaming full-walk batch callback, which bumps the browse
 * version at most once per frame instead of once per 500-file batch (D8).
 *
 * The first request schedules a callback; every request made before it runs is
 * absorbed. The callback runs once and the coalescer is free again, so the next
 * frame's request schedules a new run.
 *
 * `requestAnimationFrame` is preferred, with a `setTimeout(..., 0)` fallback:
 * jsdom does not always expose it, and a scheduler that throws when it is absent
 * would break every test that drives the reload effect.
 */
export function createFrameCoalescer(run: () => void): () => void {
	let scheduled = false;
	return function request(): void {
		if (scheduled) return;
		scheduled = true;
		// Wrapped so the rAF timestamp is not passed on as an argument.
		const fire = (): void => {
			scheduled = false;
			run();
		};
		if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => fire());
		else setTimeout(fire, 0);
	};
}
