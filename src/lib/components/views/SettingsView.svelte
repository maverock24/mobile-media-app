<script lang="ts">
	import Button from '$lib/components/ui/Button.svelte';
	import { appSettings, musicSettings, podcastSettings, weatherSettings } from '$lib/stores/settings.svelte';
	import {
		Music2,
		Mic2,
		Cloud,
		Palette,
		RotateCcw,
		ChevronRight,
		Check,
		Volume2,
		Gauge,
		Globe
	} from 'lucide-svelte';

	let expandedSection = $state<string | null>(null);

	function toggle(section: string) {
		expandedSection = expandedSection === section ? null : section;
	}

	function resetAll() {
		if (!confirm('Reset all settings to defaults?')) return;
		// app
		appSettings.theme = 'system';
		appSettings.accentColor = 'slate';
		appSettings.fontSize = 'md';
		appSettings.reducedMotion = false;
		appSettings.hapticFeedback = true;
		// music
		musicSettings.volume = 80;
		musicSettings.isMuted = false;
		musicSettings.isShuffle = false;
		musicSettings.isRepeat = false;
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

<div class="flex flex-col h-full bg-background overflow-y-auto">
	<!-- Header -->
	<div class="px-4 pt-5 pb-4 border-b">
		<h1 class="text-xl font-bold">Settings</h1>
		<p class="text-sm text-muted-foreground mt-0.5">Customize your experience</p>
	</div>

	<div class="flex-1 divide-y">

		<!-- ── App / Appearance ──────────────────────────────── -->
		<div>
			<button class="w-full flex items-center gap-3 px-4 py-4 text-left hover:bg-accent transition-colors" onclick={() => toggle('app')}>
				<div class="w-9 h-9 rounded-xl bg-gradient-to-br from-slate-400 to-slate-600 flex items-center justify-center shrink-0">
					<Palette class="w-5 h-5 text-white" />
				</div>
				<div class="flex-1 min-w-0">
					<p class="font-semibold">Appearance</p>
					<p class="text-xs text-muted-foreground capitalize">{appSettings.theme} theme · {appSettings.fontSize} text</p>
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
					</div>
				</div>
			{/if}
		</div>

		<!-- ── Music ─────────────────────────────────────────── -->
		<div>
			<button class="w-full flex items-center gap-3 px-4 py-4 text-left hover:bg-accent transition-colors" onclick={() => toggle('music')}>
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
				</div>
			{/if}
		</div>

		<!-- ── Podcasts ───────────────────────────────────────── -->
		<div>
			<button class="w-full flex items-center gap-3 px-4 py-4 text-left hover:bg-accent transition-colors" onclick={() => toggle('podcasts')}>
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
			<button class="w-full flex items-center gap-3 px-4 py-4 text-left hover:bg-accent transition-colors" onclick={() => toggle('weather')}>
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

		<!-- ── Data ──────────────────────────────────────────── -->
		<div>
			<button class="w-full flex items-center gap-3 px-4 py-4 text-left hover:bg-accent transition-colors" onclick={() => toggle('data')}>
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

	<!-- Version footer -->
	<div class="p-4 text-center text-xs text-muted-foreground/50 border-t">
		Mobile Media App · Settings auto-saved
	</div>
</div>
