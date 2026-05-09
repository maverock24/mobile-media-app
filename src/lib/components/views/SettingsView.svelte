<script lang="ts">
	import { env } from '$env/dynamic/public';
	import { Capacitor, CapacitorHttp } from '@capacitor/core';
	import { Filesystem, Directory } from '@capacitor/filesystem';
	import { DirectoryReader } from '$lib/native/directory-reader';
	import { onMount } from 'svelte';
	import Button from '$lib/components/ui/Button.svelte';
	import { appSettings, musicSettings, podcastSettings, sleepTimerSettings, weatherSettings } from '$lib/stores/settings.svelte';
	import {
		clearStoredRuntimeError,
		formatRuntimeErrorReport,
		runtimeDiagnostics,
	} from '$lib/stores/runtimeDiagnostics.svelte';
	import {
		sleepTimer,
		SLEEP_TIMER_PRESETS,
		setSleepTimer,
		clearSleepTimer,
		formatSleepTimerRemaining,
	} from '$lib/stores/sleepTimer.svelte';
	import {
		Music2,
		Mic2,
		Cloud,
		CarFront,
		Moon,
		Palette,
		RotateCcw,
		ChevronRight,
		Check,
		Globe,
		Smartphone,
		Download,
		RefreshCw,
		Copy,
		ExternalLink
	} from 'lucide-svelte';
	import { addToast } from '$lib/stores/toastStore.svelte';

	type AndroidReleaseInfo = {
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

	let expandedSection = $state<string | null>(null);
	let androidRelease = $state<AndroidReleaseInfo | null>(null);
	let isCheckingRelease = $state(false);
	let releaseError = $state('');
	let isInstalling = $state(false);
	let installError = $state('');
	let installStep = $state<'idle' | 'downloading' | 'launching'>('idle');
	const installedVersionCode = parseInt(env.PUBLIC_BUILD_VERSION_CODE ?? '0', 10);
	const releaseBaseUrl = (() => {
		const configuredBaseUrl = env.PUBLIC_RELEASE_BASE_URL?.trim().replace(/\/$/, '');
		if (configuredBaseUrl) {
			return configuredBaseUrl;
		}

		if (Capacitor.isNativePlatform()) {
			return 'https://mobile-media-app-maverock24.netlify.app';
		}

		return '';
	})();

	function resolveReleaseUrl(path: string): string {
		if (/^https?:\/\//i.test(path)) {
			return path;
		}

		if (!releaseBaseUrl) {
			return path;
		}

		return `${releaseBaseUrl}${path.startsWith('/') ? path : `/${path}`}`;
	}

	function toggle(section: string) {
		expandedSection = expandedSection === section ? null : section;
	}

	const sleepTimerSummary = $derived(
		sleepTimer.isActive
			? `Stops in ${formatSleepTimerRemaining(sleepTimer.remainingMs)}`
			: `Off · last ${sleepTimerSettings.lastDurationMin}m`
	);
	const lastRuntimeErrorReport = $derived(
		runtimeDiagnostics.lastRuntimeError
			? formatRuntimeErrorReport(runtimeDiagnostics.lastRuntimeError)
			: ''
	);

	function formatRuntimeErrorTimestamp(timestamp: number): string {
		return new Date(timestamp).toLocaleString();
	}

	async function copyLastRuntimeError(): Promise<void> {
		if (!runtimeDiagnostics.lastRuntimeError) return;

		try {
			if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
				await navigator.clipboard.writeText(lastRuntimeErrorReport);
			} else if (typeof document !== 'undefined') {
				const textarea = document.createElement('textarea');
				textarea.value = lastRuntimeErrorReport;
				textarea.setAttribute('readonly', 'true');
				textarea.style.position = 'fixed';
				textarea.style.opacity = '0';
				document.body.appendChild(textarea);
				textarea.select();
				const copied = document.execCommand('copy');
				document.body.removeChild(textarea);
				if (!copied) throw new Error('Copy command failed');
			} else {
				throw new Error('Clipboard unavailable');
			}

			addToast({ message: 'Crash report copied.', type: 'info', autoDismissMs: 2500 });
		} catch {
			addToast({ message: 'Could not copy the crash report.', type: 'error' });
		}
	}

	function clearLastRuntimeError(): void {
		clearStoredRuntimeError();
		addToast({ message: 'Stored crash report cleared.', type: 'info', autoDismissMs: 2500 });
	}

	async function loadAndroidRelease() {
		isCheckingRelease = true;
		releaseError = '';

		try {
			const url = resolveReleaseUrl(`/releases/android/latest.json?ts=${Date.now()}`);
			let release: AndroidReleaseInfo;

			if (Capacitor.isNativePlatform()) {
				// Use CapacitorHttp on Android — plain fetch() from capacitor://localhost
				// is unreliable for cross-origin requests in Capacitor 8's WebView.
				const resp = await CapacitorHttp.get({ url });
				if (resp.status === 404) {
					androidRelease = null;
					return;
				}
				if (resp.status !== 200) {
					throw new Error(`Unable to load release info — server returned ${resp.status}`);
				}
				release = resp.data as AndroidReleaseInfo;
			} else {
				const response = await fetch(url, { cache: 'no-store' });
				if (response.status === 404) {
					androidRelease = null;
					return;
				}
				if (!response.ok) {
					throw new Error(`Unable to load the latest Android build (${response.status})`);
				}
				release = (await response.json()) as AndroidReleaseInfo;
			}

			androidRelease = {
				...release,
				url: resolveReleaseUrl(release.url)
			};
		} catch (error) {
			androidRelease = null;
			const msg = error instanceof Error ? error.message : '';
			releaseError = /failed to fetch|failed to connect|network/i.test(msg)
				? 'Could not reach update server. Check your connection and try again.'
				: (msg || 'Unable to load the latest Android build.');
		} finally {
			isCheckingRelease = false;
		}
	}

	function formatReleaseDate(value: string) {
		const date = new Date(value);

		if (Number.isNaN(date.getTime())) {
			return value;
		}

		return new Intl.DateTimeFormat(undefined, {
			dateStyle: 'medium',
			timeStyle: 'short'
		}).format(date);
	}

	function formatFileSize(sizeBytes: number) {
		if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) {
			return 'Unknown size';
		}

		const units = ['B', 'KB', 'MB', 'GB'];
		let value = sizeBytes;
		let unitIndex = 0;

		while (value >= 1024 && unitIndex < units.length - 1) {
			value /= 1024;
			unitIndex += 1;
		}

		const digits = unitIndex === 0 ? 0 : 1;
		return `${value.toFixed(digits)} ${units[unitIndex]}`;
	}

	async function installUpdate() {
		if (!androidRelease) return;

		// Reject non-HTTPS download URLs
		try {
			const parsed = new URL(androidRelease.url);
			if (parsed.protocol !== 'https:') {
				installError = 'APK download URL must use HTTPS.';
				return;
			}
		} catch {
			installError = 'APK download URL is invalid.';
			return;
		}

		isInstalling = true;
		installError = '';
		installStep = 'downloading';
		try {
			const { path } = await Filesystem.downloadFile({
				url: androidRelease.url,
				path: 'update.apk',
				directory: Directory.Cache
			});
			if (!path) throw new Error('Download failed — no file path returned.');

			// SHA-256 integrity check — skip on Android to avoid loading the
			// entire APK (~100MB+) into WebView memory (causes OOM).
			// Android's package manager verifies the APK signature on install.
			if (androidRelease.sha256 && Capacitor.getPlatform() !== 'android') {
				const { data } = await Filesystem.readFile({ path: 'update.apk', directory: Directory.Cache });
				const binary = atob(data as string);
				const bytes = new Uint8Array(binary.length);
				for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
				const hashBuffer = await crypto.subtle.digest('SHA-256', bytes.buffer);
				const hashHex = Array.from(new Uint8Array(hashBuffer))
					.map(b => b.toString(16).padStart(2, '0')).join('');
				if (hashHex !== androidRelease.sha256.toLowerCase()) {
					await Filesystem.deleteFile({ path: 'update.apk', directory: Directory.Cache }).catch(() => {});
					throw new Error('APK integrity check failed — the file may be corrupt or tampered with.');
				}
			}

			installStep = 'launching';
			await DirectoryReader.installApk({ path });
		} catch (err) {
			installError = err instanceof Error ? err.message : 'Failed to install update.';
		} finally {
			isInstalling = false;
			installStep = 'idle';
		}
	}

	onMount(() => {
		void loadAndroidRelease();
	});

	function resetAll() {
		if (!confirm('Reset all settings to defaults?')) return;
		// app
		appSettings.theme = 'system';
		appSettings.accentColor = 'slate';
		appSettings.fontSize = 'md';
		appSettings.reducedMotion = false;
		appSettings.hapticFeedback = true;
		appSettings.driveMode = false;
		appSettings.mediaControlsPosition = 'bottom';
		// music
		musicSettings.volume = 80;
		musicSettings.isMuted = false;
		musicSettings.isShuffle = false;
		musicSettings.isRepeat = false;
		musicSettings.librarySource = 'device';
		musicSettings.crossfadeDuration = 0;
		musicSettings.equalizerPreset = 'flat';
		musicSettings.showAlbumArt = true;
		musicSettings.autoPlay = false;
		musicSettings.rewindOnPrev = true;
		musicSettings.sortOrder = 'filename';
		// podcasts
		podcastSettings.playbackSpeed = 1.0;
		podcastSettings.skipBackSeconds = 10;
		podcastSettings.skipForwardSeconds = 30;
		podcastSettings.autoPlayNext = true;
		podcastSettings.trimSilence = false;
		podcastSettings.boostVolume = false;
		podcastSettings.defaultTab = 'subscribed';
		podcastSettings.markPlayedThreshold = 90;
		podcastSettings.autoMarkPlayed = true;
		// sleep timer
		sleepTimerSettings.endsAt = 0;
		sleepTimerSettings.lastDurationMin = 30;
		clearSleepTimer({ silent: true });
		// weather
		weatherSettings.units = 'C';
		weatherSettings.windUnit = 'kmh';
		weatherSettings.showHourly = true;
		weatherSettings.show7Day = true;
		weatherSettings.showHumidity = true;
		weatherSettings.showWind = true;
		weatherSettings.showVisibility = true;
		weatherSettings.showFeelsLike = true;
	}
