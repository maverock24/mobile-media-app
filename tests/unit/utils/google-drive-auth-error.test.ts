import { describe, it, expect } from 'vitest';
import { formatGoogleDriveAuthError } from '$lib/google-drive-auth-error';

describe('formatGoogleDriveAuthError', () => {
	it('returns cancellation message for popup_closed', () => {
		expect(formatGoogleDriveAuthError(new Error('popup_closed by user'))).toBe(
			'Google sign-in was cancelled.',
		);
	});

	it('returns cancellation message for popup closed', () => {
		expect(formatGoogleDriveAuthError(new Error('popup closed'))).toBe(
			'Google sign-in was cancelled.',
		);
	});

	it('returns cancellation message for access denied', () => {
		expect(formatGoogleDriveAuthError(new Error('access denied'))).toBe(
			'Google sign-in was cancelled.',
		);
	});

	it('returns cancellation message for interrupted', () => {
		expect(formatGoogleDriveAuthError(new Error('Sign-in interrupted'))).toBe(
			'Google sign-in was cancelled.',
		);
	});

	it('returns misconfiguration error for developer_error', () => {
		const result = formatGoogleDriveAuthError(new Error('developer_error: bad config'));
		expect(result).toContain('misconfigured');
	});

	it('returns misconfiguration error for status 10', () => {
		expect(formatGoogleDriveAuthError(new Error('status 10 error'))).toContain('misconfigured');
	});

	it('returns misconfiguration error for Android OAuth client mention', () => {
		expect(
			formatGoogleDriveAuthError(new Error('android oauth client mismatch')),
		).toContain('misconfigured');
	});

	it('returns misconfiguration error for signing certificate', () => {
		expect(
			formatGoogleDriveAuthError(new Error('signing certificate mismatch')),
		).toContain('misconfigured');
	});

	it('returns network error for network error message', () => {
		expect(formatGoogleDriveAuthError(new Error('network error occurred'))).toBe(
			'Google Drive sign-in failed because the device could not reach Google. Check connectivity and Google Play services, then try again.',
		);
	});

	it('returns network error for status 7', () => {
		const result = formatGoogleDriveAuthError(new Error('status 7'));
		expect(result).toContain('could not reach Google');
	});

	it('returns sign-in required for status 4', () => {
		const result = formatGoogleDriveAuthError(new Error('status 4'));
		expect(result).toContain('account confirmation');
	});

	it('returns sign-in required for sign-in required message', () => {
		const result = formatGoogleDriveAuthError(new Error('sign-in required'));
		expect(result).toContain('account confirmation');
	});

	it('returns PUBLIC_GOOGLE_CLIENT_ID message', () => {
		expect(
			formatGoogleDriveAuthError(new Error('Missing PUBLIC_GOOGLE_CLIENT_ID')),
		).toBe('Google Drive is not configured. Add PUBLIC_GOOGLE_CLIENT_ID to enable sign-in.');
	});

	it('falls back to original message for unknown errors', () => {
		expect(formatGoogleDriveAuthError(new Error('Something weird happened'))).toBe(
			'Something weird happened',
		);
	});

	it('handles non-Error objects (plain string falls back to generic message)', () => {
		// Strings are not instanceof Error → generic fallback
		expect(formatGoogleDriveAuthError('plain string error')).toBe('Unable to access Google Drive.');
	});

	it('handles null input', () => {
		expect(formatGoogleDriveAuthError(null)).toBe('Unable to access Google Drive.');
	});

	it('handles undefined input', () => {
		expect(formatGoogleDriveAuthError(undefined)).toBe('Unable to access Google Drive.');
	});

	it('handles object without message property', () => {
		expect(formatGoogleDriveAuthError({ code: 500 })).toBe('Unable to access Google Drive.');
	});

	// ── edge cases ──

	it('case-insensitive matching for popup/cancel messages', () => {
		expect(formatGoogleDriveAuthError(new Error('POPUP_CLOSED'))).toBe(
			'Google sign-in was cancelled.',
		);
		expect(formatGoogleDriveAuthError(new Error('Access Denied'))).toBe(
			'Google sign-in was cancelled.',
		);
	});

	it('regex special characters in message are safe', () => {
		// Messages with regex-special chars like ( ) [ ] * + should not throw
		expect(() => formatGoogleDriveAuthError(new Error('test (parens) [brackets] * + ?'))).not.toThrow();
	});

	it('empty string error message', () => {
		expect(formatGoogleDriveAuthError(new Error(''))).toBe('');
	});
});
