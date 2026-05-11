/**
 * Background Android APK update checker.
 *
 * On startup (native Android only) this silently fetches `latest.json`,
 * compares the remote versionCode against the installed build, and — if a
 * newer version is available — downloads it in the background and surfaces a
 * persistent in-app toast with a one-tap "Install" action.
 */

import { Capacitor, CapacitorHttp } from '@capacitor/core';
import { Filesystem, Directory } from '@capacitor/filesystem';
import { DirectoryReader } from '$lib/native/directory-reader';
import { addToast, dismissToast } from '$lib/stores/toastStore.svelte';
import { env } from '$env/dynamic/public';

// ─── Types ────────────────────────────────────────────────────────────────────

export type AndroidReleaseInfo = {
	version: string;
	versionCode: number;
	versionName: string;
	buildType: 'debug' | 'release';
	fileName: string;
	url: string;
	sizeBytes: number;
	sha256: string;
	publishedAt: string;
	commitSha: string;
	commitUrl: string;
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getReleaseBaseUrl(): string {
	const configured = env.PUBLIC_RELEASE_BASE_URL?.trim().replace(/\/$/, '');
	if (configured) return configured;
	if (Capacitor.isNativePlatform()) return 'https://mobile-media-app-maverock24.netlify.app';
	return '';
}

function resolveReleaseUrl(path: string): string {
	if (/^https?:\/\//i.test(path)) return path;
	const base = getReleaseBaseUrl();
	if (!base) return path;
	return `${base}${path.startsWith('/') ? path : `/${path}`}`;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Silently checks for a newer APK on startup.
 *
 * - Runs only on native Android.
 * - Skips when the installed build has no version code (development builds).
 * - Downloads the APK to the cache directory in the background.
 * - Shows a persistent toast with an "Install" action button when ready.
 * - Any network or filesystem error is silently swallowed so it never
 *   interrupts startup.
 */
export async function checkForAndroidUpdate(): Promise<void> {
	if (!Capacitor.isNativePlatform() || Capacitor.getPlatform() !== 'android') return;

	const installedVersionCode = parseInt(env.PUBLIC_BUILD_VERSION_CODE ?? '0', 10);
	if (installedVersionCode === 0) return; // dev / unversioned build

	try {
		const metaUrl = resolveReleaseUrl(`/releases/android/latest.json?ts=${Date.now()}`);
		const resp = await CapacitorHttp.get({ url: metaUrl });
		if (resp.status !== 200) return;

		const release = resp.data as AndroidReleaseInfo;
		if (release.versionCode <= installedVersionCode) return;

		// Newer version available — download silently before prompting.
		const downloadUrl = resolveReleaseUrl(release.url);
		const { path } = await Filesystem.downloadFile({
			url: downloadUrl,
			path: 'update.apk',
			directory: Directory.Cache,
		});
		if (!path) return;

		// Persistent toast — stays until the user taps Install or dismisses it.
		// We capture the id so the Install handler can dismiss it first.
		let toastId: string;
		toastId = addToast({
			message: `Update ready — ${release.versionName}`,
			type: 'info',
			autoDismissMs: 0,
			action: {
				label: 'Install',
				handler: async () => {
					dismissToast(toastId);
					try {
						await DirectoryReader.installApk({ path });
					} catch {
						addToast({ message: 'Could not launch the installer.', type: 'error' });
					}
				},
			},
		});
	} catch {
		// Silently ignore — background update checks must never surface errors.
	}
}
