<script lang="ts">
	import { Capacitor } from '@capacitor/core';
	import { onMount } from 'svelte';
	import EssayCard from '$lib/components/EssayCard.svelte';
	import Button from '$lib/components/ui/Button.svelte';
	import { googleDriveSession } from '$lib/stores/googleDriveSession.svelte';
	import { essayPlayer } from '$lib/stores/essayPlayer.svelte';
	import { essaySettings } from '$lib/stores/settings.svelte';
	import { listGoogleDriveMp3Files } from '$lib/google-drive';
	import { DirectoryReader, type NativeDirectoryFile } from '$lib/native/directory-reader';
	import { isValidAudioUrl } from '$lib/utils/validation';
	import type { EssayMetadata, EssayLibrary } from '$lib/models/essay';

	const isNativeApp = typeof window !== 'undefined' && Capacitor.isNativePlatform();

	let essays: EssayMetadata[] = $state([]);
	let loading: boolean = $state(true);
	let error: string | null = $state(null);
	let activeSourceKey = $state('');

	onMount(async () => {
		await loadEssays();
	});

	$effect(() => {
		const sourceKey = [
			essaySettings.source,
			essaySettings.googleDriveFolderId,
			essaySettings.nativeTreeUri,
			essaySettings.nativeFolderName,
			googleDriveSession.user?.emailAddress ?? '',
			googleDriveSession.accessToken ? 'token-present' : 'token-missing',
			String(googleDriveSession.expiresAt)
		].join(':');
		if (!sourceKey || sourceKey === activeSourceKey) return;
		activeSourceKey = sourceKey;
		void loadEssays();
	});

	function deriveEssayTitle(fileName: string) {
		return fileName.replace(/\.mp3$/i, '').replace(/[_-]+/g, ' ').trim();
	}

	function mapDriveFileToEssay(file: import('$lib/google-drive').GoogleDriveFile): EssayMetadata {
		const publishedDate = file.modifiedTime ?? new Date().toISOString();
		const sizeBytes = file.size ? Number(file.size) : 0;
		const sizeMb = sizeBytes > 0 ? Number((sizeBytes / (1024 * 1024)).toFixed(1)) : 0;
		const title = deriveEssayTitle(file.name);

		return {
			id: file.id,
			title,
			description: `Audio essay from Google Drive folder ${essaySettings.googleDriveFolderName || 'Audio Essays'}.`,
			author: 'Google Drive',
			topic: 'essay',
			audioUrl: '',
			duration: 0,
			fileSize: sizeMb,
			publishedDate,
			tags: ['google-drive', 'audio-essay'],
			source: 'drive',
			googleDriveFileId: file.id,
			mimeType: file.mimeType
		};
	}

	function mapNativeFileToEssay(file: NativeDirectoryFile): EssayMetadata {
		const title = deriveEssayTitle(file.name);
		const publishedDate = file.modifiedAt ? new Date(file.modifiedAt).toISOString() : new Date().toISOString();

		return {
			id: `native:${file.relativePath}`,
			title,
			description: `Audio essay from ${essaySettings.nativeFolderName || 'your selected folder'}.`,
			author: 'Selected Folder',
			topic: 'essay',
			audioUrl: '',
			duration: 0,
			fileSize: 0,
			publishedDate,
			tags: ['device-folder', 'audio-essay'],
			source: 'native',
			nativePath: file.path,
			nativeTreeUri: essaySettings.nativeTreeUri,
			mimeType: file.mimeType
		};
	}

	async function loadEssays() {
		loading = true;
		error = null;
		try {
			if (essaySettings.source === 'native') {
				if (!isNativeApp || !essaySettings.nativeTreeUri) {
					essays = [];
					error = 'Choose an essays folder from the Login tab to load MP3s on this device.';
					return;
				}

				const result = await DirectoryReader.listAudioFiles({ treeUri: essaySettings.nativeTreeUri });
				essays = result.files.map((file) => mapNativeFileToEssay(file));
				return;
			}

			if (essaySettings.source === 'drive') {
				if (!essaySettings.googleDriveFolderId) {
					essays = [];
					error = 'Choose a Google Drive folder from the Login tab to load Audio Essays.';
					return;
				}

				const accessToken = await googleDriveSession.ensureAccessToken(false);
				if (!accessToken) {
					essays = [];
					error = 'Sign in from the Login tab to load Audio Essays from Google Drive.';
					return;
				}

				const files = await listGoogleDriveMp3Files(accessToken, { folderId: essaySettings.googleDriveFolderId });
				essays = files.map((file) => mapDriveFileToEssay(file));
				return;
			}

			const response = await fetch('/data/essays.json');
			if (!response.ok) {
				throw new Error('Failed to load essays');
			}
			const data: EssayLibrary = await response.json();
			essays = data.essays;
		} catch (err) {
			error = err instanceof Error ? err.message : 'Unknown error';
			console.error('Error loading essays:', err);
		} finally {
			loading = false;
		}
	}

	async function retryLoad() {
		await loadEssays();
	}

	function handlePlayEssay(essay: EssayMetadata) {
		if (essay.source === 'static' && !isValidAudioUrl(essay.audioUrl)) {
			console.warn('Invalid audio URL for essay:', essay.title);
			return;
		}
		console.log('Playing:', essay.title);
		essayPlayer.selectEssay(essay);
	}
</script>

<div class="w-full h-full flex flex-col p-4 md:p-6">
	<!-- Header -->
	<header class="mb-6">
		<h1 class="text-3xl md:text-4xl font-bold mb-2">Audio Essays</h1>
		<p class="text-muted-foreground">
			{essaySettings.source === 'drive'
				? `Reading MP3 files from ${essaySettings.googleDriveFolderName || 'your Google Drive folder'}.`
				: essaySettings.source === 'native'
					? `Reading MP3 files from ${essaySettings.nativeFolderName || 'your selected folder'}.`
					: 'Discover thought-provoking essays on science, history, philosophy, and more.'}
		</p>
	</header>

	<!-- Loading State -->
	{#if loading}
		<div class="flex-1 flex items-center justify-center">
			<div class="text-center">
				<div class="inline-block w-8 h-8 border-4 border-primary border-t-transparent rounded-full animate-spin mb-4"></div>
				<p class="text-muted-foreground">Loading essays...</p>
			</div>
		</div>
	{/if}

	<!-- Error State -->
	{#if error}
		<div class="flex-1 flex items-center justify-center">
			<div class="text-center">
				<p class="text-destructive font-semibold mb-2">Error loading essays</p>
				<p class="text-muted-foreground text-sm mb-4">{error}</p>
				<Button variant="default" onclick={retryLoad}>
					Retry
				</Button>
			</div>
		</div>
	{/if}

	<!-- Essays Grid -->
	{#if !loading && !error && essays.length > 0}
		<div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-2 sm:gap-3 md:gap-4 flex-1">
			{#each essays as essay, i (essay.id)}
				<EssayCard {essay} onPlay={handlePlayEssay} index={i} />
			{/each}
		</div>
	{/if}

	<!-- Empty State -->
	{#if !loading && !error && essays.length === 0}
		<div class="flex-1 flex items-center justify-center">
			<div class="text-center">
				<p class="text-muted-foreground">No essays found</p>
			</div>
		</div>
	{/if}
</div>
