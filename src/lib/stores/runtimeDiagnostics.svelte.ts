const RUNTIME_DIAGNOSTICS_KEY = 'runtime-diagnostics';
const MAX_RUNTIME_DIAGNOSTICS = 20;

export type RuntimeDiagnosticSource = 'error' | 'unhandledrejection' | 'console.error';

export interface StoredRuntimeError {
	recordedAt: number;
	source: RuntimeDiagnosticSource;
	message: string;
	stack: string;
	details: string;
	href: string;
	activeTab: string;
	userAgent: string;
}

type RuntimeDiagnosticsState = {
	lastRuntimeError: StoredRuntimeError | null;
	recentRuntimeErrors: StoredRuntimeError[];
};

function isStoredRuntimeError(value: unknown): value is StoredRuntimeError {
	if (!value || typeof value !== 'object') return false;
	const record = value as Record<string, unknown>;
	return typeof record.recordedAt === 'number'
		&& (record.source === 'error' || record.source === 'unhandledrejection' || record.source === 'console.error')
		&& typeof record.message === 'string'
		&& typeof record.stack === 'string'
		&& typeof record.details === 'string'
		&& typeof record.href === 'string'
		&& typeof record.activeTab === 'string'
		&& typeof record.userAgent === 'string';
}

function isStoredRuntimeErrorList(value: unknown): value is StoredRuntimeError[] {
	return Array.isArray(value) && value.every(isStoredRuntimeError);
}

function readStoredDiagnostics(): RuntimeDiagnosticsState {
	if (typeof localStorage === 'undefined') {
		return { lastRuntimeError: null, recentRuntimeErrors: [] };
	}

	try {
		const raw = localStorage.getItem(RUNTIME_DIAGNOSTICS_KEY);
		if (!raw) return { lastRuntimeError: null, recentRuntimeErrors: [] };
		const parsed = JSON.parse(raw) as { lastRuntimeError?: unknown; recentRuntimeErrors?: unknown };
		const recentRuntimeErrors = isStoredRuntimeErrorList(parsed.recentRuntimeErrors)
			? parsed.recentRuntimeErrors.slice(0, MAX_RUNTIME_DIAGNOSTICS)
			: (isStoredRuntimeError(parsed.lastRuntimeError) ? [parsed.lastRuntimeError] : []);
		return {
			lastRuntimeError: recentRuntimeErrors[0] ?? null,
			recentRuntimeErrors
		};
	} catch {
		return { lastRuntimeError: null, recentRuntimeErrors: [] };
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
			lastRuntimeError: runtimeDiagnostics.lastRuntimeError,
			recentRuntimeErrors: runtimeDiagnostics.recentRuntimeErrors
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

function buildStoredRuntimeError(input: {
	source: RuntimeDiagnosticSource;
	message: string;
	stack?: string;
	details?: string;
	href?: string;
	activeTab?: string;
	userAgent?: string;
}): StoredRuntimeError {
	return {
		recordedAt: Date.now(),
		source: input.source,
		message: input.message || 'Unknown runtime error',
		stack: input.stack ?? '',
		details: input.details ?? '',
		href: input.href ?? (typeof window !== 'undefined' ? window.location.href : ''),
		activeTab: input.activeTab ?? '',
		userAgent: input.userAgent ?? (typeof navigator !== 'undefined' ? navigator.userAgent : '')
	};
}

function appendRuntimeError(entry: StoredRuntimeError): void {
	const previous = runtimeDiagnostics.recentRuntimeErrors[0];
	const isDuplicateOfPrevious = Boolean(previous)
		&& previous.source === entry.source
		&& previous.message === entry.message
		&& previous.stack === entry.stack
		&& previous.details === entry.details
		&& previous.href === entry.href
		&& previous.activeTab === entry.activeTab;

	runtimeDiagnostics.recentRuntimeErrors = isDuplicateOfPrevious
		? [entry, ...runtimeDiagnostics.recentRuntimeErrors.slice(1, MAX_RUNTIME_DIAGNOSTICS)]
		: [entry, ...runtimeDiagnostics.recentRuntimeErrors].slice(0, MAX_RUNTIME_DIAGNOSTICS);
	runtimeDiagnostics.lastRuntimeError = runtimeDiagnostics.recentRuntimeErrors[0] ?? null;
	flushDiagnostics();
}

export function recordRuntimeError(input: {
	source: RuntimeDiagnosticSource;
	message: string;
	stack?: string;
	details?: string;
	href?: string;
	activeTab?: string;
	userAgent?: string;
}): void {
	appendRuntimeError(buildStoredRuntimeError(input));
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

export function recordConsoleError(args: unknown[], activeTab: string): void {
	const firstError = args.find((value): value is Error => value instanceof Error);
	const firstString = args.find((value): value is string => typeof value === 'string' && value.trim().length > 0);
	const firstObjectWithMessage = args.find((value): value is { message: string } => {
		if (!value || typeof value !== 'object') return false;
		const record = value as Record<string, unknown>;
		return typeof record.message === 'string' && record.message.trim().length > 0;
	});
	const message = firstError?.message
		|| firstString
		|| firstObjectWithMessage?.message
		|| 'console.error';
	const stack = firstError?.stack ?? '';
	const details = args.map(stringifyUnknown).filter(Boolean).join('\n\n');

	recordRuntimeError({
		source: 'console.error',
		message,
		stack,
		details,
		activeTab
	});
}

export function clearStoredRuntimeError(): void {
	runtimeDiagnostics.lastRuntimeError = null;
	runtimeDiagnostics.recentRuntimeErrors = [];
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

export function formatRuntimeErrorHistoryReport(errors: StoredRuntimeError[]): string {
	if (errors.length === 0) {
		return '';
	}

	return errors
		.map((error, index) => [`Entry ${index + 1} of ${errors.length}`, formatRuntimeErrorReport(error)].join('\n'))
		.join('\n\n----------------------------------------\n\n');
}