<script lang="ts">
	import '../app.css';
	import favicon from '$lib/assets/favicon.svg';
	import AuroraBackground from '$lib/components/AuroraBackground.svelte';
	import { onMount } from 'svelte';
	let { children } = $props();

	// Signal to Playwright tests that SvelteKit has fully hydrated.
	// Tests can wait for body[data-hydrated] before interacting with the app.
	onMount(() => {
		document.body.dataset.hydrated = '1';
	});
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
	<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1" />
	<title>Media Hub</title>
</svelte:head>

<AuroraBackground />
{@render children()}
