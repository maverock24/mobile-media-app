/**
 * Reusable touch-gesture Svelte actions, extracted from PodcastView (two
 * pull-to-refresh blocks) and Mp3PlayerView (two swipe-back handlers).
 *
 * Each action returns an `update()` so reactive params stay current and a
 * `destroy()` that removes its listeners — mirroring the manual add/remove
 * wiring the views did inline.
 */

// ── Pull-to-refresh ────────────────────────────────────────────
export interface PullToRefreshParams {
	/** Fired when the drag crosses `threshold` on release. */
	onRefresh: () => void;
	/** Live drag distance (px, already damped) for the indicator; called with 0 on reset. */
	onUpdate?: (distance: number) => void;
	/** Drag distance (px) required to trigger a refresh. Default 64. */
	threshold?: number;
}

/** Vertical pull-down-at-top gesture. Sets `onUpdate(distance)` while dragging
 *  and calls `onRefresh()` on release past `threshold`. Only activates when the
 *  element is scrolled to the top. */
export function pullToRefresh(
	node: HTMLElement,
	params: PullToRefreshParams,
): { update(p: PullToRefreshParams): void; destroy(): void } {
	let current = params;
	let startY = 0;
	let active = false;
	let distance = 0;

	const threshold = () => current.threshold ?? 64;

	const onTouchStart = (e: TouchEvent) => {
		if (node.scrollTop === 0) {
			active = true;
			startY = e.touches[0].clientY;
		}
	};
	const onTouchMove = (e: TouchEvent) => {
		if (!active) return;
		const dy = e.touches[0].clientY - startY;
		if (dy > 0) {
			distance = Math.min(dy * 0.45, threshold() + 20);
			e.preventDefault();
			current.onUpdate?.(distance);
		} else {
			active = false;
			distance = 0;
			current.onUpdate?.(0);
		}
	};
	const onTouchEnd = () => {
		if (!active) return;
		const triggered = distance >= threshold();
		active = false;
		distance = 0;
		current.onUpdate?.(0);
		if (triggered) current.onRefresh();
	};

	node.addEventListener('touchstart', onTouchStart, { passive: true });
	node.addEventListener('touchmove', onTouchMove, { passive: false });
	node.addEventListener('touchend', onTouchEnd, { passive: true });

	return {
		update(p) { current = p; },
		destroy() {
			node.removeEventListener('touchstart', onTouchStart);
			node.removeEventListener('touchmove', onTouchMove);
			node.removeEventListener('touchend', onTouchEnd);
		},
	};
}

// ── Swipe-back (left swipe) ────────────────────────────────────
export interface SwipeBackParams {
	/** Fired on a predominantly-horizontal left swipe past `threshold`. */
	onBack: () => void;
	/** Horizontal travel (px) required. Default 60. */
	threshold?: number;
}

/** Left-swipe gesture. Fires `onBack()` when the touch ends having swiped left
 *  past `threshold` with the horizontal motion dominating the vertical
 *  (`|dx| > |dy| * 1.5`), so vertical scrolls never trigger it. Calls
 *  `stopPropagation()` on a match so a stacked pull-to-refresh can't also fire. */
export function swipeBack(
	node: HTMLElement,
	params: SwipeBackParams,
): { update(p: SwipeBackParams): void; destroy(): void } {
	let current = params;
	let startX = 0;
	let startY = 0;

	const threshold = () => current.threshold ?? 60;

	const onTouchStart = (e: TouchEvent) => {
		startX = e.touches[0].clientX;
		startY = e.touches[0].clientY;
	};
	const onTouchEnd = (e: TouchEvent) => {
		const dx = e.changedTouches[0].clientX - startX;
		const dy = e.changedTouches[0].clientY - startY;
		if (dx < -threshold() && Math.abs(dx) > Math.abs(dy) * 1.5) {
			e.stopPropagation();
			current.onBack();
		}
	};

	node.addEventListener('touchstart', onTouchStart, { passive: true });
	node.addEventListener('touchend', onTouchEnd, { passive: true });

	return {
		update(p) { current = p; },
		destroy() {
			node.removeEventListener('touchstart', onTouchStart);
			node.removeEventListener('touchend', onTouchEnd);
		},
	};
}
