/**
 * Safe localStorage helpers with JSON serialisation.
 *
 * Use these instead of raw `localStorage.getItem`/`setItem` so that:
 * - JSON parse/stringify is handled once
 * - Missing keys return the fallback value
 * - QuotaExceededError is caught silently
 * - SSR (typeof localStorage === 'undefined') is handled
 */

export function getJSON<T>(key: string, fallback: T): T {
	if (typeof localStorage === 'undefined') return fallback;
	try {
		const raw = localStorage.getItem(key);
		if (raw === null) return fallback;
		return JSON.parse(raw) as T;
	} catch {
		return fallback;
	}
}

export function setJSON(key: string, value: unknown): void {
	if (typeof localStorage === 'undefined') return;
	try {
		localStorage.setItem(key, JSON.stringify(value));
	} catch {
		// Quota exceeded or storage unavailable — silently ignore.
	}
}

export function removeJSON(key: string): void {
	if (typeof localStorage === 'undefined') return;
	try {
		localStorage.removeItem(key);
	} catch {
		// silently ignore
	}
}
