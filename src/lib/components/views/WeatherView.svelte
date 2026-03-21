
<script lang="ts">
	import Button from '$lib/components/ui/Button.svelte';
	import Card from '$lib/components/ui/Card.svelte';
	import { weatherSettings, type SavedCity } from '$lib/stores/settings.svelte';
	import {
		Search, Wind, Droplets, Eye, Thermometer,
		MapPin, Plus, Trash2, RefreshCw, ArrowUp, ArrowDown, X
	} from 'lucide-svelte';

	// ── WMO weather code lookup ──────────────────────────────────
	const WMO: Record<number, [string, string]> = {
		0:  ['☀️', 'Clear Sky'],     1:  ['🌤', 'Mainly Clear'],
		2:  ['⛅', 'Partly Cloudy'], 3:  ['🌥', 'Overcast'],
		45: ['🌫', 'Fog'],           48: ['🌫', 'Icy Fog'],
		51: ['🌦', 'Light Drizzle'], 53: ['🌦', 'Drizzle'],   55: ['🌧', 'Heavy Drizzle'],
		56: ['🌧', 'Frz. Drizzle'],  57: ['🌧', 'Frz. Drizzle'],
		61: ['🌧', 'Light Rain'],    63: ['🌧', 'Rain'],       65: ['🌧', 'Heavy Rain'],
		66: ['🌨', 'Frz. Rain'],     67: ['🌨', 'Heavy Frz. Rain'],
		71: ['🌨', 'Light Snow'],    73: ['🌨', 'Snow'],       75: ['❄️', 'Heavy Snow'],
		77: ['❄️', 'Snow Grains'],
		80: ['🌦', 'Light Showers'], 81: ['🌧', 'Showers'],   82: ['🌧', 'Heavy Showers'],
		85: ['🌨', 'Snow Showers'],  86: ['❄️', 'Heavy Snow Showers'],
		95: ['⛈', 'Thunderstorm'],  96: ['⛈', 'Thunderstorm'],99: ['⛈', 'T-Storm + Hail'],
	};
	// Night-specific icon overrides (codes 0–2 look different after dark)
	const WMO_NIGHT: Partial<Record<number, string>> = {
		0: '🌙', // Clear Sky
		1: '🌙', // Mainly Clear
		2: '☁️', // Partly Cloudy
	};
	function wmoIcon(code: number, isDay = true) {
		if (!isDay && code in WMO_NIGHT) return WMO_NIGHT[code]!;
		return (WMO[code] ?? ['🌡', ''])[0];
	}
	function wmoLabel(code: number) { return (WMO[code] ?? ['', 'Unknown'])[1]; }
	function getBgGradient(code: number, isDay = true) {
		if (!isDay) {
			if (code <= 2)  return 'from-indigo-950 to-slate-800';
			if (code === 3) return 'from-slate-700 to-slate-600';
		}
		if (code === 0) return 'from-amber-500 to-orange-400';
		if (code <= 2)  return 'from-sky-500 to-blue-400';
		if (code === 3) return 'from-slate-500 to-slate-400';
		if (code <= 48) return 'from-slate-400 to-gray-400';
		if (code <= 67) return 'from-slate-600 to-sky-500';
		if (code <= 77) return 'from-blue-300 to-sky-200';
		if (code <= 82) return 'from-slate-600 to-sky-400';
		return            'from-slate-700 to-slate-500';
	}

	// ── Types ────────────────────────────────────────────────────
	interface GeoResult { name: string; country: string; country_code: string;
	                       latitude: number; longitude: number; timezone: string; }
	interface HourlySlot { time: string; temp: number; code: number; isDay: boolean; }
	interface DailySlot  { date: string; day: string; high: number; low: number; code: number; }
	interface WeatherData {
		city: string; country: string;
		temp: number; feelsLike: number; humidity: number;
		windSpeed: number; windDir: number; visibility: number;
		code: number; isDay: boolean;
		high: number; low: number;
		hourly: HourlySlot[];
		daily: DailySlot[];
		fetchedAt: number;
	}

	// ── State ────────────────────────────────────────────────────
	let cache = new Map<string, WeatherData>();
	let current    = $state<WeatherData | null>(null);
	let loadError  = $state<string | null>(null);
	let isLoading  = $state(false);
	let isRefreshing = $state(false);

	let isSearching   = $state(false);
	let searchQuery   = $state('');
	let geoResults    = $state<GeoResult[]>([]);
	let geoLoading    = $state(false);

	// ── Unit helpers ─────────────────────────────────────────────
	function toF(c: number) { return Math.round(c * 9 / 5 + 32); }
	function displayTemp(c: number) {
		return weatherSettings.units === 'F' ? `${toF(c)}°` : `${Math.round(c)}°`;
	}

	// ── Date helpers ─────────────────────────────────────────────
	const DAY_NAMES = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
	function parseDayLabel(dateStr: string): string {
		const d = new Date(dateStr + 'T00:00:00');
		const today = new Date(); today.setHours(0,0,0,0);
		const diff = Math.round((d.getTime() - today.getTime()) / 86400000);
		if (diff === 0) return 'Today';
		if (diff === 1) return 'Tmrw';
		const month = d.toLocaleString('en', { month: 'short' });
		return `${DAY_NAMES[d.getDay()]} ${d.getDate()} ${month}`;
	}

	// ── Fetch geocoding ──────────────────────────────────────────
	async function searchGeo(q: string) {
		if (q.length < 2) { geoResults = []; return; }
		geoLoading = true;
		try {
			const res = await fetch(
				`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=6&language=en&format=json`
			);
			const data = await res.json();
			geoResults = (data.results ?? []) as GeoResult[];
		} catch { geoResults = []; }
		geoLoading = false;
	}

	// ── Debounce search ──────────────────────────────────────────
	$effect(() => {
		const q = searchQuery;
		if (q.length < 2) { geoResults = []; return; }
		const t = setTimeout(() => searchGeo(q), 400);
		return () => clearTimeout(t);
	});

	// ── Fetch weather from Open-Meteo ────────────────────────────
	async function fetchWeather(city: SavedCity, force = false): Promise<void> {
		const key = city.name;
		const cached = cache.get(key);
		if (!force && cached && Date.now() - cached.fetchedAt < 10 * 60 * 1000) {
			current = cached; return;
		}
		isLoading = true; loadError = null;
		try {
			const url = [
				'https://api.open-meteo.com/v1/forecast',
				`?latitude=${city.lat}&longitude=${city.lon}`,
				`&current=temperature_2m,apparent_temperature,relative_humidity_2m`,
				`,wind_speed_10m,wind_direction_10m,weather_code,is_day`,
				`&hourly=temperature_2m,weather_code,visibility,is_day`,
				`&daily=weather_code,temperature_2m_max,temperature_2m_min`,
				`&forecast_days=14&timezone=${encodeURIComponent(city.timezone)}`,
				`&wind_speed_unit=kmh`,
			].join('');
			const res = await fetch(url);
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const d = await res.json();

			// Hourly: next 24 hours starting from current hour
			const nowHour = new Date().toISOString().slice(0, 13);
			const hTimes:  string[]  = d.hourly.time;
			const hTemps:  number[]  = d.hourly.temperature_2m;
			const hCodes:  number[]  = d.hourly.weather_code;
			const hVis:    number[]  = d.hourly.visibility;
			const hIsDay:  number[]  = d.hourly.is_day ?? [];
			let hIdx = hTimes.findIndex(t => t.startsWith(nowHour));
			if (hIdx < 0) hIdx = 0;
			const hourly: HourlySlot[] = [];
			for (let i = hIdx; i < Math.min(hIdx + 24, hTimes.length); i++) {
				const dt = new Date(hTimes[i]);
				const h  = dt.getHours();
				const label = i === hIdx ? 'Now'
					: h === 0  ? '12AM'
					: h < 12   ? `${h}AM`
					: h === 12 ? '12PM'
					: `${h - 12}PM`;
				hourly.push({ time: label, temp: hTemps[i], code: hCodes[i], isDay: hIsDay[i] !== 0 });
			}

			// Daily: all returned forecast days
			const dTimes: string[]  = d.daily.time;
			const dMax:   number[]  = d.daily.temperature_2m_max;
			const dMin:   number[]  = d.daily.temperature_2m_min;
			const dCodes: number[]  = d.daily.weather_code;
			const daily: DailySlot[] = dTimes.map((t, i) => ({
				date: t,
				day:  parseDayLabel(t),
				high: dMax[i],
				low:  dMin[i],
				code: dCodes[i],
			}));

			const w: WeatherData = {
				city: city.name, country: city.country,
				temp:       d.current.temperature_2m,
				feelsLike:  d.current.apparent_temperature,
				humidity:   d.current.relative_humidity_2m,
				windSpeed:  d.current.wind_speed_10m,
				windDir:    d.current.wind_direction_10m,
				visibility: hVis[hIdx] != null ? Math.round(hVis[hIdx] / 1000) : 0,
				code:       d.current.weather_code,
				isDay:      d.current.is_day !== 0,
				high:       dMax[0] ?? d.current.temperature_2m,
				low:        dMin[0] ?? d.current.temperature_2m,
				hourly, daily,
				fetchedAt: Date.now(),
			};
			cache.set(key, w);
			current = w;
		} catch (e: unknown) {
			loadError = e instanceof Error ? e.message : 'Failed to load weather';
		}
		isLoading = false; isRefreshing = false;
	}

	// ── Auto-load when active city changes ───────────────────────
	$effect(() => {
		const city = weatherSettings.savedCities.find(c => c.name === weatherSettings.activeCity);
		if (city) fetchWeather(city);
	});

	// ── Add city from geo search ─────────────────────────────────
	function addCity(geo: GeoResult) {
		const city: SavedCity = {
			name:     geo.name,
			country:  geo.country_code ?? geo.country,
			lat:      geo.latitude,
			lon:      geo.longitude,
			timezone: geo.timezone,
		};
		if (!weatherSettings.savedCities.find(c => c.name === city.name)) {
			weatherSettings.savedCities = [...weatherSettings.savedCities, city];
		}
		weatherSettings.activeCity = city.name;
		searchQuery = ''; geoResults = []; isSearching = false;
	}

	function removeCity(name: string) {
		weatherSettings.savedCities = weatherSettings.savedCities.filter(c => c.name !== name);
		cache.delete(name);
		if (weatherSettings.activeCity === name) {
			weatherSettings.activeCity = weatherSettings.savedCities[0]?.name ?? '';
		}
	}

	async function refresh() {
		isRefreshing = true;
		const city = weatherSettings.savedCities.find(c => c.name === weatherSettings.activeCity);
		if (city) await fetchWeather(city, true);
	}

	function windDirLabel(deg: number): string {
		const dirs = ['N','NE','E','SE','S','SW','W','NW'];
		return dirs[Math.round(deg / 45) % 8];
	}
