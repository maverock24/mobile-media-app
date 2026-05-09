const RUNTIME_DIAGNOSTICS_KEY = 'runtime-diagnostics';

export interface StoredRuntimeError {
	recordedAt: number;
	source: 'error' | 'unhandledrejection';
	message: string;
	stack: string;
	details: string;
	href: string;
	activeTab: string;
	userAgent: string;
}

type RuntimeDiagnosticsState = {
	lastRuntimeError: StoredRuntimeError | null;
};

function isStoredRuntimeError(value: unknown): value is StoredRuntimeError {
	if (!value || typeof value !== 'object') return false;
	const record = value as Record<string, unknown>;
	return typeof record.recordedAt === 'number'
		&& (record.source === 'error' || record.source === 'unhandledrejection')
		&& typeof record.message === 'string'
		&& typeof record.stack === 'string'
		&& typeof record.details === 'string'
		&& typeof record.href === 'string'
		&& typeof record.activeTab === 'string'
		&& typeof record.userAgent === 'string';
}

function readStoredDiagnostics(): RuntimeDiagnosticsState {
	if (typeof localStorage === 'undefined') {
		return { lastRuntimeError: null };
	}

	try {
		const raw = localStorage.getItem(RUNTIME_DIAGNOSTICS_KEY);
		if (!raw) return { lastRuntimeError: null };
		const parsed = JSON.parse(raw) as { lastRuntimeError?: unknown };
		return {
			lastRuntimeError: isStoredRuntimeError(parsed.lastRuntimeError) ? parsed.lastRuntimeError : null
		};
	} catch {
		return { lastRuntimeError: null };
	}
}

export const runtimeDiagnostics = $state<RuntimeDiagnosticsState>(readStoredDiagnostics());

function flushDiagnostics(): void {
	if (typeof localStorage === 'undefined') return;

	try {
		if (!runtimeDiagnostics.lastRuntimeError) {
			localStorage.removeItem(RUNTIME_DIAGNOSTICS_KEY);
			return;
		}

		localStorage.setItem(RUNTIME_DIAGNOSTICS_KEY, JSON.stringify({
			lastRuntimeError: runtimeDiagnostics.lastRuntimeError
		}));
	} catch {
		// Ignore storage failures — crash logging should never crash the app.
	}
}

function stringifyUnknown(value: unknown): string {
	if (typeof value === 'string') return value;
	if (value instanceof Error) return value.stack || value.message;

	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
}

function normalizeUnknownError(value: unknown): { message: string; stack: string; details: string } {
	if (value instanceof Error) {
		return {
			message: value.message || value.name || 'Unknown runtime error',
			stack: value.stack || '',
			details: ''
		};
	}

	if (typeof value === 'string') {
		return {
			message: value || 'Unknown runtime error',
			stack: '',
			details: ''
		};
	}

	if (value && typeof value === 'object') {
		const record = value as Record<string, unknown>;
		return {
			message: typeof record.message === 'string' ? record.message : 'Unhandled promise rejection',
			stack: typeof record.stack === 'string' ? record.stack : '',
			details: stringifyUnknown(value)
		};
	}

	return {
		message: 'Unknown runtime error',
		stack: '',
		details: stringifyUnknown(value)
	};
}

export function recordRuntimeError(input: {
	source: StoredRuntimeError['source'];
	message: string;
	stack?: string;
	details?: string;
	href?: string;
	activeTab?: string;
	userAgent?: string;
}): void {
	runtimeDiagnostics.lastRuntimeError = {
		recordedAt: Date.now(),
		source: input.source,
		message: input.message || 'Unknown runtime error',
		stack: input.stack ?? '',
		details: input.details ?? '',
		href: input.href ?? (typeof window !== 'undefined' ? window.location.href : ''),
		activeTab: input.activeTab ?? '',
		userAgent: input.userAgent ?? (typeof navigator !== 'undefined' ? navigator.userAgent : '')
	};
	flushDiagnostics();
}

export function recordWindowErrorEvent(event: ErrorEvent, activeTab: string): void {
	const normalized = normalizeUnknownError(event.error ?? event.message);
	const location = event.filename
		? `${event.filename}:${event.lineno || 0}:${event.colno || 0}`
		: '';

	recordRuntimeError({
		source: 'error',
		message: normalized.message || event.message || 'Unhandled runtime error',
		stack: normalized.stack,
		details: location || normalized.details,
		activeTab
	});
}

export function recordUnhandledRejection(reason: unknown, activeTab: string): void {
	const normalized = normalizeUnknownError(reason);
	recordRuntimeError({
		source: 'unhandledrejection',
		message: normalized.message || 'Unhandled promise rejection',
		stack: normalized.stack,
		details: normalized.details,
		activeTab
	});
}

export function clearStoredRuntimeError(): void {
	runtimeDiagnostics.lastRuntimeError = null;
	flushDiagnostics();
}

export function formatRuntimeErrorReport(error: StoredRuntimeError): string {
	const lines = [
		`Recorded: ${new Date(error.recordedAt).toISOString()}`,
		`Source: ${error.source}`,
		error.activeTab ? `Tab: ${error.activeTab}` : '',
		error.href ? `URL: ${error.href}` : '',
		`Message: ${error.message}`,
		error.details ? `Details: ${error.details}` : '',
		error.stack ? `Stack:\n${error.stack}` : '',
		error.userAgent ? `User agent: ${error.userAgent}` : ''
	].filter(Boolean);

	return lines.join('\n\n');
}