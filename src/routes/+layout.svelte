<script lang="ts">
	import '../app.css';
	import favicon from '$lib/assets/favicon.svg';
	import AuroraBackground from '$lib/components/AuroraBackground.svelte';
	let { children } = $props();
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
	<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1" />
	<title>Media Hub</title>
</svelte:head>

<AuroraBackground />
{@render children()}
