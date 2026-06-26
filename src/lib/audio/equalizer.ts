/**
 * Shared Web Audio equalizer helpers.
 *
 * Both the global media engine (radio/podcast slots) and the MP3 player keep
 * their own AudioContext, but the filter-chain construction and gain-application
 * logic is identical — centralised here to avoid drift.
 */
import { EQ_FREQS } from '$lib/models/music';

/**
 * Create a chained biquad EQ filter bank for the given context.
 *
 * The filters are piped together (`filters[i] -> filters[i+1]`); the caller is
 * responsible for connecting the audio source to `filters[0]` and the last
 * filter to a destination node.
 *
 * @param ctx   The AudioContext to create the nodes on.
 * @param gains Optional initial gain values (dB) per band; defaults to 0 (flat).
 */
export function createEqFilterChain(ctx: AudioContext, gains: number[] = []): BiquadFilterNode[] {
	const filters = EQ_FREQS.map((freq, i) => {
		const f = ctx.createBiquadFilter();
		f.type = (i === 0
			? 'lowshelf'
			: i === EQ_FREQS.length - 1
				? 'highshelf'
				: 'peaking') as BiquadFilterType;
		f.frequency.value = freq;
		if (f.type === 'peaking') f.Q.value = 1.4;
		f.gain.value = gains[i] ?? 0;
		return f;
	});
	for (let i = 0; i < filters.length - 1; i++) {
		filters[i].connect(filters[i + 1]);
	}
	return filters;
}

/** Apply gain values (dB) to an existing filter chain. Missing entries are skipped. */
export function applyEqGains(filters: BiquadFilterNode[], gains: number[]): void {
	filters.forEach((f, i) => {
		if (gains[i] !== undefined) f.gain.value = gains[i];
	});
}
