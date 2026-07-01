<script lang="ts">
	import '../app.css';
	import favicon from '$lib/assets/favicon.svg';
	import AuroraBackground from '$lib/components/AuroraBackground.svelte';
	import { Capacitor } from '@capacitor/core';
	import { ScreenDim } from '$lib/native/screen-dim';
	import { appSettings } from '$lib/stores/settings.svelte';
	import { onMount } from 'svelte';
	let { children } = $props();

	// Signal to Playwright tests that SvelteKit has fully hydrated.
	// Tests can wait for body[data-hydrated] before interacting with the app.
	onMount(() => {
		document.body.dataset.hydrated = '1';

		// Start screen dimmer on Android if configured
		if (Capacitor.isNativePlatform() && appSettings.screenDimDelay > 0) {
			const delayMs = appSettings.screenDimDelay * 1000;
			ScreenDim.enable({ delayMs }).catch(() => {});
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
