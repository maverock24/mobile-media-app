<script lang="ts">
	import { Capacitor } from '@capacitor/core';
	import { FilePicker } from '@capawesome/capacitor-file-picker';
	import { onMount } from 'svelte';
	import Button from '$lib/components/ui/Button.svelte';
	import Card from '$lib/components/ui/Card.svelte';
	import Input from '$lib/components/ui/Input.svelte';
	import { googleDriveSession } from '$lib/stores/googleDriveSession.svelte';
	import { essaySettings } from '$lib/stores/settings.svelte';
	import { fetchGoogleDriveFolder } from '$lib/google-drive';
	import { DirectoryReader } from '$lib/native/directory-reader';
	import { Cloud, ExternalLink, FolderOpen, LogIn, LogOut, RefreshCw } from 'lucide-svelte';

	const isNativeApp = typeof window !== 'undefined' && Capacitor.isNativePlatform();
	const canUseNativePicker = isNativeApp && Capacitor.isPluginAvailable('FilePicker');

	let folderInput = $state(essaySettings.googleDriveFolderUrl || essaySettings.googleDriveFolderId);
	let saveError = $state('');
	let isSavingFolder = $state(false);
	let isPickingNativeFolder = $state(false);
	const hasConfiguredDrive = $derived(Boolean(essaySettings.googleDriveFolderId));

	onMount(() => {
		void googleDriveSession.ensureUser();
	});

	function extractGoogleDriveFolderId(value: string): string {
		const trimmed = value.trim();
		if (!trimmed) return '';

		const folderMatch = trimmed.match(/\/folders\/([a-zA-Z0-9_-]+)/);
		if (folderMatch?.[1]) return folderMatch[1];

		const idMatch = trimmed.match(/[a-zA-Z0-9_-]{10,}/);
		return idMatch?.[0] ?? '';
	}

	async function handleSignIn() {
		saveError = '';
		await googleDriveSession.signIn();
	}

	async function handleRefreshConnection() {
		saveError = '';
		await googleDriveSession.signIn();
	}

	async function handleSaveFolder() {
		saveError = '';
		const folderId = extractGoogleDriveFolderId(folderInput);

		if (!folderId) {
			saveError = 'Paste a valid Google Drive folder link or folder ID.';
			return;
		}

		const accessToken = await googleDriveSession.ensureAccessToken(true);
		if (!accessToken) {
			saveError = googleDriveSession.error || 'Sign in to Google Drive first.';
			return;
		}

		isSavingFolder = true;

		try {
			const folder = await fetchGoogleDriveFolder(accessToken, folderId);
			if (folder.mimeType !== 'application/vnd.google-apps.folder') {
				throw new Error('The selected Google Drive item is not a folder.');
			}

			essaySettings.source = 'drive';
			essaySettings.googleDriveFolderId = folder.id;
			essaySettings.googleDriveFolderName = folder.name;
			essaySettings.googleDriveFolderUrl = folderInput.trim();
			essaySettings.nativeTreeUri = '';
			essaySettings.nativeFolderName = '';
			folderInput = folder.webViewLink || folder.id;
		} catch (error) {
			saveError = error instanceof Error ? error.message : 'Unable to access the selected folder.';
		} finally {
			isSavingFolder = false;
		}
	}

	async function handlePickNativeFolder() {
		if (!canUseNativePicker) {
			saveError = 'Folder selection is not available on this device.';
			return;
		}

		saveError = '';
		isPickingNativeFolder = true;

		try {
			const result = await FilePicker.pickDirectory();
			if (!result.path) {
				saveError = 'No folder was selected.';
				return;
			}

			const [directory, audioFiles] = await Promise.all([
				DirectoryReader.listEntries({ treeUri: result.path }),
				DirectoryReader.listAudioFiles({ treeUri: result.path })
			]);

			if (audioFiles.files.length === 0) {
				saveError = 'The selected folder does not contain any MP3 files.';
				return;
			}

			try {
				await DirectoryReader.rememberTreeUri({ treeUri: result.path });
			} catch (error) {
				console.warn('Unable to persist essays folder permission.', error);
			}

			essaySettings.source = 'native';
			essaySettings.nativeTreeUri = result.path;
			essaySettings.nativeFolderName = directory.folderName;
			essaySettings.googleDriveFolderId = '';
			essaySettings.googleDriveFolderName = '';
			essaySettings.googleDriveFolderUrl = '';
			folderInput = '';
		} catch (error) {
			saveError = error instanceof Error ? error.message : 'Unable to open the selected folder.';
		} finally {
			isPickingNativeFolder = false;
		}
	}

	function clearFolder() {
		essaySettings.source = 'static';
		essaySettings.googleDriveFolderId = '';
		essaySettings.googleDriveFolderName = '';
		essaySettings.googleDriveFolderUrl = '';
		essaySettings.nativeTreeUri = '';
		essaySettings.nativeFolderName = '';
		folderInput = '';
		saveError = '';
	}
</script>

