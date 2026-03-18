/**
 * Validation utilities for URLs and data
 */

/**
 * Validates that a URL is a proper HTTPS URL
 * @param url - The URL to validate
 * @returns true if valid, false otherwise
 */
export function isValidAudioUrl(url: string | undefined): boolean {
	if (!url || typeof url !== 'string') {
		return false;
	}

	try {
		const urlObj = new URL(url);
		// Only accept HTTPS URLs
		return urlObj.protocol === 'https:';
	} catch {
		return false;
	}
}
