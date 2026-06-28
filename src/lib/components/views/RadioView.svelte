<script lang="ts">
	import { env } from '$env/dynamic/public';
	import { Capacitor } from '@capacitor/core';
	import Button from '$lib/components/ui/Button.svelte';
	import { triggerPlaybackHaptic, triggerToggleHaptic } from '$lib/native/haptics';
	import { appSettings, radioData, type RadioStation } from '$lib/stores/settings.svelte';
	import { mediaEngine, claimAudio, registerAudioSource } from '$lib/stores/mediaEngine.svelte';
	import { addToast } from '$lib/stores/toastStore.svelte';
	import { getListTileToneClasses } from '$lib/utils/listTileTone';
	import { Search, Radio, Star, Play, Pause, Loader, X, Wifi } from 'lucide-svelte';

	// ── Playback state ───────────────────────────────────────────
	let currentStation = $state<RadioStation | null>(null);
	let isPlaying      = $state(false);
	let isBuffering    = $state(false);

	// ── Search state ─────────────────────────────────────────────
	let searchQuery   = $state('');
	let searchResults = $state<RadioStation[]>([]);
	let searching     = $state(false);
	let searchError   = $state('');
	const listTileToneClasses = $derived(getListTileToneClasses(appSettings.listTileTone));
	const radioApiBaseUrl = (() => {
		const configuredBaseUrl = env.PUBLIC_RELEASE_BASE_URL?.trim().replace(/\/$/, '');
		if (configuredBaseUrl) return configuredBaseUrl;
		if (Capacitor.isNativePlatform()) {
			return 'https://mobile-media-app-maverock24.netlify.app';
		}
		return '';
	})();

	// ── Register stop-callback with media engine ─────────────────
	$effect(() => {
		registerAudioSource('radio', () => {
			mediaEngine.stopStream();
			isPlaying = false;
			isBuffering = false;
		});
	});

	// ── Wire stream callbacks to local state ─────────────────────
	$effect(() => {
		mediaEngine.setStreamCallbacks(
			(err) => {
				isBuffering = false;
				isPlaying = false;
				if (err && err.code !== MediaError.MEDIA_ERR_ABORTED) {
					// Stream error — silently handled (auto-retry in media engine)
				}
			},
			() => { isBuffering = true; },
			() => { isBuffering = false; isPlaying = true; }
		);
	});

	// ── Sync isPlaying from mediaEngine when radio is the active source ──
	$effect(() => {
		if (currentStation && mediaEngine.source === 'radio') {
			isPlaying = mediaEngine.isPlaying;
		}
	});

	// ── Stop on unmount ──────────────────────────────────────────
	$effect(() => { return () => { mediaEngine.clear(); }; });

	// ── Playback controls ────────────────────────────────────────
	function playStation(station: RadioStation) {
		void triggerPlaybackHaptic(true);
		currentStation = station;
		isBuffering = true;
		mediaEngine.playStream(station.url_resolved, {
			id:         station.stationuuid,
			source:     'radio',
			title:      station.name,
			subtitle:   [station.country, station.codec, station.bitrate ? `${station.bitrate}kbps` : '']
				.filter(Boolean).join(' · '),
			audioUrl:   station.url_resolved,
			artworkUrl: station.favicon || undefined,
		});
	}

	function stopPlayback() {
		mediaEngine.clear();
		currentStation = null;
	}

	function togglePlay() {
		if (mediaEngine.isPlaying) {
			pausePlayback();
		} else {
			resumePlayback();
		}
	}

	function pausePlayback() {
		if (!currentStation || !mediaEngine.isPlaying) return;
		void triggerPlaybackHaptic(false);
		mediaEngine.pauseStream();
	}

	function resumePlayback() {
		if (!currentStation || mediaEngine.isPlaying) return;
		void triggerPlaybackHaptic(true);
		claimAudio('radio');
		isBuffering = true;
		mediaEngine.resumeStream();
	}

	// ── Search (radio-browser.info via hosted proxy on Netlify/native) ─────
	function resolveRadioApiUrl(path: string): string {
		if (/^https?:\/\//i.test(path)) {
			return path;
		}

		if (!radioApiBaseUrl) {
			return path;
		}

		return `${radioApiBaseUrl}${path.startsWith('/') ? path : `/${path}`}`;
	}

	async function readRadioJson<T>(requestUrl: string): Promise<T> {
		const response = await fetch(requestUrl);
		if (!response.ok) {
			let message = `Radio search failed: HTTP ${response.status}`;
			try {
				const payload = await response.json() as Record<string, unknown>;
				if (typeof payload.error === 'string') {
					message = payload.error;
				} else if (typeof payload.message === 'string') {
					message = payload.message;
				}
			} catch {
				// Fall back to the status-derived message.
			}
			throw new Error(message);
		}

		return await response.json() as T;
	}

	function describeRadioRequestError(error: unknown, fallback: string): string {
		if (error instanceof Error) {
			if (/failed to fetch|fetch failed/i.test(error.message)) {
				return fallback;
			}
			return error.message;
		}
		return fallback;
	}

	async function search() {
		const q = searchQuery.trim();
		if (!q) return;
		searching   = true;
		searchError = '';
		searchResults = [];
		try {
			const requestUrl = resolveRadioApiUrl(`/api/radio/search?q=${encodeURIComponent(q)}`);
			const data = await readRadioJson<RadioStation[]>(requestUrl);
			// Filter to HTTPS-only streams — HTTP streams are blocked as mixed content
			// when the app is served over HTTPS
			const httpsOnly = data.filter(s => s.url_resolved?.startsWith('https://'));
			searchResults = httpsOnly;
			if (!data.length) {
				searchError = 'No stations found. Try different keywords.';
			} else if (!httpsOnly.length) {
				searchError = 'No secure (HTTPS) streams found for this query. Try a different search term.';
			}
		} catch (error) {
			searchError = describeRadioRequestError(error, 'Radio search is unavailable right now. Try again.');
		} finally {
			searching = false;
		}
	}

	// ── Favorites ────────────────────────────────────────────────
	function isFavorite(station: RadioStation) {
		return radioData.favorites.some(f => f.stationuuid === station.stationuuid);
	}

	function toggleFavorite(station: RadioStation) {
		void triggerToggleHaptic(!isFavorite(station));
		if (isFavorite(station)) {
			radioData.favorites = radioData.favorites.filter(f => f.stationuuid !== station.stationuuid);
		} else {
			radioData.favorites = [...radioData.favorites, station];
		}
	}

	// ── Display helpers ──────────────────────────────────────────
	function stationMeta(station: RadioStation): string {
		return [station.country, station.codec, station.bitrate ? `${station.bitrate}kbps` : '', station.tags?.split(',')[0]]
			.filter(Boolean).join(' · ');
	}

	let activeTab = $state<'favorites' | 'search'>('favorites');

	// ── Featured / well-known stations (HTTPS streams) ──────────
	const FEATURED_STATIONS: RadioStation[] = [
		{ stationuuid: 'featured-bbc-radio4',         name: 'BBC Radio 4',         url_resolved: 'https://stream.live.vc.bbcmedia.co.uk/bbc_radio_fourfm',          favicon: '', country: 'UK',  tags: 'news,speech,drama,bbc',       codec: 'MP3', bitrate: 128, votes: 0 },
		{ stationuuid: 'featured-bbc-radio4-extra',   name: 'BBC Radio 4 Extra',   url_resolved: 'https://stream.live.vc.bbcmedia.co.uk/bbc_radio_four_extra',      favicon: '', country: 'UK',  tags: 'comedy,drama,bbc',             codec: 'MP3', bitrate: 128, votes: 0 },
		{ stationuuid: 'featured-bbc-world-service',  name: 'BBC World Service',   url_resolved: 'https://stream.live.vc.bbcmedia.co.uk/bbc_world_service',         favicon: '', country: 'UK',  tags: 'news,world,bbc',               codec: 'MP3', bitrate: 128, votes: 0 },
		{ stationuuid: 'featured-bbc-radio1',         name: 'BBC Radio 1',         url_resolved: 'https://stream.live.vc.bbcmedia.co.uk/bbc_radio_one',             favicon: '', country: 'UK',  tags: 'pop,dance,bbc',                codec: 'MP3', bitrate: 128, votes: 0 },
		{ stationuuid: 'featured-bbc-radio2',         name: 'BBC Radio 2',         url_resolved: 'https://stream.live.vc.bbcmedia.co.uk/bbc_radio_two',             favicon: '', country: 'UK',  tags: 'pop,rock,bbc',                 codec: 'MP3', bitrate: 128, votes: 0 },
		{ stationuuid: 'featured-bbc-radio6',         name: 'BBC Radio 6 Music',   url_resolved: 'https://stream.live.vc.bbcmedia.co.uk/bbc_6music',                favicon: '', country: 'UK',  tags: 'indie,alternative,bbc',        codec: 'MP3', bitrate: 128, votes: 0 },
		{ stationuuid: 'featured-bbc-radio3',         name: 'BBC Radio 3',         url_resolved: 'https://stream.live.vc.bbcmedia.co.uk/bbc_radio_three',           favicon: '', country: 'UK',  tags: 'classical,jazz,bbc',           codec: 'MP3', bitrate: 128, votes: 0 },
		{ stationuuid: 'featured-bbc-radio5',         name: 'BBC Radio 5 Live',    url_resolved: 'https://stream.live.vc.bbcmedia.co.uk/bbc_radio_five_live',       favicon: '', country: 'UK',  tags: 'sport,news,bbc',               codec: 'MP3', bitrate: 128, votes: 0 },
	];
