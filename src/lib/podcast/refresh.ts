/**
 * Podcast refresh orchestration.
 *
 * Runs a set of feed-refresh tasks with a bounded concurrency so refreshing
 * N subscriptions doesn't serialize N network round-trips (the "updating the
 * podcast list takes forever" bug).
 */
export async function runConcurrently<T>(
	items: T[],
	task: (item: T) => Promise<void>,
	limit = 5,
): Promise<void> {
	if (items.length === 0) return;
	const workers = Math.max(1, Math.min(limit, items.length));
	let next = 0;
	await Promise.all(
		Array.from({ length: workers }, async () => {
			while (next < items.length) {
				const i = next++;
				await task(items[i]);
			}
		}),
	);
}
