import { describe, it, expect } from 'vitest';
import { normalizeListTileTone, getListTileToneClasses } from '$lib/utils/listTileTone';
import type { ListTileTone } from '$lib/utils/listTileTone';

describe('normalizeListTileTone', () => {
	it('returns "default" for undefined', () => {
		expect(normalizeListTileTone(undefined)).toBe('default');
	});

	it('returns "default" for null', () => {
		expect(normalizeListTileTone(null)).toBe('default');
	});

	it('returns "default" for unknown string', () => {
		expect(normalizeListTileTone('purple')).toBe('default');
		expect(normalizeListTileTone('blue')).toBe('default');
		expect(normalizeListTileTone('')).toBe('default');
	});

	it('returns "default" for non-string values', () => {
		expect(normalizeListTileTone(42)).toBe('default');
		expect(normalizeListTileTone(true)).toBe('default');
		expect(normalizeListTileTone({})).toBe('default');
		expect(normalizeListTileTone([])).toBe('default');
	});

	it('passes through valid "default"', () => {
		expect(normalizeListTileTone('default')).toBe('default');
	});

	it('passes through valid "slate"', () => {
		expect(normalizeListTileTone('slate')).toBe('slate');
	});

	it('passes through valid "cyan"', () => {
		expect(normalizeListTileTone('cyan')).toBe('cyan');
	});

	it('passes through valid "emerald"', () => {
		expect(normalizeListTileTone('emerald')).toBe('emerald');
	});

	it('passes through valid "amber"', () => {
		expect(normalizeListTileTone('amber')).toBe('amber');
	});

	it('maps legacy "lighter" to "slate"', () => {
		expect(normalizeListTileTone('lighter')).toBe('slate');
	});

	it('is case-sensitive (lowercase only)', () => {
		expect(normalizeListTileTone('Default')).toBe('default');
		expect(normalizeListTileTone('CYAN')).toBe('default');
	});
});

describe('getListTileToneClasses', () => {
	it('"default" tone returns empty classes', () => {
		const result = getListTileToneClasses('default');
		expect(result.rowClass).toBe('');
		expect(result.actionClass).toBe('');
		expect(result.usesTint).toBe(false);
	});

	it('non-default tone returns tone-specific classes', () => {
		for (const tone of ['slate', 'cyan', 'emerald', 'amber'] as ListTileTone[]) {
			if (tone === 'default') continue;
			const result = getListTileToneClasses(tone);
			expect(result.rowClass).toBe(`list-tile-tone-${tone}-row`);
			expect(result.actionClass).toBe(`list-tile-tone-${tone}-action`);
			expect(result.usesTint).toBe(true);
		}
	});

	it('every valid tone produces a result', () => {
		const tones: ListTileTone[] = ['default', 'slate', 'cyan', 'emerald', 'amber'];
		for (const tone of tones) {
			const result = getListTileToneClasses(tone);
			expect(result).toBeDefined();
			expect(typeof result.rowClass).toBe('string');
			expect(typeof result.actionClass).toBe('string');
			expect(typeof result.usesTint).toBe('boolean');
		}
	});
});