</script>

<div class="flex flex-col h-full bg-background/85">

	<!-- ── Tab bar ──────────────────────────────────────────────── -->
	<div class="shrink-0 flex border-b">
		<button
			class="flex-1 flex items-center justify-center gap-2 py-3 text-sm font-medium border-b-2 transition-colors
				{activeTab === 'favorites' ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground'}"
			onclick={() => (activeTab = 'favorites')}
		>
			<Star class="w-4 h-4" />
			Favorites
			{#if radioData.favorites.length > 0}
				<span class="text-xs bg-primary/15 text-primary rounded-full px-1.5">{radioData.favorites.length}</span>
			{/if}
		</button>
		<button
			class="flex-1 flex items-center justify-center gap-2 py-3 text-sm font-medium border-b-2 transition-colors
				{activeTab === 'search' ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground'}"
			onclick={() => (activeTab = 'search')}
		>
			<Search class="w-4 h-4" />
			Search
		</button>
	</div>

	<!-- ── Favorites tab ────────────────────────────────────────── -->
	{#if activeTab === 'favorites'}
		<div class="flex-1 overflow-y-auto">
			{#if radioData.favorites.length === 0}
				<div class="flex flex-col items-center justify-center h-48 gap-3 text-muted-foreground px-6 text-center">
					<Star class="w-10 h-10 opacity-30" />
					<p class="text-sm">No favorite stations yet.</p>
					<p class="text-xs">Search for stations and tap the star to save them here.</p>
				</div>
			{:else}
				<ul class="divide-y">
					{#each radioData.favorites as station (station.stationuuid)}
						<li class="list-row-surface flex items-center gap-3 px-4 py-3 transition-colors {currentStation?.stationuuid === station.stationuuid ? 'bg-primary/10 ring-1 ring-inset ring-primary/20' : listTileToneClasses.usesTint ? listTileToneClasses.rowClass : ''}">
							{#if station.favicon}
								<img src={station.favicon} alt="" loading="lazy" decoding="async" width="40" height="40" class="w-10 h-10 rounded-lg object-cover shrink-0" />
							{:else}
								<div class="w-10 h-10 rounded-lg bg-muted flex items-center justify-center shrink-0">
									<Radio class="w-5 h-5 text-muted-foreground" />
								</div>
							{/if}
							<button
								class="tap-feedback flex-1 min-w-0 -my-2 -ml-2 rounded-xl px-2 py-2 text-left {listTileToneClasses.usesTint ? listTileToneClasses.actionClass : 'active:bg-accent/80'}"
								onclick={() => playStation(station)}
							>
								<p class="text-[0.95rem] font-semibold leading-tight truncate">{station.name}</p>
								<p class="text-xs text-muted-foreground truncate">{stationMeta(station)}</p>
							</button>
							{#if currentStation?.stationuuid === station.stationuuid && isBuffering}
								<Loader class="w-5 h-5 animate-spin text-primary shrink-0" />
							{:else if currentStation?.stationuuid === station.stationuuid && isPlaying}
								<div class="flex gap-0.5 items-end h-5 shrink-0">
									{#each [3, 5, 4] as h}
										<div class="w-1 bg-primary rounded-full animate-pulse" style="height:{h * 4}px"></div>
									{/each}
								</div>
							{/if}
							<button
								onclick={() => toggleFavorite(station)}
								class="w-9 h-9 flex items-center justify-center rounded-full hover:bg-accent text-yellow-500 transition-colors shrink-0"
								aria-label="Remove from favorites"
							>
								<Star class="w-5 h-5 fill-yellow-500" />
							</button>
						</li>
					{/each}
				</ul>
			{/if}
		</div>

	<!-- ── Search tab ───────────────────────────────────────────── -->
	{:else}
		<div class="flex flex-col flex-1 min-h-0">
			<!-- Search bar -->
			<div class="shrink-0 px-4 py-3 border-b">
				<form
					class="flex gap-2"
					onsubmit={(e) => { e.preventDefault(); search(); }}
				>
					<div class="relative flex-1">
						<Search class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
						<input
							type="search"
							placeholder="Search radio stations…"
							bind:value={searchQuery}
							class="w-full pl-9 pr-3 py-2 text-sm rounded-lg border bg-background focus:outline-none focus:ring-2 focus:ring-primary/50"
						/>
					</div>
					<Button type="submit" disabled={searching || !searchQuery.trim()} size="sm">
						{#if searching}
							<Loader class="w-4 h-4 animate-spin" />
						{:else}
							Search
						{/if}
					</Button>
				</form>
			</div>

			<!-- Results -->
			<div class="flex-1 overflow-y-auto">
				{#if searching}
					<div class="flex items-center justify-center h-32 gap-2 text-muted-foreground">
						<Loader class="w-5 h-5 animate-spin" />
						<span class="text-sm">Searching…</span>
					</div>
				{:else if searchError}
					<div class="flex flex-col items-center justify-center h-32 gap-2 text-muted-foreground px-6 text-center">
						<Wifi class="w-8 h-8 opacity-30" />
						<p class="text-sm">{searchError}</p>
					</div>
				{:else if searchResults.length === 0}
					<div class="pb-2">
						<p class="px-4 pt-3 pb-1 text-xs font-medium text-muted-foreground uppercase tracking-wide">Featured Stations</p>
						<ul class="divide-y">
							{#each FEATURED_STATIONS as station (station.stationuuid)}
								<li class="list-row-surface flex items-center gap-3 px-4 py-3 transition-colors {currentStation?.stationuuid === station.stationuuid ? 'bg-primary/10 ring-1 ring-inset ring-primary/20' : listTileToneClasses.usesTint ? listTileToneClasses.rowClass : ''}">
									<div class="w-10 h-10 rounded-lg bg-muted flex items-center justify-center shrink-0">
										<Radio class="w-5 h-5 text-muted-foreground" />
									</div>
									<button
										class="tap-feedback flex-1 min-w-0 -my-2 -ml-2 rounded-xl px-2 py-2 text-left {listTileToneClasses.usesTint ? listTileToneClasses.actionClass : 'active:bg-accent/80'}"
										onclick={() => playStation(station)}
									>
										<p class="text-[0.95rem] font-semibold leading-tight truncate">{station.name}</p>
										<p class="text-xs text-muted-foreground truncate">{station.country} · {station.tags.split(',')[0]}</p>
									</button>
									{#if currentStation?.stationuuid === station.stationuuid && isBuffering}
										<Loader class="w-5 h-5 animate-spin text-primary shrink-0" />
									{:else if currentStation?.stationuuid === station.stationuuid && isPlaying}
										<div class="flex gap-0.5 items-end h-5 shrink-0">
											{#each [3, 5, 4] as h}
												<div class="w-1 bg-primary rounded-full animate-pulse" style="height:{h * 4}px"></div>
											{/each}
										</div>
									{/if}
									<button
										onclick={() => toggleFavorite(station)}
										class="w-9 h-9 flex items-center justify-center rounded-full hover:bg-accent transition-colors shrink-0
											{isFavorite(station) ? 'text-yellow-500' : 'text-muted-foreground hover:text-yellow-500'}"
										aria-label={isFavorite(station) ? 'Remove from favorites' : 'Add to favorites'}
									>
										<Star class="w-5 h-5 {isFavorite(station) ? 'fill-yellow-500' : ''}" />
									</button>
								</li>
							{/each}
						</ul>
						<p class="px-4 pt-3 text-xs text-muted-foreground text-center">Or search above for any station by name.</p>
					</div>
				{:else}
					<ul class="divide-y">
						{#each searchResults as station (station.stationuuid)}
							<li class="list-row-surface flex items-center gap-3 px-4 py-3 transition-colors {currentStation?.stationuuid === station.stationuuid ? 'bg-primary/10 ring-1 ring-inset ring-primary/20' : listTileToneClasses.usesTint ? listTileToneClasses.rowClass : ''}">
								{#if station.favicon}
									<img src={station.favicon} alt="" loading="lazy" decoding="async" width="40" height="40" class="w-10 h-10 rounded-lg object-cover shrink-0" onerror={(e) => ((e.target as HTMLImageElement).style.display = 'none')} />
								{:else}
									<div class="w-10 h-10 rounded-lg bg-muted flex items-center justify-center shrink-0">
										<Radio class="w-5 h-5 text-muted-foreground" />
									</div>
								{/if}
								<button
									class="tap-feedback flex-1 min-w-0 -my-2 -ml-2 rounded-xl px-2 py-2 text-left {listTileToneClasses.usesTint ? listTileToneClasses.actionClass : 'active:bg-accent/80'}"
									onclick={() => playStation(station)}
								>
									<p class="text-[0.95rem] font-semibold leading-tight truncate">{station.name}</p>
									<p class="text-xs text-muted-foreground truncate">{stationMeta(station)}</p>
								</button>
								{#if currentStation?.stationuuid === station.stationuuid && isBuffering}
									<Loader class="w-5 h-5 animate-spin text-primary shrink-0" />
								{:else if currentStation?.stationuuid === station.stationuuid && isPlaying}
									<div class="flex gap-0.5 items-end h-5 shrink-0">
										{#each [3, 5, 4] as h}
											<div class="w-1 bg-primary rounded-full animate-pulse" style="height:{h * 4}px"></div>
										{/each}
									</div>
								{/if}
								<button
									onclick={() => toggleFavorite(station)}
									class="w-9 h-9 flex items-center justify-center rounded-full hover:bg-accent transition-colors shrink-0
										{isFavorite(station) ? 'text-yellow-500' : 'text-muted-foreground hover:text-yellow-500'}"
									aria-label={isFavorite(station) ? 'Remove from favorites' : 'Add to favorites'}
								>
									<Star class="w-5 h-5 {isFavorite(station) ? 'fill-yellow-500' : ''}" />
								</button>
							</li>
						{/each}
					</ul>
				{/if}
			</div>
		</div>
	{/if}
</div>
