<script lang="ts">
	import { onMount } from 'svelte';
	import Mp3PlayerView from '$lib/components/views/Mp3PlayerView.svelte';
	import PodcastView from '$lib/components/views/PodcastView.svelte';
	import RadioView from '$lib/components/views/RadioView.svelte';
	import WeatherView from '$lib/components/views/WeatherView.svelte';
	import SettingsView from '$lib/components/views/SettingsView.svelte';
	import LoginView from '$lib/components/views/LoginView.svelte';
	import MiniPlayer from '$lib/components/ui/MiniPlayer.svelte';
	import ToastContainer from '$lib/components/ui/ToastContainer.svelte';
	import { addToast } from '$lib/stores/toastStore.svelte';
	import { googleDriveSession } from '$lib/stores/googleDriveSession.svelte';
	import { Music, Mic2, Radio, Cloud, Settings2, User } from 'lucide-svelte';

	type Tab = 'music' | 'podcasts' | 'radio' | 'login' | 'weather' | 'settings';
	const NAVIGATION_STATE_KEY = 'navigation-state';
	const DEFAULT_TAB: Tab = 'music';

	let activeTab = $state<Tab>(DEFAULT_TAB);

	function isTab(value: unknown): value is Tab {
		return value === 'music' || value === 'podcasts' || value === 'radio'
			|| value === 'login' || value === 'weather' || value === 'settings';
	}

	function readSavedTab(): Tab {
		if (typeof localStorage === 'undefined') return DEFAULT_TAB;
		try {
			const parsed = JSON.parse(localStorage.getItem(NAVIGATION_STATE_KEY) ?? '{}') as { activeTab?: unknown };
			return isTab(parsed.activeTab) ? parsed.activeTab : DEFAULT_TAB;
		} catch {
			return DEFAULT_TAB;
		}
	}

	onMount(() => {
		activeTab = readSavedTab();
	});

	$effect(() => {
		if (typeof localStorage === 'undefined') return;
		localStorage.setItem(NAVIGATION_STATE_KEY, JSON.stringify({ activeTab }));
	});

	const tabs = $derived.by((): { id: Tab; label: string; icon: typeof Music }[] => {
		const isDriveConnected = Boolean(googleDriveSession.user)
			|| googleDriveSession.hasValidToken();

		return [
			{ id: 'music',    label: 'Music',    icon: Music },
			{ id: 'podcasts', label: 'Podcasts', icon: Mic2 },
			{ id: 'radio',    label: 'Radio',    icon: Radio },
			{ id: 'login',    label: isDriveConnected ? 'Drive' : 'Login', icon: User },
			{ id: 'weather',  label: 'Weather',  icon: Cloud },
			{ id: 'settings', label: 'Settings', icon: Settings2 }
		];
	});
</script>

<div class="flex flex-col h-dvh max-w-md mx-auto overflow-hidden relative" style="z-index:1;">
	<!-- Content -->
	<main class="flex-1 overflow-hidden relative">
		<!--
			Music and Podcast are ALWAYS mounted (CSS hidden, not {#if}).
			This keeps the <audio> element and all component state alive across
			tab switches so playback position, tracks, and episode progress are
			preserved. JS timers and Web Audio context also survive.
		-->
		<div class="absolute inset-0 overflow-hidden" class:hidden={activeTab !== 'music'}>
			<Mp3PlayerView />
		</div>
		<div class="absolute inset-0 overflow-hidden" class:hidden={activeTab !== 'podcasts'}>
			<PodcastView />
		</div>
		<div class="absolute inset-0 overflow-hidden" class:hidden={activeTab !== 'radio'}>
			<RadioView />
		</div>
		{#if activeTab === 'login'}
			<div class="absolute inset-0 overflow-y-auto">
				<LoginView />
			</div>
		{:else if activeTab === 'weather'}
			<div class="absolute inset-0 overflow-y-auto">
				<WeatherView />
			</div>
		{:else if activeTab === 'settings'}
			<div class="absolute inset-0 overflow-y-auto">
				<SettingsView />
			</div>
		{/if}
	</main>

	<!-- Mini-player: shown when audio is playing but user is on a different tab -->
	<MiniPlayer {activeTab} onNavigateTo={(tab) => (activeTab = tab as typeof activeTab)} />

	<!-- Toast notifications -->
	<ToastContainer />

	<!-- Bottom Tab Bar -->
	<div class="border-t bg-background/95 backdrop-blur-sm safe-area-inset-bottom" role="tablist">
		<div class="flex">
			{#each tabs as tab}
				{@const Icon = tab.icon}
				<button
					role="tab"
					aria-selected="{activeTab === tab.id}"
					aria-label="{tab.label}"
					class="flex-1 flex flex-col items-center justify-center py-3 gap-1 transition-colors {activeTab === tab.id ? 'text-primary' : 'text-muted-foreground hover:text-foreground'}"
					onclick={() => (activeTab = tab.id)}
				>
					<div class="relative">
						<Icon class="w-7 h-7" />
						{#if activeTab === tab.id}
							<div class="absolute -bottom-1 left-1/2 -translate-x-1/2 w-1 h-1 rounded-full bg-primary"></div>
						{/if}
					</div>
					<span class="text-[10px] font-medium leading-none">{tab.label}</span>
				</button>
			{/each}
		</div>
	</div>
</div>
