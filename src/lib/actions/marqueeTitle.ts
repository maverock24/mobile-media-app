/**
 * Svelte action: marqueeTitle
 * Adds 'is-active' class when the element overflows AND the `active` param is true.
 * Usage: <p use:marqueeTitle={{ active: isCurrentTrack }} class="title-marquee">...</p>
 */
export function marqueeTitle(node: HTMLElement, params: { active: boolean } = { active: false }) {
	let observer: ResizeObserver | null = null;
	let active = false;

	function check() {
		requestAnimationFrame(() => {
			const overflows = node.scrollWidth > node.clientWidth + 1;
			const shouldBeActive = overflows && params.active;
			if (shouldBeActive !== active) {
				active = shouldBeActive;
				node.classList.toggle('is-active', shouldBeActive);
			}
		});
	}

	queueMicrotask(check);

	if (typeof ResizeObserver !== 'undefined') {
		observer = new ResizeObserver(() => check());
		observer.observe(node);
	}

	return {
		update(newParams: { active: boolean }) {
			params = newParams;
			queueMicrotask(check);
		},
		destroy() {
			if (observer) observer.disconnect();
			node.classList.remove('is-active');
		}
	};
}