<div class="flex flex-col min-h-full bg-background overflow-y-auto p-4 sm:p-6">
	<div class="mb-6">
		<h1 class="text-3xl font-bold">Login</h1>
		<p class="text-sm text-muted-foreground mt-1">Connect Google Drive and choose the folder used by Audio Essays.</p>
	</div>

	<div class="space-y-4">
		{#if !isNativeApp}
		<Card class="p-5 space-y-4">
			<div class="flex items-start gap-3">
				<div class="w-10 h-10 rounded-xl bg-gradient-to-br from-sky-500 to-blue-700 flex items-center justify-center shrink-0">
					<Cloud class="w-5 h-5 text-white" />
				</div>
				<div class="min-w-0 flex-1">
					<h2 class="font-semibold">Google Drive</h2>
					<p class="text-sm text-muted-foreground">Use a Drive folder as the source of your Audio Essays.</p>
				</div>
			</div>

			{#if googleDriveSession.user}
				<div class="rounded-lg border bg-muted/30 px-4 py-3">
					<p class="font-medium truncate">{googleDriveSession.user.displayName}</p>
					<p class="text-sm text-muted-foreground truncate">{googleDriveSession.user.emailAddress}</p>
				</div>
			{/if}

			{#if googleDriveSession.error}
				<p class="text-sm text-destructive">{googleDriveSession.error}</p>
			{/if}

			{#if !googleDriveSession.configured}
				<p class="text-sm text-muted-foreground">Google Drive sign-in is disabled until `PUBLIC_GOOGLE_CLIENT_ID` is configured at runtime or build time.</p>
			{/if}

			<div class="flex gap-2">
				{#if googleDriveSession.user}
					<Button variant="outline" onclick={handleRefreshConnection} class="gap-2" disabled={googleDriveSession.isAuthenticating}>
						{#if googleDriveSession.isAuthenticating}
							<RefreshCw class="w-4 h-4 animate-spin" />
							Refreshing...
						{:else}
							<RefreshCw class="w-4 h-4" />
							Refresh connection
						{/if}
					</Button>
					<Button variant="outline" onclick={() => googleDriveSession.signOut()} class="gap-2">
						<LogOut class="w-4 h-4" />
						Sign out
					</Button>
				{:else}
					<Button onclick={handleSignIn} class="gap-2" disabled={!googleDriveSession.configured || googleDriveSession.isAuthenticating}>
						{#if googleDriveSession.isAuthenticating}
							<RefreshCw class="w-4 h-4 animate-spin" />
							Connecting...
						{:else}
							<LogIn class="w-4 h-4" />
							{hasConfiguredDrive ? 'Reconnect Google Drive' : 'Sign in with Google'}
						{/if}
					</Button>
				{/if}
			</div>
		</Card>
		{/if}

		<Card class="p-5 space-y-4">
			<div class="flex items-start gap-3">
				<div class="w-10 h-10 rounded-xl bg-gradient-to-br from-violet-500 to-fuchsia-700 flex items-center justify-center shrink-0">
					<FolderOpen class="w-5 h-5 text-white" />
				</div>
				<div>
					<h2 class="font-semibold">Audio Essays Folder</h2>
					<p class="text-sm text-muted-foreground">
						{#if isNativeApp}
							Choose a folder from Android's document picker. If Google Drive is installed, you can select one of your Drive folders directly there.
						{:else}
							Paste a Google Drive folder link or folder ID. The Essays tab will read MP3s from that folder.
						{/if}
					</p>
				</div>
			</div>

			{#if isNativeApp}
				<Button onclick={handlePickNativeFolder} disabled={isPickingNativeFolder || !canUseNativePicker} class="gap-2">
					{#if isPickingNativeFolder}
						<RefreshCw class="w-4 h-4 animate-spin" />
						Opening folder picker...
					{:else}
						<FolderOpen class="w-4 h-4" />
						Choose essays folder
					{/if}
				</Button>
			{:else}
				<Input bind:value={folderInput} placeholder="https://drive.google.com/drive/folders/..." />
			{/if}

			{#if essaySettings.source === 'native' && essaySettings.nativeFolderName}
				<div class="rounded-lg border bg-muted/30 px-4 py-3">
					<p class="text-sm text-muted-foreground">Current folder</p>
					<p class="font-medium truncate">{essaySettings.nativeFolderName}</p>
				</div>
			{:else if essaySettings.googleDriveFolderName}
				<div class="rounded-lg border bg-muted/30 px-4 py-3">
					<p class="text-sm text-muted-foreground">Current folder</p>
					<p class="font-medium truncate">{essaySettings.googleDriveFolderName}</p>
				</div>
			{/if}

			{#if saveError}
				<p class="text-sm text-destructive">{saveError}</p>
			{/if}

			<div class="flex flex-wrap gap-2">
				{#if !isNativeApp}
					<Button onclick={handleSaveFolder} disabled={isSavingFolder || !googleDriveSession.configured} class="gap-2">
						{#if isSavingFolder}
							<RefreshCw class="w-4 h-4 animate-spin" />
							Saving...
						{:else}
							Use for Audio Essays
						{/if}
					</Button>
				{/if}
				<Button variant="outline" onclick={clearFolder}>Use bundled sample essays</Button>
			</div>

			{#if !isNativeApp && essaySettings.googleDriveFolderUrl}
				<a href={essaySettings.googleDriveFolderUrl} target="_blank" rel="noreferrer" class="inline-flex items-center gap-2 text-sm text-primary hover:underline">
					<ExternalLink class="w-4 h-4" />
					Open selected folder in Google Drive
				</a>
			{/if}
		</Card>
	</div>
</div>