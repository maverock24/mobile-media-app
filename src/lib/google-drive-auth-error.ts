const ANDROID_OAUTH_CONFIGURATION_ERROR =
	'Google Drive Android sign-in is misconfigured for this APK. Add or update the Android OAuth client for package com.maverock24.mobilemediaapp with the SHA-1/SHA-256 of the key used to sign this APK, then rebuild.';

export function formatGoogleDriveAuthError(error: unknown): string {
	const message = error instanceof Error ? error.message : 'Unable to access Google Drive.';

	if (/popup_closed|popup closed|access denied|interrupted/i.test(message)) {
		return 'Google sign-in was cancelled.';
	}

	if (/public_google_client_id/i.test(message)) {
		return 'Google Drive is not configured. Add PUBLIC_GOOGLE_CLIENT_ID to enable sign-in.';
	}

	if (/developer_error|status\s*10|did not return an access token|android oauth client|signing certificate/i.test(message)) {
		return ANDROID_OAUTH_CONFIGURATION_ERROR;
	}

	if (/network error|status\s*7/i.test(message)) {
		return 'Google Drive sign-in failed because the device could not reach Google. Check connectivity and Google Play services, then try again.';
	}

	if (/sign-?in required|status\s*4/i.test(message)) {
		return 'Google Drive sign-in needs account confirmation. Choose a Google account and try again.';
	}

	return message;
}