</script>

<div class="flex flex-col h-full bg-background/85">

	<!-- ── Header ──────────────────────────────────────────────── -->
	<div class="p-4 border-b space-y-3 shrink-0">
		<div class="flex items-center justify-between">
			<h1 class="text-xl font-bold">Weather</h1>
			<div class="flex items-center gap-2">
				<!-- °C / °F toggle -->
				<div class="flex rounded-lg bg-muted overflow-hidden text-xs">
					<button class="px-2.5 py-1.5 font-medium {weatherSettings.units === 'C' ? 'bg-background shadow' : 'text-muted-foreground'}"
						onclick={() => (weatherSettings.units = 'C')}>°C</button>
					<button class="px-2.5 py-1.5 font-medium {weatherSettings.units === 'F' ? 'bg-background shadow' : 'text-muted-foreground'}"
						onclick={() => (weatherSettings.units = 'F')}>°F</button>
				</div>
				<Button variant="ghost" size="icon" onclick={refresh} disabled={isRefreshing}>
					<RefreshCw class="w-4 h-4 {isRefreshing ? 'animate-spin' : ''}" />
				</Button>
			</div>
		</div>

		{#if isSearching}
			<!-- City Search -->
			<div class="space-y-2">
				<div class="flex gap-2">
					<div class="relative flex-1">
						<Search class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
						<input
							type="text"
							placeholder="Search city…"
							bind:value={searchQuery}
							class="w-full pl-9 pr-4 py-2 bg-secondary border border-border rounded-lg text-sm outline-none focus:ring-1 focus:ring-ring"
						/>
						{#if geoLoading}
							<div class="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 border-2 border-primary border-t-transparent rounded-full animate-spin"></div>
						{/if}
					</div>
					<Button variant="outline" onclick={() => { isSearching = false; searchQuery = ''; geoResults = []; }}>
						Cancel
					</Button>
				</div>
				{#if geoResults.length > 0}
					<div class="border rounded-lg overflow-hidden bg-card">
						{#each geoResults as geo}
							{@const alreadySaved = weatherSettings.savedCities.some(c => c.name === geo.name && c.lat.toFixed(2) === geo.latitude.toFixed(2))}
							<button
								class="w-full flex items-center gap-2 p-3 hover:bg-accent transition-colors text-left border-b last:border-0"
								onclick={() => addCity(geo)}
								disabled={alreadySaved}
							>
								<MapPin class="w-4 h-4 text-muted-foreground shrink-0" />
								<div class="flex-1 min-w-0">
									<span class="text-sm font-medium">{geo.name}</span>
									{#if geo.country}
										<span class="text-xs text-muted-foreground ml-1">{geo.country}</span>
									{/if}
								</div>
								{#if alreadySaved}
									<span class="text-xs text-muted-foreground">Saved</span>
								{:else}
									<Plus class="w-3.5 h-3.5 text-primary" />
								{/if}
							</button>
						{/each}
					</div>
				{:else if searchQuery.length > 1 && !geoLoading}
					<p class="text-xs text-center text-muted-foreground py-2">No cities found</p>
				{/if}
			</div>
		{:else}
			<!-- City tabs -->
			<div class="flex gap-2 overflow-x-auto pb-1 no-scrollbar">
				{#each weatherSettings.savedCities as city}
					<button
						class="shrink-0 px-3 py-1.5 rounded-full text-sm font-medium transition-colors {city.name === weatherSettings.activeCity ? 'bg-primary text-primary-foreground' : 'bg-secondary text-secondary-foreground hover:bg-secondary/80'}"
						onclick={() => (weatherSettings.activeCity = city.name)}
					>
						{#if city.name === weatherSettings.activeCity && isLoading}
							<span class="inline-flex items-center gap-1.5">
								<span class="w-3 h-3 border border-current border-t-transparent rounded-full animate-spin"></span>
								{city.name}
							</span>
						{:else}
							{city.name}
						{/if}
					</button>
				{/each}
				<button
					class="shrink-0 w-8 h-8 rounded-full bg-secondary flex items-center justify-center hover:bg-secondary/80 transition-colors"
					onclick={() => (isSearching = true)}
					aria-label="Add city"
				>
					<Plus class="w-4 h-4" />
				</button>
			</div>
		{/if}
	</div>

	<!-- ── Content ──────────────────────────────────────────────── -->
	<div class="flex-1 overflow-y-auto">

		{#if isLoading && !current}
			<!-- Loading state -->
			<div class="flex flex-col items-center justify-center h-64 gap-4">
				<div class="w-10 h-10 border-4 border-primary/30 border-t-primary rounded-full animate-spin"></div>
				<p class="text-sm text-muted-foreground">Loading weather…</p>
			</div>

		{:else if loadError}
			<!-- Error state -->
			<div class="flex flex-col items-center justify-center h-64 gap-3 px-6 text-center">
				<span class="text-4xl">⚠️</span>
				<p class="text-sm text-muted-foreground">{loadError}</p>
				<Button variant="outline" size="sm" onclick={refresh}>Retry</Button>
			</div>

		{:else if current}
			<!-- ── Current Weather Hero ── -->
			<div class="bg-gradient-to-br {getBgGradient(current.code, current.isDay)} text-white p-6 m-4 rounded-2xl shadow-lg relative overflow-hidden">
				{#if isRefreshing}
					<div class="absolute inset-0 bg-black/20 flex items-center justify-center rounded-2xl">
						<div class="w-6 h-6 border-3 border-white border-t-transparent rounded-full animate-spin"></div>
					</div>
				{/if}
				<div class="flex items-start justify-between">
					<div>
						<div class="flex items-center gap-1.5 mb-1">
							<MapPin class="w-4 h-4 opacity-80" />
							<span class="text-sm font-medium opacity-90">{current.city}, {current.country}</span>
						</div>
						<div class="text-7xl font-thin mb-1">{displayTemp(current.temp)}</div>
						<p class="text-lg opacity-90 mb-1">{wmoLabel(current.code)}</p>
						<div class="flex items-center gap-3 text-sm opacity-80">
							<span class="flex items-center gap-1"><ArrowUp class="w-3.5 h-3.5" />{displayTemp(current.high)}</span>
							<span class="flex items-center gap-1"><ArrowDown class="w-3.5 h-3.5" />{displayTemp(current.low)}</span>
							<span>Feels {displayTemp(current.feelsLike)}</span>
						</div>
					</div>
					<div class="text-6xl">{wmoIcon(current.code, current.isDay)}</div>
				</div>
			</div>

			<!-- ── Hourly Forecast ── -->
			<div class="mx-4 mb-4">
				<Card class="p-4">
					<h3 class="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-3">Next 24 Hours</h3>
					<div class="flex gap-3 overflow-x-auto pb-1 no-scrollbar">
						{#each current.hourly as h}
							<div class="flex flex-col items-center gap-1.5 shrink-0 min-w-[52px]">
								<span class="text-xs text-muted-foreground">{h.time}</span>
								<span class="text-xl">{wmoIcon(h.code, h.isDay)}</span>
								<span class="text-sm font-medium">{displayTemp(h.temp)}</span>
							</div>
						{/each}
					</div>
				</Card>
			</div>

			<!-- ── Stats Grid ── -->
			<div class="mx-4 mb-4 grid grid-cols-2 gap-3">
				<Card class="p-4">
					<div class="flex items-center gap-2 mb-2">
						<Droplets class="w-4 h-4 text-blue-400" />
						<span class="text-xs text-muted-foreground uppercase font-semibold tracking-wide">Humidity</span>
					</div>
					<p class="text-2xl font-bold">{current.humidity}%</p>
				</Card>
				<Card class="p-4">
					<div class="flex items-center gap-2 mb-2">
						<Wind class="w-4 h-4 text-slate-400" />
						<span class="text-xs text-muted-foreground uppercase font-semibold tracking-wide">Wind</span>
					</div>
					<p class="text-2xl font-bold">{Math.round(current.windSpeed)} <span class="text-sm font-normal text-muted-foreground">km/h {windDirLabel(current.windDir)}</span></p>
				</Card>
				<Card class="p-4">
					<div class="flex items-center gap-2 mb-2">
						<Eye class="w-4 h-4 text-purple-400" />
						<span class="text-xs text-muted-foreground uppercase font-semibold tracking-wide">Visibility</span>
					</div>
					<p class="text-2xl font-bold">{current.visibility} <span class="text-sm font-normal text-muted-foreground">km</span></p>
				</Card>
				<Card class="p-4">
					<div class="flex items-center gap-2 mb-2">
						<Thermometer class="w-4 h-4 text-red-400" />
						<span class="text-xs text-muted-foreground uppercase font-semibold tracking-wide">Feels Like</span>
					</div>
					<p class="text-2xl font-bold">{displayTemp(current.feelsLike)}</p>
				</Card>
			</div>

			<!-- ── 4-Week Daily Forecast ── -->
			<div class="mx-4 mb-6">
				<Card>
					<div class="p-4 border-b flex items-center justify-between">
						<h3 class="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
							{current.daily.length}-Day Forecast
						</h3>
						<span class="text-xs text-muted-foreground">{current.daily.length} days</span>
					</div>
					{#each current.daily as day, i}
						<div class="flex items-center px-4 py-3 gap-3 {i < current.daily.length - 1 ? 'border-b' : ''}">
							<span class="w-20 text-sm font-medium shrink-0">{day.day}</span>
							<span class="text-xl shrink-0">{wmoIcon(day.code)}</span>
							<span class="flex-1 text-sm text-muted-foreground truncate">{wmoLabel(day.code)}</span>
							<div class="flex items-center gap-3 text-sm shrink-0">
								<span class="flex items-center gap-0.5 text-muted-foreground">
									<ArrowDown class="w-3 h-3" />{displayTemp(day.low)}
								</span>
								<span class="flex items-center gap-0.5 font-medium">
									<ArrowUp class="w-3 h-3" />{displayTemp(day.high)}
								</span>
							</div>
						</div>
					{/each}
				</Card>
			</div>

			<!-- ── Saved Cities ── -->
			{#if weatherSettings.savedCities.length > 1}
				<div class="mx-4 mb-6">
					<Card>
						<div class="p-4 border-b">
							<h3 class="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Saved Cities</h3>
						</div>
						{#each weatherSettings.savedCities as city, i}
							{@const cached = cache.get(city.name)}
							<div class="flex items-center px-4 py-3 gap-3 {i < weatherSettings.savedCities.length - 1 ? 'border-b' : ''}">
								<MapPin class="w-4 h-4 text-muted-foreground shrink-0" />
								<button class="flex-1 min-w-0 text-left" onclick={() => (weatherSettings.activeCity = city.name)}>
									<span class="text-sm font-medium">{city.name}</span>
									<span class="text-xs text-muted-foreground ml-1">{city.country}</span>
								</button>
								{#if cached}
									<span class="text-sm text-muted-foreground">{displayTemp(cached.temp)}</span>
									<span class="text-lg">{wmoIcon(cached.code, cached.isDay)}</span>
								{/if}
								<Button variant="ghost" size="icon" class="w-7 h-7 text-muted-foreground hover:text-destructive shrink-0"
									onclick={() => removeCity(city.name)}>
									<X class="w-3.5 h-3.5" />
								</Button>
							</div>
						{/each}
					</Card>
				</div>
			{/if}

		{/if}
	</div>
</div>
