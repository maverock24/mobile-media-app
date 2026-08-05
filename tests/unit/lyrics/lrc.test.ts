import { describe, it, expect } from 'vitest';
import { parseLrc, findActiveLineIndex } from '$lib/lyrics/lrc';

describe('parseLrc', () => {
	it('parses a simple LRC file', () => {
		const raw = `[00:05.00]First line
[00:10.50]Second line
[00:15.75]Third line`;
		const lines = parseLrc(raw);
		expect(lines).toHaveLength(3);
		expect(lines[0]).toEqual({ time: 5, text: 'First line' });
		expect(lines[1]).toEqual({ time: 10.5, text: 'Second line' });
		expect(lines[2]).toEqual({ time: 15.75, text: 'Third line' });
	});

	it('handles minutes overflow (over 60 seconds)', () => {
		const raw = `[01:30.00]A minute thirty`;
		const lines = parseLrc(raw);
		expect(lines[0]).toEqual({ time: 90, text: 'A minute thirty' });
	});

	it('skips empty lines and ID tags', () => {
		const raw = `[ti:Song Title]
[ar:Artist Name]

[00:03.00]Actual lyric`;
		const lines = parseLrc(raw);
		expect(lines).toHaveLength(1);
		expect(lines[0].text).toBe('Actual lyric');
	});

	it('sorts lines by time', () => {
		const raw = `[00:10.00]Second
[00:05.00]First
[00:15.00]Third`;
		const lines = parseLrc(raw);
		expect(lines[0].time).toBe(5);
		expect(lines[1].time).toBe(10);
		expect(lines[2].time).toBe(15);
	});

	it('handles milliseconds', () => {
		const raw = `[00:00.123]With millis`;
		const lines = parseLrc(raw);
		expect(lines[0].time).toBeCloseTo(0.123, 3);
	});

	it('returns empty array for empty input', () => {
		expect(parseLrc('')).toEqual([]);
		expect(parseLrc('\n\n')).toEqual([]);
	});
});

describe('findActiveLineIndex', () => {
	const lines = [
		{ time: 5, text: 'A' },
		{ time: 10, text: 'B' },
		{ time: 15, text: 'C' },
	];

	it('returns -1 before first line', () => {
		expect(findActiveLineIndex(lines, 0)).toBe(-1);
		expect(findActiveLineIndex(lines, 4)).toBe(-1);
	});

	it('returns correct index during lines', () => {
		expect(findActiveLineIndex(lines, 5)).toBe(0);
		expect(findActiveLineIndex(lines, 7)).toBe(0);
		expect(findActiveLineIndex(lines, 10)).toBe(1);
		expect(findActiveLineIndex(lines, 14)).toBe(1);
	});

	it('returns last index after all lines', () => {
		expect(findActiveLineIndex(lines, 15)).toBe(2);
		expect(findActiveLineIndex(lines, 100)).toBe(2);
	});

	it('returns -1 for empty lines', () => {
		expect(findActiveLineIndex([], 5)).toBe(-1);
	});
});