</script>

<div class="flex flex-col h-full bg-background/85 overflow-y-auto">
	<div class="flex-1 divide-y">

		<!-- ── App / Appearance ──────────────────────────────── -->
		<div>
			<button class="tap-feedback w-full flex items-center gap-3 px-4 py-4 text-left hover:bg-accent active:bg-accent/80 transition-colors" onclick={() => toggle('app')}>
				<div class="w-9 h-9 rounded-xl bg-gradient-to-br from-slate-400 to-slate-600 flex items-center justify-center shrink-0">
					<Palette class="w-5 h-5 text-white" />
				</div>
				<div class="flex-1 min-w-0">
					<p class="font-semibold">Appearance</p>
					<p class="text-xs text-muted-foreground capitalize">{appSettings.theme} theme · {appSettings.fontSize} text · controls {appSettings.mediaControlsPosition}{appSettings.driveMode ? ' · drive mode on' : ''}</p>
				</div>
				<ChevronRight class="w-4 h-4 text-muted-foreground transition-transform {expandedSection === 'app' ? 'rotate-90' : ''}" />
			</button>
			{#if expandedSection === 'app'}
				<div class="px-4 pb-4 space-y-4 bg-muted/20">
					<!-- Theme -->
					<div>
						<p class="text-sm font-medium mb-2">Theme</p>
						<div class="flex gap-2">
							{#each ['light', 'dark', 'system'] as t}
								<button
									class="flex-1 py-2 rounded-lg text-sm border transition-colors {appSettings.theme === t ? 'border-primary bg-primary/10 text-primary font-medium' : 'border-border hover:bg-accent'}"
									onclick={() => (appSettings.theme = t as typeof appSettings.theme)}
								>
									{t.charAt(0).toUpperCase() + t.slice(1)}
								</button>
							{/each}
						</div>
					</div>
					<!-- Accent Colour -->
					<div>
						<p class="text-sm font-medium mb-2">Accent Color</p>
						<div class="flex flex-wrap gap-2">
							{#each [
								{ id: 'slate', bg: 'bg-slate-500' },
								{ id: 'blue', bg: 'bg-blue-500' },
								{ id: 'violet', bg: 'bg-violet-500' },
								{ id: 'rose', bg: 'bg-rose-500' },
								{ id: 'orange', bg: 'bg-orange-500' },
								{ id: 'green', bg: 'bg-green-500' }
							] as c}
								<button
									class="w-9 h-9 rounded-full flex items-center justify-center {c.bg} transition-transform {appSettings.accentColor === c.id ? 'scale-110 ring-2 ring-offset-2 ring-foreground' : ''}"
									onclick={() => (appSettings.accentColor = c.id as typeof appSettings.accentColor)}
								>
									{#if appSettings.accentColor === c.id}
										<Check class="w-4 h-4 text-white" />
									{/if}
								</button>
							{/each}
						</div>
					</div>
					<!-- Font Size -->
					<div>
						<p class="text-sm font-medium mb-2">Font Size</p>
						<div class="flex gap-2">
							{#each [{ id: 'sm', label: 'Small' }, { id: 'md', label: 'Medium' }, { id: 'lg', label: 'Large' }] as fs}
								<button
									class="flex-1 py-2 rounded-lg text-sm border transition-colors {appSettings.fontSize === fs.id ? 'border-primary bg-primary/10 text-primary font-medium' : 'border-border hover:bg-accent'}"
									onclick={() => (appSettings.fontSize = fs.id as typeof appSettings.fontSize)}
								>
									{fs.label}
								</button>
							{/each}
						</div>
					</div>
					<!-- Toggles -->
					<div class="space-y-3">
						<label class="flex items-center justify-between">
							<span class="text-sm">Reduced Motion</span>
							<button
								role="switch"
								aria-label="Reduced Motion"
								aria-checked={appSettings.reducedMotion}
								onclick={() => (appSettings.reducedMotion = !appSettings.reducedMotion)}
								class="w-10 h-6 rounded-full transition-colors {appSettings.reducedMotion ? 'bg-primary' : 'bg-secondary'} relative"
							>
								<span class="absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-all {appSettings.reducedMotion ? 'left-4' : 'left-0.5'}"></span>
							</button>
						</label>
						<label class="flex items-center justify-between">
							<span class="text-sm">Haptic Feedback</span>
							<button
								role="switch"
								aria-label="Haptic Feedback"
								aria-checked={appSettings.hapticFeedback}
								onclick={() => (appSettings.hapticFeedback = !appSettings.hapticFeedback)}
								class="w-10 h-6 rounded-full transition-colors {appSettings.hapticFeedback ? 'bg-primary' : 'bg-secondary'} relative"
							>
								<span class="absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-all {appSettings.hapticFeedback ? 'left-4' : 'left-0.5'}"></span>
							</button>
						</label>
						<div class="rounded-xl border border-border/50 bg-background/40 px-3 py-3">
							<p class="text-sm font-medium mb-1">Media Controls Position</p>
							<p class="text-xs text-muted-foreground mb-3">Show the current media controls above the list or keep them below it.</p>
							<div class="flex gap-2">
								{#each [
									{ id: 'top', label: 'Top' },
									{ id: 'bottom', label: 'Bottom' }
								] as option}
									<button
										class="flex-1 py-2 rounded-lg text-sm border transition-colors {appSettings.mediaControlsPosition === option.id ? 'border-primary bg-primary/10 text-primary font-medium' : 'border-border hover:bg-accent'}"
										onclick={() => (appSettings.mediaControlsPosition = option.id as typeof appSettings.mediaControlsPosition)}
									>
										{option.label}
									</button>
								{/each}
							</div>
						</div>
						<label class="flex items-center justify-between gap-3 rounded-xl border border-border/50 bg-background/40 px-3 py-3">
							<div class="min-w-0">
								<div class="flex items-center gap-2">
									<CarFront class="w-4 h-4 text-primary shrink-0" />
									<span class="text-sm font-medium">Drive Mode</span>
								</div>
								<p class="text-xs text-muted-foreground mt-1">Essential tabs only, larger text, higher contrast, and bigger media controls.</p>
							</div>
							<button
								role="switch"
								aria-label="Drive Mode"
								aria-checked={appSettings.driveMode}
								onclick={() => (appSettings.driveMode = !appSettings.driveMode)}
								class="w-10 h-6 rounded-full transition-colors {appSettings.driveMode ? 'bg-primary' : 'bg-secondary'} relative shrink-0"
							>
								<span class="absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-all {appSettings.driveMode ? 'left-4' : 'left-0.5'}"></span>
							</button>
						</label>
					</div>
				</div>
			{/if}
		</div>

		<!-- ── Sleep Timer ───────────────────────────────────── -->
		<div>
			<button class="tap-feedback w-full flex items-center gap-3 px-4 py-4 text-left hover:bg-accent active:bg-accent/80 transition-colors" onclick={() => toggle('sleep-timer')}>
				<div class="w-9 h-9 rounded-xl bg-gradient-to-br from-indigo-500 to-slate-700 flex items-center justify-center shrink-0">
					<Moon class="w-5 h-5 text-white" />
				</div>
				<div class="flex-1 min-w-0">
					<p class="font-semibold">Sleep Timer</p>
					<p class="text-xs text-muted-foreground">{sleepTimerSummary}</p>
				</div>
				<ChevronRight class="w-4 h-4 text-muted-foreground transition-transform {expandedSection === 'sleep-timer' ? 'rotate-90' : ''}" />
			</button>
			{#if expandedSection === 'sleep-timer'}
				<div class="px-4 pb-4 space-y-4 bg-muted/20">
					<p class="text-xs text-muted-foreground leading-relaxed">
						Automatically pause music, podcasts, or radio after a preset duration. The timer keeps its target time across tab switches and app resume.
					</p>

					<div>
						<p class="text-sm font-medium mb-2">Quick Presets</p>
						<div class="flex flex-wrap gap-2">
							{#each SLEEP_TIMER_PRESETS as minutes}
								<button
									class="px-3 py-1.5 rounded-lg text-xs border transition-colors {sleepTimer.isActive && sleepTimer.lastDurationMin === minutes ? 'border-primary bg-primary/10 text-primary font-medium' : 'border-border hover:bg-accent'}"
									onclick={() => setSleepTimer(minutes)}
								>
									{minutes} minutes
								</button>
							{/each}
						</div>
					</div>

					<div class="rounded-xl border border-border/60 bg-background/80 px-3 py-3 flex items-center justify-between gap-3">
						<div>
							<p class="text-sm font-medium">Current timer</p>
							<p class="text-xs text-muted-foreground">{sleepTimerSummary}</p>
						</div>
						<Button variant="outline" class="gap-2 shrink-0" onclick={() => clearSleepTimer()} disabled={!sleepTimer.isActive}>
							Off
						</Button>
					</div>
				</div>
			{/if}
		</div>

		<!-- ── Music ─────────────────────────────────────────── -->
		<div>
			<button class="tap-feedback w-full flex items-center gap-3 px-4 py-4 text-left hover:bg-accent active:bg-accent/80 transition-colors" onclick={() => toggle('music')}>
				<div class="w-9 h-9 rounded-xl bg-gradient-to-br from-purple-500 to-indigo-600 flex items-center justify-center shrink-0">
					<Music2 class="w-5 h-5 text-white" />
				</div>
				<div class="flex-1 min-w-0">
					<p class="font-semibold">Music Player</p>
					<p class="text-xs text-muted-foreground">Vol {musicSettings.volume}% · {musicSettings.sortOrder} sort · {musicSettings.equalizerPreset} EQ</p>
				</div>
				<ChevronRight class="w-4 h-4 text-muted-foreground transition-transform {expandedSection === 'music' ? 'rotate-90' : ''}" />
			</button>
			{#if expandedSection === 'music'}
				<div class="px-4 pb-4 space-y-4 bg-muted/20">
					<!-- Volume -->
					<div>
						<div class="flex items-center justify-between mb-1">
							<p class="text-sm font-medium">Default Volume</p>
							<span class="text-sm text-muted-foreground">{musicSettings.volume}%</span>
						</div>
						<input
							type="range" min="0" max="100"
							value={musicSettings.volume}
							oninput={(e) => (musicSettings.volume = +(e.target as HTMLInputElement).value)}
							class="w-full h-1.5 rounded-full appearance-none cursor-pointer bg-secondary accent-primary"
						/>
					</div>
					<!-- Sort Order -->
					<div>
						<p class="text-sm font-medium mb-2">Sort Order</p>
						<div class="flex gap-2">
							{#each [{ id: 'filename', label: 'File Name' }, { id: 'title', label: 'Title' }, { id: 'artist', label: 'Artist' }] as s}
								<button
									class="flex-1 py-2 rounded-lg text-xs border transition-colors {musicSettings.sortOrder === s.id ? 'border-primary bg-primary/10 text-primary font-medium' : 'border-border hover:bg-accent'}"
									onclick={() => (musicSettings.sortOrder = s.id as typeof musicSettings.sortOrder)}
								>
									{s.label}
								</button>
							{/each}
						</div>
					</div>
					<!-- Equalizer -->
					<div>
						<p class="text-sm font-medium mb-2">Equalizer Preset</p>
						<div class="flex flex-wrap gap-2">
							{#each ['flat', 'bass', 'treble', 'vocal', 'classical'] as preset}
								<button
									class="px-3 py-1.5 rounded-lg text-xs border capitalize transition-colors {musicSettings.equalizerPreset === preset ? 'border-primary bg-primary/10 text-primary font-medium' : 'border-border hover:bg-accent'}"
									onclick={() => (musicSettings.equalizerPreset = preset as typeof musicSettings.equalizerPreset)}
								>
									{preset}
								</button>
							{/each}
						</div>
					</div>
					<!-- Crossfade -->
					<div>
						<div class="flex items-center justify-between mb-1">
							<p class="text-sm font-medium">Crossfade</p>
							<span class="text-sm text-muted-foreground">{musicSettings.crossfadeDuration === 0 ? 'Off' : `${musicSettings.crossfadeDuration}s`}</span>
						</div>
						<input
							type="range" min="0" max="10" step="1"
							value={musicSettings.crossfadeDuration}
							oninput={(e) => (musicSettings.crossfadeDuration = +(e.target as HTMLInputElement).value)}
							class="w-full h-1.5 rounded-full appearance-none cursor-pointer bg-secondary accent-primary"
						/>
					</div>
					<!-- Toggles -->
					<div class="space-y-3">
						{#each [
							{ key: 'autoPlay', label: 'Auto-Play on folder open' },
							{ key: 'rewindOnPrev', label: 'Rewind on Prev (if >3s)' },
							{ key: 'showAlbumArt', label: 'Show album art area' }
						] as item}
							<label class="flex items-center justify-between">
								<span class="text-sm">{item.label}</span>
								<button
									role="switch"
									aria-label={item.label}
									aria-checked={(musicSettings as Record<string, unknown>)[item.key] as boolean}
									onclick={() => {
										(musicSettings as Record<string, unknown>)[item.key] = !(musicSettings as Record<string, unknown>)[item.key];
									}}
									class="w-10 h-6 rounded-full transition-colors {(musicSettings as Record<string, unknown>)[item.key] ? 'bg-primary' : 'bg-secondary'} relative"
								>
									<span class="absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-all {(musicSettings as Record<string, unknown>)[item.key] ? 'left-4' : 'left-0.5'}"></span>
								</button>
							</label>
						{/each}
					</div>
					<div class="pt-1 space-y-2">
						<button
							class="w-full flex items-center justify-center gap-2 px-3 py-2.5 rounded-lg border border-border text-sm font-medium transition-colors hover:bg-accent disabled:opacity-50 disabled:cursor-not-allowed"
							onclick={() => window.dispatchEvent(new CustomEvent('music-library:rescan'))}
							disabled={musicSettings.librarySource !== 'drive' && !musicSettings.nativeTreeUri && !musicSettings.lastFolderName}
						>
							<RefreshCw class="w-4 h-4" />
							Rescan Current Library Index
						</button>
						<p class="text-xs text-muted-foreground">Refresh the saved music index after adding or removing files from a folder.</p>
					</div>
				</div>
			{/if}
		</div>

		<!-- ── Podcasts ───────────────────────────────────────── -->
		<div>
			<button class="tap-feedback w-full flex items-center gap-3 px-4 py-4 text-left hover:bg-accent active:bg-accent/80 transition-colors" onclick={() => toggle('podcasts')}>
				<div class="w-9 h-9 rounded-xl bg-gradient-to-br from-rose-500 to-pink-600 flex items-center justify-center shrink-0">
					<Mic2 class="w-5 h-5 text-white" />
				</div>
				<div class="flex-1 min-w-0">
					<p class="font-semibold">Podcasts</p>
					<p class="text-xs text-muted-foreground">{podcastSettings.playbackSpeed}× speed · skip {podcastSettings.skipForwardSeconds}s forward</p>
				</div>
				<ChevronRight class="w-4 h-4 text-muted-foreground transition-transform {expandedSection === 'podcasts' ? 'rotate-90' : ''}" />
			</button>
			{#if expandedSection === 'podcasts'}
				<div class="px-4 pb-4 space-y-4 bg-muted/20">
					<!-- Playback Speed -->
					<div>
						<p class="text-sm font-medium mb-2">Playback Speed</p>
						<div class="flex flex-wrap gap-2">
							{#each [0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0] as speed}
								<button
									class="px-3 py-1.5 rounded-lg text-xs border transition-colors {podcastSettings.playbackSpeed === speed ? 'border-primary bg-primary/10 text-primary font-medium' : 'border-border hover:bg-accent'}"
									onclick={() => (podcastSettings.playbackSpeed = speed)}
								>
									{speed}×
								</button>
							{/each}
						</div>
					</div>
					<!-- Skip Seconds -->
					<div class="grid grid-cols-2 gap-4">
						<div>
							<div class="flex justify-between mb-1">
								<p class="text-xs font-medium">Skip Back</p>
								<span class="text-xs text-muted-foreground">{podcastSettings.skipBackSeconds}s</span>
							</div>
							<input
								type="range" min="5" max="60" step="5"
								value={podcastSettings.skipBackSeconds}
								oninput={(e) => (podcastSettings.skipBackSeconds = +(e.target as HTMLInputElement).value)}
								class="w-full h-1.5 rounded-full appearance-none cursor-pointer bg-secondary accent-primary"
							/>
						</div>
						<div>
							<div class="flex justify-between mb-1">
								<p class="text-xs font-medium">Skip Forward</p>
								<span class="text-xs text-muted-foreground">{podcastSettings.skipForwardSeconds}s</span>
							</div>
							<input
								type="range" min="5" max="90" step="5"
								value={podcastSettings.skipForwardSeconds}
								oninput={(e) => (podcastSettings.skipForwardSeconds = +(e.target as HTMLInputElement).value)}
								class="w-full h-1.5 rounded-full appearance-none cursor-pointer bg-secondary accent-primary"
							/>
						</div>
					</div>
					<!-- Mark Played Threshold -->
					<div>
						<div class="flex justify-between mb-1">
							<p class="text-sm font-medium">Mark-Played Threshold</p>
							<span class="text-sm text-muted-foreground">{podcastSettings.markPlayedThreshold}%</span>
						</div>
						<input
							type="range" min="50" max="100" step="5"
							value={podcastSettings.markPlayedThreshold}
							oninput={(e) => (podcastSettings.markPlayedThreshold = +(e.target as HTMLInputElement).value)}
							class="w-full h-1.5 rounded-full appearance-none cursor-pointer bg-secondary accent-primary"
						/>
					</div>
					<!-- Toggles -->
					<div class="space-y-3">
						{#each [
							{ key: 'autoPlayNext', label: 'Auto-play next episode' },
							{ key: 'trimSilence', label: 'Trim silence' },
							{ key: 'boostVolume', label: 'Volume boost' },
							{ key: 'autoMarkPlayed', label: 'Auto-mark as played' }
						] as item}
							<label class="flex items-center justify-between">
								<span class="text-sm">{item.label}</span>
								<button
									role="switch"
									aria-label={item.label}
									aria-checked={(podcastSettings as Record<string, unknown>)[item.key] as boolean}
									onclick={() => {
										(podcastSettings as Record<string, unknown>)[item.key] = !(podcastSettings as Record<string, unknown>)[item.key];
									}}
									class="w-10 h-6 rounded-full transition-colors {(podcastSettings as Record<string, unknown>)[item.key] ? 'bg-primary' : 'bg-secondary'} relative"
								>
									<span class="absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-all {(podcastSettings as Record<string, unknown>)[item.key] ? 'left-4' : 'left-0.5'}"></span>
								</button>
							</label>
						{/each}
					</div>
				</div>
			{/if}
		</div>

		<!-- ── Weather ───────────────────────────────────────── -->
		<div>
			<button class="tap-feedback w-full flex items-center gap-3 px-4 py-4 text-left hover:bg-accent active:bg-accent/80 transition-colors" onclick={() => toggle('weather')}>
				<div class="w-9 h-9 rounded-xl bg-gradient-to-br from-sky-400 to-blue-500 flex items-center justify-center shrink-0">
					<Cloud class="w-5 h-5 text-white" />
				</div>
				<div class="flex-1 min-w-0">
					<p class="font-semibold">Weather</p>
					<p class="text-xs text-muted-foreground">°{weatherSettings.units} · {weatherSettings.windUnit} · {weatherSettings.savedCities.length} cities</p>
				</div>
				<ChevronRight class="w-4 h-4 text-muted-foreground transition-transform {expandedSection === 'weather' ? 'rotate-90' : ''}" />
			</button>
			{#if expandedSection === 'weather'}
				<div class="px-4 pb-4 space-y-4 bg-muted/20">
					<!-- Temperature Unit -->
					<div>
						<p class="text-sm font-medium mb-2">Temperature Unit</p>
						<div class="flex gap-2">
							{#each [{ id: 'C', label: '°C Celsius' }, { id: 'F', label: '°F Fahrenheit' }] as u}
								<button
									class="flex-1 py-2 rounded-lg text-sm border transition-colors {weatherSettings.units === u.id ? 'border-primary bg-primary/10 text-primary font-medium' : 'border-border hover:bg-accent'}"
									onclick={() => (weatherSettings.units = u.id as 'C' | 'F')}
								>
									{u.label}
								</button>
							{/each}
						</div>
					</div>
					<!-- Wind Unit -->
					<div>
						<p class="text-sm font-medium mb-2">Wind Speed Unit</p>
						<div class="flex gap-2">
							{#each [{ id: 'kmh', label: 'km/h' }, { id: 'mph', label: 'mph' }, { id: 'ms', label: 'm/s' }] as w}
								<button
									class="flex-1 py-2 rounded-lg text-sm border transition-colors {weatherSettings.windUnit === w.id ? 'border-primary bg-primary/10 text-primary font-medium' : 'border-border hover:bg-accent'}"
									onclick={() => (weatherSettings.windUnit = w.id as typeof weatherSettings.windUnit)}
								>
									{w.label}
								</button>
							{/each}
						</div>
					</div>
					<!-- Visible Cards -->
					<div class="space-y-3">
						<p class="text-sm font-medium">Visible Data Cards</p>
						{#each [
							{ key: 'showHourly', label: 'Hourly forecast' },
							{ key: 'show7Day', label: '7-day forecast' },
							{ key: 'showHumidity', label: 'Humidity' },
							{ key: 'showWind', label: 'Wind speed' },
							{ key: 'showVisibility', label: 'Visibility' },
							{ key: 'showFeelsLike', label: 'Feels like' }
						] as item}
							<label class="flex items-center justify-between">
								<span class="text-sm">{item.label}</span>
								<button
									role="switch"
									aria-label={item.label}
									aria-checked={(weatherSettings as Record<string, unknown>)[item.key] as boolean}
									onclick={() => {
										(weatherSettings as Record<string, unknown>)[item.key] = !(weatherSettings as Record<string, unknown>)[item.key];
									}}
									class="w-10 h-6 rounded-full transition-colors {(weatherSettings as Record<string, unknown>)[item.key] ? 'bg-primary' : 'bg-secondary'} relative"
								>
									<span class="absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-all {(weatherSettings as Record<string, unknown>)[item.key] ? 'left-4' : 'left-0.5'}"></span>
								</button>
							</label>
						{/each}
					</div>
				</div>
			{/if}
		</div>

		<!-- ── App Updates ───────────────────────────────────── -->
		<div>
			<button class="tap-feedback w-full flex items-center gap-3 px-4 py-4 text-left hover:bg-accent active:bg-accent/80 transition-colors" onclick={() => toggle('updates')}>
				<div class="w-9 h-9 rounded-xl bg-gradient-to-br from-amber-400 to-orange-600 flex items-center justify-center shrink-0">
					<Smartphone class="w-5 h-5 text-white" />
				</div>
				<div class="flex-1 min-w-0">
					<p class="font-semibold">App Updates</p>
					<p class="text-xs text-muted-foreground">
						{#if androidRelease && installedVersionCode > 0}
							{#if androidRelease.versionCode > installedVersionCode}
								Update available · {androidRelease.versionName}
							{:else}
								Up to date · {androidRelease.versionName}
							{/if}
						{:else if androidRelease}
							{androidRelease.versionName} · {androidRelease.buildType} APK
						{:else if isCheckingRelease}
							Checking latest Android build
						{:else}
							Install the latest Android APK from this site
						{/if}
					</p>
				</div>
				<ChevronRight class="w-4 h-4 text-muted-foreground transition-transform {expandedSection === 'updates' ? 'rotate-90' : ''}" />
			</button>
			{#if expandedSection === 'updates'}
				<div class="px-4 pb-4 space-y-3 bg-muted/20">
					<p class="text-xs text-muted-foreground leading-relaxed">
						Each production Netlify deploy can publish the newest Android APK here. Open this page on an Android device, download the APK, and confirm the install prompt.
					</p>

					{#if isCheckingRelease}
						<div class="rounded-xl border border-border/60 bg-background/70 px-3 py-3 text-sm text-muted-foreground">
							Checking the latest Android build...
						</div>
					{:else if releaseError}
						<div class="rounded-xl border border-destructive/30 bg-destructive/5 px-3 py-3 text-sm text-destructive">
							{releaseError}
						</div>
					{:else if androidRelease}
						<div class="rounded-xl border border-border/60 bg-background/80 p-4 space-y-3">
							<div class="flex items-start justify-between gap-3">
								<div>
									<p class="font-medium leading-tight">Android build {androidRelease.versionName}</p>
									<p class="text-xs text-muted-foreground mt-1">Published {formatReleaseDate(androidRelease.publishedAt)}</p>
								</div>
								<div class="flex flex-col items-end gap-1">
									<span class="rounded-full bg-primary/10 px-2.5 py-1 text-[11px] font-medium uppercase tracking-wide text-primary">
										{androidRelease.buildType}
									</span>
									{#if installedVersionCode > 0}
										{#if androidRelease.versionCode > installedVersionCode}
											<span class="rounded-full bg-amber-500/15 px-2.5 py-1 text-[11px] font-medium text-amber-600 dark:text-amber-400">
												Update available
											</span>
										{:else}
											<span class="rounded-full bg-green-500/15 px-2.5 py-1 text-[11px] font-medium text-green-600 dark:text-green-400">
												Up to date
											</span>
										{/if}
									{/if}
								</div>
							</div>

							<div class="grid grid-cols-2 gap-3 text-xs text-muted-foreground">
								<div>
									<p class="uppercase tracking-wide text-[10px]">Size</p>
									<p class="mt-1 text-foreground">{formatFileSize(androidRelease.sizeBytes)}</p>
								</div>
								<div>
									<p class="uppercase tracking-wide text-[10px]">Latest Build</p>
									<p class="mt-1 text-foreground">
										#{androidRelease.versionCode}
										{#if installedVersionCode > 0}
											<span class="text-muted-foreground"> · installed #{installedVersionCode}</span>
										{/if}
									</p>
								</div>
							</div>

							<div class="flex flex-col gap-2">
								{#if Capacitor.isNativePlatform()}
									<button
										class="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-60 disabled:pointer-events-none"
										onclick={() => void installUpdate()}
										disabled={isInstalling}
									>
										{#if installStep === 'downloading'}
											<RefreshCw class="w-4 h-4 animate-spin" />
											Downloading…
										{:else if installStep === 'launching'}
											<RefreshCw class="w-4 h-4 animate-spin" />
											Launching installer…
										{:else}
											<Download class="w-4 h-4" />
											Install Update
										{/if}
									</button>
									{#if installError}
										<p class="text-xs text-destructive">{installError}</p>
									{/if}
								{:else}
									<a
										href={androidRelease.url}
										class="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
										download={androidRelease.fileName}
									>
										<Download class="w-4 h-4" />
										Download Latest Android APK
									</a>
								{/if}
								<a
									href={androidRelease.commitUrl}
									target="_blank"
									rel="noreferrer"
									class="inline-flex h-10 items-center justify-center gap-2 rounded-md border border-input bg-background px-4 py-2 text-sm font-medium transition-colors hover:bg-accent hover:text-accent-foreground"
								>
									<ExternalLink class="w-4 h-4" />
									View Source Commit
								</a>
							</div>

							<p class="text-[11px] text-muted-foreground break-all">
								SHA-256 {androidRelease.sha256}
							</p>
						</div>
					{:else}
						<div class="rounded-xl border border-border/60 bg-background/70 px-3 py-3 text-sm text-muted-foreground">
							No Android package has been published to this deployment yet.
						</div>
					{/if}

					<button
						class="inline-flex items-center gap-2 text-sm font-medium text-primary disabled:opacity-50"
						onclick={() => void loadAndroidRelease()}
						disabled={isCheckingRelease}
					>
						<RefreshCw class="w-4 h-4 {isCheckingRelease ? 'animate-spin' : ''}" />
						{isCheckingRelease ? 'Checking…' : 'Refresh build info'}
					</button>
				</div>
			{/if}
		</div>

		<!-- ── Data ──────────────────────────────────────────── -->
		<div>
			<button class="tap-feedback w-full flex items-center gap-3 px-4 py-4 text-left hover:bg-accent active:bg-accent/80 transition-colors" onclick={() => toggle('data')}>
				<div class="w-9 h-9 rounded-xl bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center shrink-0">
					<Globe class="w-5 h-5 text-white" />
				</div>
				<div class="flex-1 min-w-0">
					<p class="font-semibold">Data &amp; Storage</p>
					<p class="text-xs text-muted-foreground">Settings stored in browser localStorage</p>
				</div>
				<ChevronRight class="w-4 h-4 text-muted-foreground transition-transform {expandedSection === 'data' ? 'rotate-90' : ''}" />
			</button>
			{#if expandedSection === 'data'}
				<div class="px-4 pb-4 space-y-3 bg-muted/20">
					<p class="text-xs text-muted-foreground leading-relaxed">
						All settings are automatically saved to your browser's localStorage and restored on next visit. No data is sent to any server.
					</p>
					<div class="rounded-xl border border-border/60 bg-background/70 px-3 py-3 space-y-3">
						<div class="flex items-start justify-between gap-3">
							<div class="min-w-0">
								<p class="text-sm font-medium">Last runtime error</p>
								{#if runtimeDiagnostics.lastRuntimeError}
									<p class="text-xs text-muted-foreground mt-1">
										{formatRuntimeErrorTimestamp(runtimeDiagnostics.lastRuntimeError.recordedAt)}
										· {runtimeDiagnostics.lastRuntimeError.source}
										{#if runtimeDiagnostics.lastRuntimeError.activeTab}
											· {runtimeDiagnostics.lastRuntimeError.activeTab}
										{/if}
									</p>
								{:else}
									<p class="text-xs text-muted-foreground mt-1">No stored runtime errors.</p>
								{/if}
							</div>
							{#if runtimeDiagnostics.lastRuntimeError}
								<div class="flex items-center gap-2 shrink-0">
									<Button variant="outline" class="h-8 px-3 text-xs gap-1.5" onclick={copyLastRuntimeError}>
										<Copy class="w-3.5 h-3.5" />
										Copy report
									</Button>
									<Button variant="ghost" class="h-8 px-3 text-xs" onclick={clearLastRuntimeError}>
										Clear
									</Button>
								</div>
							{/if}
						</div>

						{#if runtimeDiagnostics.lastRuntimeError}
							<div class="rounded-lg border border-border/60 bg-background/85 px-3 py-2 max-h-44 overflow-y-auto">
								<pre class="whitespace-pre-wrap break-words text-[11px] leading-relaxed text-muted-foreground">{lastRuntimeErrorReport}</pre>
							</div>
							<p class="text-[11px] text-muted-foreground leading-relaxed">
								Captures JavaScript runtime errors and unhandled promise rejections so you can copy them after reopening the app. Native Android process crashes still need device logs.
							</p>
						{/if}
					</div>
					<Button
						variant="outline"
						class="w-full gap-2 text-destructive border-destructive/40 hover:bg-destructive/10"
						onclick={resetAll}
					>
						<RotateCcw class="w-4 h-4" />
						Reset All Settings to Defaults
					</Button>
				</div>
			{/if}
		</div>

	</div>

</div>
