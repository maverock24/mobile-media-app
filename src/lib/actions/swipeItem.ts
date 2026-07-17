/**
 * Per-list-item horizontal swipe-to-reveal action.
 *
 * Drag the item left past `threshold` pixels to trigger `onReveal`.
 * The item translates with the finger; on release it either fires the
 * callback (if past threshold) or springs back.
 *
 * Usage:
 * ```svelte
 * <div use:swipeItem={{ threshold: 80, onReveal: () => handleAction() }}>
 * ```
 */

export interface SwipeItemParams {
	/** Pixels of horizontal drag required to trigger the action. */
	threshold?: number;
	/** Called when the user releases after dragging past the threshold. */
	onReveal?: () => void;
}

export function swipeItem(node: HTMLElement, params: SwipeItemParams = {}) {
	const threshold = params.threshold ?? 80;
	let onReveal = params.onReveal;

	let startX = 0;
	let startY = 0;
	let currentX = 0;
	let dragging = false;
	let captured = false;
	let revealed = false;

	function onPointerDown(e: PointerEvent) {
		if (e.pointerType === 'mouse' && e.button !== 0) return;
		startX = e.clientX;
		startY = e.clientY;
		currentX = 0;
		dragging = true;
		captured = false;
		revealed = false;
		node.style.transition = 'none';
		// Don't capture yet — let taps through to child buttons.
		// Capture only after the user has dragged past a small threshold.
	}

	function onPointerMove(e: PointerEvent) {
		if (!dragging) return;
		const dx = e.clientX - startX;
		const dy = e.clientY - startY;

		if (Math.abs(dx) < Math.abs(dy) * 1.2) {
			if (Math.abs(dy) > 10) {
				dragging = false;
				node.style.transform = '';
				node.style.transition = 'transform 0.2s ease';
				if (captured) node.releasePointerCapture(e.pointerId);
			}
			return;
		}

		// Capture pointer once we know it's a horizontal swipe
		if (!captured && Math.abs(dx) > 5) {
			captured = true;
			try { node.setPointerCapture(e.pointerId); } catch {}
		}

		currentX = Math.min(0, Math.max(dx, -threshold * 1.5));
		node.style.transform = `translateX(${currentX}px)`;
	}

	function onPointerUp(e: PointerEvent) {
		if (!dragging) return;
		dragging = false;
		if (captured) {
			try { node.releasePointerCapture(e.pointerId); } catch {}
			captured = false;
		}
		node.style.transition = 'transform 0.2s ease';

		if (currentX <= -threshold) {
			// Snap to revealed position
			node.style.transform = `translateX(${-threshold}px)`;
			if (!revealed) {
				revealed = true;
				onReveal?.();
			}
		} else {
			// Spring back
			node.style.transform = '';
			revealed = false;
		}

		// Reset after animation
		setTimeout(() => {
			if (!dragging && !revealed) {
				node.style.transform = '';
			}
		}, 250);
	}

	node.addEventListener('pointerdown', onPointerDown);
	node.addEventListener('pointermove', onPointerMove);
	node.addEventListener('pointerup', onPointerUp);
	node.addEventListener('pointercancel', onPointerUp);
	node.style.touchAction = 'pan-y'; // allow vertical scroll

	return {
		update(newParams: SwipeItemParams) {
			onReveal = newParams.onReveal;
		},
		destroy() {
			node.removeEventListener('pointerdown', onPointerDown);
			node.removeEventListener('pointermove', onPointerMove);
			node.removeEventListener('pointerup', onPointerUp);
			node.removeEventListener('pointercancel', onPointerUp);
		},
	};
}
