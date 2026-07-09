<script lang="ts">
	import '../app.css';
	import favicon from '$lib/assets/favicon.svg';
	import AuroraBackground from '$lib/components/AuroraBackground.svelte';
	import { Capacitor } from '@capacitor/core';
	import { ScreenDim } from '$lib/native/screen-dim';
	import { appSettings } from '$lib/stores/settings.svelte';
	import { onMount } from 'svelte';
	let { children } = $props();

	// ── Screen dimmer – Android native only ──
	// Enables/disables the native dim overlay in sync with lifecycle and settings.
	function applyScreenDim() {
		if (!Capacitor.isNativePlatform()) return;
		if (appSettings.screenDimDelay > 0) {
			const delayMs = appSettings.screenDimDelay * 1000;
			ScreenDim.enable({ delayMs }).catch(() => {});
		} else {
			ScreenDim.disable().catch(() => {});
		}
	}

	function enableScreenDim() {
		if (!Capacitor.isNativePlatform()) return;
		if (appSettings.screenDimDelay > 0) {
			const delayMs = appSettings.screenDimDelay * 1000;
			ScreenDim.enable({ delayMs }).catch(() => {});
		}
	}

	function disableScreenDim() {
		if (!Capacitor.isNativePlatform()) return;
		ScreenDim.disable().catch(() => {});
	}

	// ── React to setting changes (user adjusts dim delay or turns it off) ──
	$effect(() => {
		void appSettings.screenDimDelay; // read the reactive value so $effect re-runs on change
		applyScreenDim();
	});

	// Signal to Playwright tests that SvelteKit has fully hydrated.
	// Tests can wait for body[data-hydrated] before interacting with the app.
	onMount(() => {
		document.body.dataset.hydrated = '1';

		// Initial dimmer setup
		applyScreenDim();

		// ── Lifecycle: disable dimmer when app goes to background, re-enable on return ──
		// Capacitor fires 'pause'/'resume' on Android activity lifecycle changes.
		// Web falls back to visibilitychange for browser tab focus tracking.
		const handlePause = () => disableScreenDim();
		const handleResume = () => enableScreenDim();

		if (Capacitor.isNativePlatform()) {
			document.addEventListener('pause', handlePause);
			document.addEventListener('resume', handleResume);
		} else {
			document.addEventListener('visibilitychange', () => {
				if (document.visibilityState === 'visible') {
					enableScreenDim();
				} else {
					disableScreenDim();
				}
			});
		}
	});
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
	<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1" />
	<title>Media Hub</title>
</svelte:head>

<AuroraBackground />
{@render children()}
