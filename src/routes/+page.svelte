<script lang="ts">
	import { onMount } from 'svelte';
	import Mp3PlayerView from '$lib/components/views/Mp3PlayerView.svelte';
	import PodcastView from '$lib/components/views/PodcastView.svelte';
	import RadioView from '$lib/components/views/RadioView.svelte';
	import WeatherView from '$lib/components/views/WeatherView.svelte';
	import SettingsView from '$lib/components/views/SettingsView.svelte';
	import MixerView from '$lib/components/views/MixerView.svelte';
	import MiniPlayer from '$lib/components/ui/MiniPlayer.svelte';
	import ToastContainer from '$lib/components/ui/ToastContainer.svelte';
	import { initSleepTimer } from '$lib/stores/sleepTimer.svelte';
	import { appSettings } from '$lib/stores/settings.svelte';
	import { triggerTabHaptic } from '$lib/native/haptics';
	import {
		recordConsoleError,
		runtimeDiagnostics,
		recordUnhandledRejection,
		recordWindowErrorEvent,
	} from '$lib/stores/runtimeDiagnostics.svelte';
	import { addToast } from '$lib/stores/toastStore.svelte';
	import { Music, Mic2, Radio, Cloud, Settings2 } from 'lucide-svelte';
	import { checkForAndroidUpdate } from '$lib/utils/androidUpdate';

	type Tab = 'music' | 'podcasts' | 'radio' | 'weather' | 'settings' | 'mixer';
	const NAVIGATION_STATE_KEY = 'navigation-state';
	const RUNTIME_ERROR_NOTICE_KEY = 'runtime-error-notice-shown';
	const DEFAULT_TAB: Tab = 'music';
	const DRIVE_MODE_TABS: Tab[] = ['music', 'podcasts', 'radio', 'settings', 'mixer'];

	let activeTab = $state<Tab>(DEFAULT_TAB);

	function setActiveTab(nextTab: Tab) {
		if (activeTab === nextTab) return;
		activeTab = nextTab;
		void triggerTabHaptic();
	}

	function navigateToTab(tab: string) {
		if (!isTab(tab)) return;
		setActiveTab(tab);
	}

	function isTab(value: unknown): value is Tab {
		return value === 'music' || value === 'podcasts' || value === 'radio'
			|| value === 'weather' || value === 'settings' || value === 'mixer';
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
		initSleepTimer();
		void checkForAndroidUpdate();

		if (runtimeDiagnostics.lastRuntimeError && typeof sessionStorage !== 'undefined' && !sessionStorage.getItem(RUNTIME_ERROR_NOTICE_KEY)) {
			addToast({
				message: 'Previous runtime error saved in Settings > Data & Storage.',
				type: 'warning',
				autoDismissMs: 5000,
			});
			sessionStorage.setItem(RUNTIME_ERROR_NOTICE_KEY, '1');
		}

		const onWindowError = (event: ErrorEvent) => {
			recordWindowErrorEvent(event, activeTab);
		};
		const onUnhandledRejection = (event: PromiseRejectionEvent) => {
			recordUnhandledRejection(event.reason, activeTab);
		};
		const originalConsoleError = console.error.bind(console);
		console.error = (...args: unknown[]) => {
			recordConsoleError(args, activeTab);
			originalConsoleError(...args);
		};

		window.addEventListener('error', onWindowError);
		window.addEventListener('unhandledrejection', onUnhandledRejection);

		return () => {
			console.error = originalConsoleError;
			window.removeEventListener('error', onWindowError);
			window.removeEventListener('unhandledrejection', onUnhandledRejection);
		};
	});

	$effect(() => {
		if (typeof localStorage === 'undefined') return;
		localStorage.setItem(NAVIGATION_STATE_KEY, JSON.stringify({ activeTab }));
	});

	$effect(() => {
		if (typeof document === 'undefined') return;
		document.body.classList.toggle('drive-mode', appSettings.driveMode);
		document.documentElement.classList.toggle('drive-mode', appSettings.driveMode);
		document.body.classList.toggle('reduced-motion', appSettings.reducedMotion);
		document.documentElement.classList.toggle('reduced-motion', appSettings.reducedMotion);
		return () => {
			document.body.classList.remove('drive-mode');
			document.documentElement.classList.remove('drive-mode');
			document.body.classList.remove('reduced-motion');
			document.documentElement.classList.remove('reduced-motion');
		};
	});

	const tabs = $derived.by((): { id: Tab; label: string; icon: typeof Music }[] => {
		if (appSettings.driveMode) {
			return [
				{ id: 'music', label: 'Music', icon: Music },
				{ id: 'podcasts', label: 'Podcasts', icon: Mic2 },
				{ id: 'radio', label: 'Radio', icon: Radio },
				{ id: 'settings', label: 'Settings', icon: Settings2 }
			];
		}

		return [
			{ id: 'music',    label: 'Music',    icon: Music },
			{ id: 'podcasts', label: 'Podcasts', icon: Mic2 },
			{ id: 'radio',    label: 'Radio',    icon: Radio },
			{ id: 'weather',  label: 'Weather',  icon: Cloud },
			{ id: 'settings', label: 'Settings', icon: Settings2 }
		];
	});

	$effect(() => {
		if (!appSettings.driveMode) return;
		if (!DRIVE_MODE_TABS.includes(activeTab)) {
			activeTab = 'music';
		}
	});

	// ── Swipe left/right to navigate between tabs ────────────────
	let swipeStartX = 0;
	let swipeStartY = 0;

	function onTouchStart(e: TouchEvent) {
		swipeStartX = e.touches[0].clientX;
		swipeStartY = e.touches[0].clientY;
	}

	function onTouchEnd(e: TouchEvent) {
		const dx = e.changedTouches[0].clientX - swipeStartX;
		const dy = e.changedTouches[0].clientY - swipeStartY;
		// Require predominantly horizontal swipe (|dx| > |dy|) and min 60px travel
		if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
		const ids = tabs.map(t => t.id);
		const idx = ids.indexOf(activeTab);
		if (dx < 0 && idx > 0)              setActiveTab(ids[idx - 1]); // swipe left  → tab on the left
		if (dx > 0 && idx < ids.length - 1) setActiveTab(ids[idx + 1]); // swipe right → tab on the right
	}
