import { describe, it, expect } from 'vitest';
import { runConcurrently } from '$lib/podcast/refresh';

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('runConcurrently — parallel podcast feed refresh', () => {
	it('runs tasks concurrently, not serially (N feeds ≈ one latency, not N×)', async () => {
		let inFlight = 0;
		let maxInFlight = 0;
		const started = Date.now();

		// 6 tasks, each 40ms. Sequential would be ~240ms; parallel (limit 5) ~80ms.
		await runConcurrently([1, 2, 3, 4, 5, 6], async () => {
			inFlight++;
			maxInFlight = Math.max(maxInFlight, inFlight);
			await delay(40);
			inFlight--;
		}, 5);

		const elapsed = Date.now() - started;
		// Prove it was actually parallel: at least 2 tasks in flight at once.
		expect(maxInFlight).toBeGreaterThanOrEqual(2);
		// And it finished far faster than serial (6 × 40 = 240ms).
		expect(elapsed).toBeLessThan(200);
	});

	it('handles an empty list', async () => {
		await expect(runConcurrently([], async () => {})).resolves.toBeUndefined();
	});
});
