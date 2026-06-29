import { describe, it, expect } from 'vitest';
import { createEqFilterChain, applyEqGains } from '$lib/audio/equalizer';
import { EQ_FREQS } from '$lib/models/music';

describe('createEqFilterChain', () => {
	it('creates one biquad per EQ_FREQS band', () => {
		const ctx = new AudioContext();
		const filters = createEqFilterChain(ctx);
		expect(filters).toHaveLength(EQ_FREQS.length);
	});

	it('first band is lowshelf, last is highshelf, rest peaking', () => {
		const ctx = new AudioContext();
		const filters = createEqFilterChain(ctx);
		expect(filters[0].type).toBe('lowshelf');
		expect(filters[filters.length - 1].type).toBe('highshelf');
		for (let i = 1; i < filters.length - 1; i++) {
			expect(filters[i].type).toBe('peaking');
		}
	});

	it('sets filter frequency to the band centre', () => {
		const ctx = new AudioContext();
		const filters = createEqFilterChain(ctx);
		filters.forEach((f, i) => expect(f.frequency.value).toBe(EQ_FREQS[i]));
	});

	it('applies initial gains when provided, defaults to 0', () => {
		const ctx = new AudioContext();
		const gains = [3, -2, 0, 5, -5, 1];
		const filters = createEqFilterChain(ctx, gains);
		filters.forEach((f, i) => expect(f.gain.value).toBe(gains[i]));
		const flat = createEqFilterChain(ctx);
		flat.forEach((f) => expect(f.gain.value).toBe(0));
	});
});

describe('applyEqGains', () => {
	it('updates gains for provided indices only', () => {
		const ctx = new AudioContext();
		const filters = createEqFilterChain(ctx, [0, 0, 0, 0, 0, 0]);
		applyEqGains(filters, [4, undefined, -3] as number[]);
		expect(filters[0].gain.value).toBe(4);
		expect(filters[1].gain.value).toBe(0); // undefined -> untouched
		expect(filters[2].gain.value).toBe(-3);
	});
});
