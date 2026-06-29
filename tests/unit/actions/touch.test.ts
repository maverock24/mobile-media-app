import { describe, it, expect, vi } from 'vitest';
import { pullToRefresh, swipeBack } from '$lib/actions/touch';

/** Dispatch a touch event with the given clientX/clientY on `el`. */
function touch(el: HTMLElement, type: string, x: number, y: number): void {
	const touch = { clientX: x, clientY: y } as Touch;
	const evt = new Event(type, { bubbles: true });
	// jsdom TouchEvent is limited; the actions read e.touches[0]/changedTouches[0].
	Object.defineProperty(evt, 'touches', { value: [touch], configurable: true });
	Object.defineProperty(evt, 'changedTouches', { value: [touch], configurable: true });
	el.dispatchEvent(evt);
}

describe('swipeBack', () => {
	it('fires onBack on a predominantly-horizontal left swipe', () => {
		const el = document.createElement('div');
		const onBack = vi.fn();
		const action = swipeBack(el, { onBack });
		touch(el, 'touchstart', 200, 100);
		touch(el, 'touchend', 100, 105); // dx=-100, dy=5 -> horizontal
		expect(onBack).toHaveBeenCalledTimes(1);
		action.destroy();
	});

	it('does not fire for a small swipe under threshold', () => {
		const el = document.createElement('div');
		const onBack = vi.fn();
		const action = swipeBack(el, { onBack, threshold: 60 });
		touch(el, 'touchstart', 100, 100);
		touch(el, 'touchend', 80, 100); // dx=-20 < 60
		expect(onBack).not.toHaveBeenCalled();
		action.destroy();
	});

	it('does not fire for a vertical gesture', () => {
		const el = document.createElement('div');
		const onBack = vi.fn();
		const action = swipeBack(el, { onBack });
		touch(el, 'touchstart', 100, 100);
		touch(el, 'touchend', 90, 300); // |dy| >> |dx|
		expect(onBack).not.toHaveBeenCalled();
		action.destroy();
	});

	it('update() swaps the handler', () => {
		const el = document.createElement('div');
		const a = vi.fn();
		const b = vi.fn();
		const action = swipeBack(el, { onBack: a });
		action.update({ onBack: b });
		touch(el, 'touchstart', 200, 100);
		touch(el, 'touchend', 100, 100);
		expect(a).not.toHaveBeenCalled();
		expect(b).toHaveBeenCalledTimes(1);
		action.destroy();
	});
});

describe('pullToRefresh', () => {
	it('calls onRefresh when the drag crosses the threshold', () => {
		const el = document.createElement('div');
		// pullToRefresh only activates when scrollTop === 0; jsdom defaults to 0.
		const onRefresh = vi.fn();
		const onUpdate = vi.fn();
		const action = pullToRefresh(el, { onRefresh, onUpdate, threshold: 64 });
		touch(el, 'touchstart', 0, 0);
		// dy = 200 -> damped to min(200*0.45, 64+20)=84 >= 64
		touch(el, 'touchmove', 0, 200);
		touch(el, 'touchend', 0, 200);
		expect(onRefresh).toHaveBeenCalledTimes(1);
		expect(onUpdate).toHaveBeenCalledWith(84);
		action.destroy();
	});

	it('does not refresh below threshold', () => {
		const el = document.createElement('div');
		const onRefresh = vi.fn();
		const action = pullToRefresh(el, { onRefresh, threshold: 64 });
		touch(el, 'touchstart', 0, 0);
		touch(el, 'touchmove', 0, 50); // damped ~22 < 64
		touch(el, 'touchend', 0, 50);
		expect(onRefresh).not.toHaveBeenCalled();
		action.destroy();
	});

	it('deactivates on an upward (negative) drag', () => {
		const el = document.createElement('div');
		const onRefresh = vi.fn();
		const onUpdate = vi.fn();
		const action = pullToRefresh(el, { onRefresh, onUpdate });
		touch(el, 'touchstart', 0, 100);
		touch(el, 'touchmove', 0, 50); // dy = -50 -> deactivates, resets
		touch(el, 'touchend', 0, 50);
		expect(onRefresh).not.toHaveBeenCalled();
		expect(onUpdate).toHaveBeenLastCalledWith(0);
		action.destroy();
	});
});
