import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
	formatSleepTimerRemaining,
	syncSleepTimer,
	setSleepTimer,
	clearSleepTimer,
	sleepTimer,
} from '$lib/stores/sleepTimer.svelte';

// ─────────────────────────────────────────────────────────────
// formatSleepTimerRemaining — pure function
// ─────────────────────────────────────────────────────────────

describe('formatSleepTimerRemaining', () => {
	it('returns "Off" for 0 or negative', () => {
		expect(formatSleepTimerRemaining(0)).toBe('Off');
		expect(formatSleepTimerRemaining(-1)).toBe('Off');
		expect(formatSleepTimerRemaining(-1000)).toBe('Off');
	});

	it('formats seconds only (< 60s)', () => {
		expect(formatSleepTimerRemaining(1000)).toBe('1s');
		expect(formatSleepTimerRemaining(5000)).toBe('5s');
		expect(formatSleepTimerRemaining(59000)).toBe('59s');
	});

	it('formats minutes and seconds (60s to < 3600s)', () => {
		expect(formatSleepTimerRemaining(60000)).toBe('1m 00s');
		expect(formatSleepTimerRemaining(65000)).toBe('1m 05s');
		expect(formatSleepTimerRemaining(900000)).toBe('15m 00s');
		expect(formatSleepTimerRemaining(3599000)).toBe('59m 59s');
	});

	it('formats hours and minutes (>= 3600s)', () => {
		expect(formatSleepTimerRemaining(3600000)).toBe('1h 00m');
		expect(formatSleepTimerRemaining(3660000)).toBe('1h 01m');
		expect(formatSleepTimerRemaining(7200000)).toBe('2h 00m');
		expect(formatSleepTimerRemaining(9000000)).toBe('2h 30m');
	});

	it('ceils partial seconds', () => {
		expect(formatSleepTimerRemaining(1001)).toBe('2s');
		expect(formatSleepTimerRemaining(59999)).toBe('1m 00s'); // 59.999s ceils to 60s = 1m
		expect(formatSleepTimerRemaining(120001)).toBe('2m 01s');
	});

	it('pads minutes with leading zero in hm format', () => {
		expect(formatSleepTimerRemaining(3600000)).toBe('1h 00m');
		expect(formatSleepTimerRemaining(3660000)).toBe('1h 01m');
		expect(formatSleepTimerRemaining(4500000)).toBe('1h 15m');
	});
});

// ─────────────────────────────────────────────────────────────
// sleepTimer state machine
// ─────────────────────────────────────────────────────────────