</script>

<div class="drive-mode-shell flex flex-col h-dvh w-full min-w-0 overflow-hidden relative sm:mx-auto sm:h-[calc(100dvh-2rem)] sm:max-w-3xl sm:rounded-3xl sm:border sm:border-border sm:bg-background/90 sm:shadow-2xl sm:backdrop-blur-xl lg:max-w-5xl" style="z-index:1;">
	{#if appSettings.mediaControlsPosition === 'top'}
		<MiniPlayer activeTab={activeTab} position="top" onNavigateTo={navigateToTab} />
	{/if}

	<!-- Content -->
	<main class="flex-1 overflow-hidden relative"
		ontouchstart={onTouchStart}
		ontouchend={onTouchEnd}
	>
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
		<div class="absolute inset-0 overflow-hidden" class:hidden={activeTab !== 'mixer'}>
			<MixerView active={activeTab === 'mixer'} onBack={() => setActiveTab('music')} />
		</div>
		{#if activeTab === 'weather'}
			<div class="absolute inset-0 overflow-y-auto">
				<WeatherView />
			</div>
		{:else if activeTab === 'settings'}
			<div class="absolute inset-0 overflow-y-auto">
				<SettingsView />
			</div>
		{/if}
	</main>

	<!-- Mini-player: shown whenever music, podcast, or radio playback is active -->
	{#if appSettings.mediaControlsPosition !== 'top'}
		<MiniPlayer activeTab={activeTab} position="bottom" onNavigateTo={navigateToTab} />
	{/if}

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
					class="nav-tab-button flex-1 flex flex-col items-center justify-center py-2 gap-1 transition-colors {activeTab === tab.id ? 'nav-tab-button-active text-primary' : 'text-muted-foreground hover:text-foreground'}"
					onclick={() => setActiveTab(tab.id)}
				>
					<div class="relative">
						<Icon class="w-6 h-6" />
						{#if activeTab === tab.id}
							<div class="absolute -bottom-0.5 left-1/2 -translate-x-1/2 w-1 h-1 rounded-full bg-primary"></div>
						{/if}
					</div>
					<span class="text-xs font-semibold tracking-[0.02em] leading-none">{tab.label}</span>
				</button>
			{/each}
		</div>
	</div>
</div>
