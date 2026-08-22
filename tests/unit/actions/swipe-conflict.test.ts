import { describe, it, expect, vi, afterEach } from 'vitest';
import { swipeItem } from '$lib/actions/swipeItem';
import { swipeBack } from '$lib/actions/touch';

// Reproduces the browse-view gesture conflict: each file row has swipeItem
// (left swipe reveals Download, 160px) nested inside a container that has
// swipeBack (left swipe past 60px navigates back). A left swipe on a row must
// reveal the row and NOT fire the container's back navigation.
function makeDom() {
	document.body.innerHTML = '<div data-container><div data-row></div></div>';
	const container = document.querySelector('[data-container]') as HTMLElement;
	const row = document.querySelector('[data-row]') as HTMLElement;
	const onBack = vi.fn();
	const onReveal = vi.fn();
	const swipeBackCtl = swipeBack(container, { onBack, threshold: 60 });
	const swipeItemCtl = swipeItem(row, { onReveal, threshold: 160 });
	return { container, row, onBack, onReveal, swipeBackCtl, swipeItemCtl };
}

function firePointer(el: HTMLElement, type: string, x: number, y: number, id: number) {
	el.dispatchEvent(new PointerEvent(type, { clientX: x, clientY: y, pointerId: id, bubbles: true }));
}

function fireTouch(el: HTMLElement, type: string, x: number, y: number) {
	const ev = new Event(type, { bubbles: true, cancelable: true }) as Event & {
		touches: { clientX: number; clientY: number }[];
		changedTouches: { clientX: number; clientY: number }[];
	};
	Object.defineProperty(ev, 'touches', { value: [{ clientX: x, clientY: y }] });
	Object.defineProperty(ev, 'changedTouches', { value: [{ clientX: x, clientY: y }] });
	el.dispatchEvent(ev);
}

// A left swipe of 200px starting on the row.
function swipeLeft(row: HTMLElement, container: HTMLElement) {
	fireTouch(row, 'touchstart', 220, 100);
	firePointer(row, 'pointerdown', 220, 100, 1);
	firePointer(row, 'pointermove', 20, 100, 1);
	fireTouch(container, 'touchend', 20, 100);
	firePointer(row, 'pointerup', 20, 100, 1);
}

afterEach(() => { document.body.innerHTML = ''; });

describe('row swipe-to-reveal vs container swipe-back', () => {
	it('BUG: a left swipe on a row fires the container back navigation', () => {
		const { row, container, onReveal, onBack } = makeDom();
		swipeLeft(row, container);
		// The row reveal should be the ONLY effect.
		expect(onReveal).toHaveBeenCalled();
		// But the container's swipe-back also fires — navigating away and
		// undoing the reveal. This is the bug.
		expect(onBack).not.toHaveBeenCalled();
	});
});
