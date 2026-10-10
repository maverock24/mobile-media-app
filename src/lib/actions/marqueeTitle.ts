/**
 * Svelte action: marqueeTitle
 * Adds 'is-active' class when the element overflows AND the `active` param is true.
 * While inactive it observes nothing and reads no layout; the row stays CSS-ellipsised.
 * Usage: <p use:marqueeTitle={{ active: isCurrentTrack }} class="title-marquee">...</p>
 */
export function marqueeTitle(node: HTMLElement, params: { active: boolean } = { active: false }) {
	let observer: ResizeObserver | null = null;
	let active = false;

	function check() {
		if (!params.active) return;
		requestAnimationFrame(() => {
			if (!params.active) return;
			const overflows = node.scrollWidth > node.clientWidth + 1;
			if (overflows !== active) {
				active = overflows;
				node.classList.toggle('is-active', overflows);
			}
		});
	}

	function start() {
		if (typeof ResizeObserver !== 'undefined') {
			observer = new ResizeObserver(() => check());
			observer.observe(node);
		}
		check();
	}

	function stop() {
		if (observer) {
			observer.disconnect();
			observer = null;
		}
		active = false;
		node.classList.remove('is-active');
	}

	if (params.active) start();

	return {
		update(newParams: { active: boolean }) {
			const wasActive = params.active;
			params = newParams;
			if (params.active && !wasActive) start();
			else if (!params.active && wasActive) stop();
		},
		destroy() {
			if (observer) observer.disconnect();
			node.classList.remove('is-active');
		}
	};
}
