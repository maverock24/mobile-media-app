<script lang="ts">
	import Button from '$lib/components/ui/Button.svelte';
	import { radioData, type RadioStation } from '$lib/stores/settings.svelte';
	import { mediaEngine, claimAudio, registerAudioSource } from '$lib/stores/mediaEngine.svelte';
	import { addToast } from '$lib/stores/toastStore.svelte';
	import { Search, Radio, Star, Play, Pause, Loader, X, Wifi } from 'lucide-svelte';

	// ── Playback state ───────────────────────────────────────────
	let currentStation = $state<RadioStation | null>(null);
	let isPlaying      = $state(false);
	let isBuffering    = $state(false);
	let audioEl: HTMLAudioElement;

	// ── Search state ─────────────────────────────────────────────
	let searchQuery   = $state('');
	let searchResults = $state<RadioStation[]>([]);
	let searching     = $state(false);
	let searchError   = $state('');

	// ── Register stop-callback with media engine ─────────────────
	$effect(() => {
		registerAudioSource('radio', () => {
			if (audioEl && isPlaying) audioEl.pause();
		});
	});

	// ── Audio element event wiring ───────────────────────────────
	$effect(() => {
		if (!audioEl) return;
		const onPlay    = () => { isPlaying = true;  isBuffering = false; mediaEngine.setPlaying(true);  };
		const onPause   = () => { isPlaying = false; mediaEngine.setPlaying(false); };
		const onWaiting = () => { isBuffering = true; };
		const onPlaying = () => { isBuffering = false; };
		const onError   = () => {
			isBuffering = false;
			isPlaying   = false;
			const err = audioEl.error;
			console.error('[Radio] audio error:', err?.code, err?.message);
			// MediaError code 4 = MEDIA_ERR_SRC_NOT_SUPPORTED (includes mixed content / codec unsupported)
			addToast({ message: 'Stream unavailable. Try another station.', type: 'error', autoDismissMs: 4000 });
		};

		audioEl.addEventListener('play',    onPlay);
		audioEl.addEventListener('pause',   onPause);
		audioEl.addEventListener('waiting', onWaiting);
		audioEl.addEventListener('playing', onPlaying);
		audioEl.addEventListener('error',   onError);
		return () => {
			audioEl?.removeEventListener('play',    onPlay);
			audioEl?.removeEventListener('pause',   onPause);
			audioEl?.removeEventListener('waiting', onWaiting);
			audioEl?.removeEventListener('playing', onPlaying);
			audioEl?.removeEventListener('error',   onError);
		};
	});

	// ── Stop on unmount ──────────────────────────────────────────
	$effect(() => { return () => { audioEl?.pause(); }; });

	// ── Playback controls ────────────────────────────────────────
	function playStation(station: RadioStation) {
		claimAudio('radio');
		currentStation = station;
		// Live streams don't use src attribute directly — set and load
		audioEl.src = station.url_resolved;
		isBuffering = true;
		audioEl.play().catch((err) => {
			isBuffering = false;
			if (err?.name !== 'AbortError') {
				console.error('[Radio] play() failed:', err);
				addToast({ message: 'Stream unavailable. Try another station.', type: 'error', autoDismissMs: 4000 });
			}
		});
		mediaEngine.setNowPlaying({
			id:         station.stationuuid,
			source:     'radio',
			title:      station.name,
			subtitle:   [station.country, station.codec, station.bitrate ? `${station.bitrate}kbps` : '']
				.filter(Boolean).join(' · '),
			audioUrl:   station.url_resolved,
			artworkUrl: station.favicon || undefined,
		}, 'radio');
	}

	function stopPlayback() {
		audioEl?.pause();
		audioEl.src = '';
		currentStation = null;
		mediaEngine.clear();
	}

	function togglePlay() {
		if (!audioEl || !currentStation) return;
		if (isPlaying) {
			audioEl.pause();
		} else {
			claimAudio('radio');
			isBuffering = true;
			audioEl.play().catch((err) => {
				isBuffering = false;
				console.error('[Radio] togglePlay() failed:', err);
			});
		}
	}

	// ── Search (radio-browser.info public API) ───────────────────
	// The API has multiple servers; pick one randomly to distribute load.
	const RADIO_SERVERS = [
		'https://de1.api.radio-browser.info',
		'https://at1.api.radio-browser.info',
		'https://nl1.api.radio-browser.info',
	];
	function radioApiBase() {
		return RADIO_SERVERS[Math.floor(Math.random() * RADIO_SERVERS.length)] + '/json';
	}

	async function search() {
		const q = searchQuery.trim();
		if (!q) return;
		searching   = true;
		searchError = '';
		searchResults = [];
		try {
			const params = new URLSearchParams({
				name:       q,
				limit:      '100',  // fetch more to compensate for HTTP-only stations being filtered out
				order:      'votes',
				reverse:    'true',
				hidebroken: 'true',
			});
			const res = await fetch(`${radioApiBase()}/stations/search?${params}`, {
				headers: { 'User-Agent': 'MediaHubApp/1.0' }
			});
			if (!res.ok) throw new Error(`Search failed: ${res.status}`);
			const data = await res.json() as RadioStation[];
			// Filter to HTTPS-only streams — HTTP streams are blocked as mixed content
			// when the app is served over HTTPS
			const httpsOnly = data.filter(s => s.url_resolved?.startsWith('https://'));
			searchResults = httpsOnly;
			if (!data.length) {
				searchError = 'No stations found. Try different keywords.';
			} else if (!httpsOnly.length) {
				searchError = 'No secure (HTTPS) streams found for this query. Try a different search term.';
			}
		} catch (e) {
			searchError = e instanceof Error ? e.message : 'Search failed';
		} finally {
			searching = false;
		}
	}

	// ── Favorites ────────────────────────────────────────────────
	function isFavorite(station: RadioStation) {
		return radioData.favorites.some(f => f.stationuuid === station.stationuuid);
	}

	function toggleFavorite(station: RadioStation) {
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
</script>

<!-- Hidden audio element -->
<audio bind:this={audioEl} preload="none"></audio>

<div class="flex flex-col h-full bg-background/85">

	<!-- ── Now Playing bar ──────────────────────────────────────── -->
	{#if currentStation}
		<div class="shrink-0 border-b bg-primary/5 px-4 py-3 flex items-center gap-3">
			{#if currentStation.favicon}
				<img src={currentStation.favicon} alt="" class="w-10 h-10 rounded-lg object-cover shrink-0" />
			{:else}
				<div class="w-10 h-10 rounded-lg bg-primary/20 flex items-center justify-center shrink-0">
					<Radio class="w-5 h-5 text-primary" />
				</div>
			{/if}
			<div class="flex-1 min-w-0">
				<p class="text-sm font-semibold truncate">{currentStation.name}</p>
				<p class="text-xs text-muted-foreground truncate">{stationMeta(currentStation)}</p>
			</div>

			{#if isBuffering}
				<div class="w-10 h-10 flex items-center justify-center">
					<Loader class="w-5 h-5 animate-spin text-primary" />
				</div>
			{:else}
				<button
					onclick={togglePlay}
					class="w-10 h-10 flex items-center justify-center rounded-full bg-primary/10 hover:bg-primary/20 text-primary transition-colors"
					aria-label={isPlaying ? 'Pause' : 'Play'}
				>
					{#if isPlaying}
						<Pause class="w-5 h-5" />
					{:else}
						<Play class="w-5 h-5 ml-0.5" />
					{/if}
				</button>
			{/if}

			<button
				onclick={stopPlayback}
				class="w-10 h-10 flex items-center justify-center rounded-full hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
				aria-label="Stop"
			>
				<X class="w-5 h-5" />
			</button>
		</div>
	{/if}

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
						<li class="flex items-center gap-3 px-4 py-3 {currentStation?.stationuuid === station.stationuuid ? 'bg-primary/5' : ''}">
							{#if station.favicon}
								<img src={station.favicon} alt="" class="w-10 h-10 rounded-lg object-cover shrink-0" />
							{:else}
								<div class="w-10 h-10 rounded-lg bg-muted flex items-center justify-center shrink-0">
									<Radio class="w-5 h-5 text-muted-foreground" />
								</div>
							{/if}
							<button
								class="flex-1 min-w-0 text-left"
								onclick={() => playStation(station)}
							>
								<p class="text-sm font-medium truncate">{station.name}</p>
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
					<div class="flex flex-col items-center justify-center h-48 gap-3 text-muted-foreground px-6 text-center">
						<Radio class="w-10 h-10 opacity-30" />
						<p class="text-sm">Search for your favorite radio stations by name.</p>
					</div>
				{:else}
					<ul class="divide-y">
						{#each searchResults as station (station.stationuuid)}
							<li class="flex items-center gap-3 px-4 py-3 {currentStation?.stationuuid === station.stationuuid ? 'bg-primary/5' : ''}">
								{#if station.favicon}
									<img src={station.favicon} alt="" class="w-10 h-10 rounded-lg object-cover shrink-0" onerror={(e) => ((e.target as HTMLImageElement).style.display = 'none')} />
								{:else}
									<div class="w-10 h-10 rounded-lg bg-muted flex items-center justify-center shrink-0">
										<Radio class="w-5 h-5 text-muted-foreground" />
									</div>
								{/if}
								<button
									class="flex-1 min-w-0 text-left"
									onclick={() => playStation(station)}
								>
									<p class="text-sm font-medium truncate">{station.name}</p>
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
