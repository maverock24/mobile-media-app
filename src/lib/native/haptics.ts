import { Capacitor } from '@capacitor/core';
import { Haptics, ImpactStyle } from '@capacitor/haptics';
import { appSettings } from '$lib/stores/settings.svelte';

const canUseAndroidHaptics =
	typeof window !== 'undefined' &&
	Capacitor.isNativePlatform() &&
	Capacitor.getPlatform() === 'android';

async function runHaptic(action: () => Promise<void>): Promise<void> {
	if (!canUseAndroidHaptics || !appSettings.hapticFeedback) return;
	try {
		await action();
	} catch {
		// Ignore unsupported hardware or plugin errors so interactions stay resilient.
	}
}

export function triggerTabHaptic(): Promise<void> {
	return runHaptic(() => Haptics.impact({ style: ImpactStyle.Light }));
}

export function triggerSwipeBackHaptic(): Promise<void> {
	return runHaptic(() => Haptics.impact({ style: ImpactStyle.Light }));
}

export function triggerPlaybackHaptic(isStarting: boolean): Promise<void> {
	return runHaptic(() => Haptics.impact({ style: isStarting ? ImpactStyle.Medium : ImpactStyle.Light }));
}

export function triggerToggleHaptic(isEnabled: boolean): Promise<void> {
	return runHaptic(() => Haptics.impact({ style: isEnabled ? ImpactStyle.Medium : ImpactStyle.Light }));
}