describe('sleepTimer state', () => {
	beforeEach(() => {
		// Reset module-level state
		clearSleepTimer({ silent: true });
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-08-08T12:00:00Z'));
	});

	afterEach(() => {
		vi.useRealTimers();
		clearSleepTimer({ silent: true });
	});

	it('is inactive by default', () => {
		expect(sleepTimer.isActive).toBe(false);
		expect(sleepTimer.remainingMs).toBe(0);
		expect(sleepTimer.endsAt).toBe(0);
	});

	it('setSleepTimer activates the timer', () => {
		setSleepTimer(15);
		expect(sleepTimer.isActive).toBe(true);
		expect(sleepTimer.remainingMs).toBeGreaterThan(0);
	});

	it('setSleepTimer sets correct remaining time for 15 min', () => {
		setSleepTimer(15);
		expect(sleepTimer.remainingMs).toBe(15 * 60 * 1000);
	});

	it('setSleepTimer sets correct remaining time for 30 min', () => {
		setSleepTimer(30);
		expect(sleepTimer.remainingMs).toBe(30 * 60 * 1000);
	});

	it('setSleepTimer sets correct remaining time for 45 min', () => {
		setSleepTimer(45);
		expect(sleepTimer.remainingMs).toBe(45 * 60 * 1000);
	});

	it('setSleepTimer sets correct remaining time for 60 min', () => {
		setSleepTimer(60);
		expect(sleepTimer.remainingMs).toBe(60 * 60 * 1000);
	});

	it('setSleepTimer normalizes negative minutes to 1', () => {
		setSleepTimer(-5);
		expect(sleepTimer.remainingMs).toBe(1 * 60 * 1000);
	});

	it('setSleepTimer normalizes zero minutes to 1', () => {
		setSleepTimer(0);
		expect(sleepTimer.remainingMs).toBe(1 * 60 * 1000);
	});

	it('setSleepTimer rounds fractional minutes', () => {
		setSleepTimer(15.7);
		expect(sleepTimer.remainingMs).toBe(16 * 60 * 1000);
	});

	it('clearSleepTimer deactivates the timer', () => {
		setSleepTimer(30);
		expect(sleepTimer.isActive).toBe(true);
		clearSleepTimer({ silent: true });
		expect(sleepTimer.isActive).toBe(false);
		expect(sleepTimer.remainingMs).toBe(0);
	});

	it('clearSleepTimer resets endsAt', () => {
		setSleepTimer(30);
		expect(sleepTimer.endsAt).toBeGreaterThan(0);
		clearSleepTimer({ silent: true });
		expect(sleepTimer.endsAt).toBe(0);
	});

	it('syncSleepTimer updates remaining time as time passes', () => {
		setSleepTimer(15);
		expect(sleepTimer.remainingMs).toBe(15 * 60 * 1000);

		// Advance time by 5 minutes
		vi.advanceTimersByTime(5 * 60 * 1000);
		syncSleepTimer();

		expect(sleepTimer.remainingMs).toBe(10 * 60 * 1000);
	});

	it('syncSleepTimer expires timer when time is up', () => {
		setSleepTimer(15);
		expect(sleepTimer.isActive).toBe(true);

		// Advance past end time
		vi.advanceTimersByTime(16 * 60 * 1000);
		syncSleepTimer();

		expect(sleepTimer.isActive).toBe(false);
		expect(sleepTimer.remainingMs).toBe(0);
	});

	it('syncSleepTimer with no active timer does nothing', () => {
		syncSleepTimer();
		expect(sleepTimer.isActive).toBe(false);
		expect(sleepTimer.remainingMs).toBe(0);
	});

	it('setting a new timer overrides the old one', () => {
		setSleepTimer(30);
		vi.advanceTimersByTime(10 * 60 * 1000);
		syncSleepTimer();
		expect(sleepTimer.remainingMs).toBe(20 * 60 * 1000);

		// Set a new 15 min timer
		setSleepTimer(15);
		expect(sleepTimer.remainingMs).toBe(15 * 60 * 1000);
	});

	it('clearSleepTimer with silent option does not update remaining logic', () => {
		setSleepTimer(15);
		clearSleepTimer({ silent: true });
		expect(sleepTimer.isActive).toBe(false);
		expect(sleepTimer.endsAt).toBe(0);
	});

	it('lastDurationMin is updated on set', () => {
		setSleepTimer(30);
		expect(sleepTimer.lastDurationMin).toBe(30);
	});

	it('lastDurationMin is updated on clear', () => {
		setSleepTimer(45);
		clearSleepTimer({ silent: true });
		// lastDurationMin should persist
		expect(sleepTimer.lastDurationMin).toBe(45);
	});

	// ── edge cases ──

	it('timer at exactly boundary (when remaining reaches 0)', () => {
		setSleepTimer(1);
		vi.advanceTimersByTime(60 * 1000);
		syncSleepTimer();
		expect(sleepTimer.remainingMs).toBe(0);
		expect(sleepTimer.isActive).toBe(false);
	});

	it('very long timer (e.g., 480 min = 8h)', () => {
		setSleepTimer(480);
		expect(sleepTimer.remainingMs).toBe(480 * 60 * 1000);
		expect(formatSleepTimerRemaining(sleepTimer.remainingMs)).toBe('8h 00m');
	});
});
