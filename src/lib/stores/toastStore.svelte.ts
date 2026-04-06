/**
 * Lightweight reactive toast notification store.
 *
 * Usage:
 *   import { addToast, dismissToast, toasts } from '$lib/stores/toastStore.svelte';
 *   addToast({ message: 'Playback failed.', type: 'error' });
 */

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface ToastAction {
	label: string;
	handler: () => void;
}

export interface Toast {
	id: string;
	message: string;
	type: 'error' | 'warning' | 'info';
	action?: ToastAction;
	autoDismissMs: number;
}

export interface AddToastOptions {
	message: string;
	type?: 'error' | 'warning' | 'info';
	action?: ToastAction;
	/** Milliseconds before auto-dismiss. 0 = manual dismiss only. Default: 5000. */
	autoDismissMs?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// State
// ─────────────────────────────────────────────────────────────────────────────

let _nextId = 1;
const _timers = new Map<string, ReturnType<typeof setTimeout>>();

export const toasts = $state<Toast[]>([]);

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

export function addToast(options: AddToastOptions): string {
	const id = `toast-${_nextId++}`;
	const toast: Toast = {
		id,
		message: options.message,
		type: options.type ?? 'error',
		action: options.action,
		autoDismissMs: options.autoDismissMs ?? 5000
	};

	toasts.push(toast);

	// Auto-dismiss after timeout (unless disabled with 0)
	if (toast.autoDismissMs > 0) {
		const timer = setTimeout(() => dismissToast(id), toast.autoDismissMs);
		_timers.set(id, timer);
	}

	return id;
}

export function dismissToast(id: string): void {
	const idx = toasts.findIndex(t => t.id === id);
	if (idx !== -1) toasts.splice(idx, 1);

	const timer = _timers.get(id);
	if (timer !== undefined) {
		clearTimeout(timer);
		_timers.delete(id);
	}
}
