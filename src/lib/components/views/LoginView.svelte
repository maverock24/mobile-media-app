<script lang="ts">
	import { onMount } from 'svelte';
	import Button from '$lib/components/ui/Button.svelte';
	import Card from '$lib/components/ui/Card.svelte';
	import { googleDriveSession } from '$lib/stores/googleDriveSession.svelte';
	import { Cloud, LogIn, LogOut, RefreshCw } from 'lucide-svelte';

	onMount(() => {
		void googleDriveSession.ensureUser();
	});

	async function handleSignIn() {
		await googleDriveSession.signIn();
	}

	async function handleRefreshConnection() {
		await googleDriveSession.signIn();
	}
</script>

<div class="flex flex-col min-h-full bg-background/85 overflow-y-auto p-4 sm:p-6">
	<div class="mb-6">
		<h1 class="text-3xl font-bold">Login</h1>
		<p class="text-sm text-muted-foreground mt-1">Sign in with Google to access your Drive content.</p>
	</div>

	<Card class="p-5 space-y-4">
		<div class="flex items-start gap-3">
			<div class="w-10 h-10 rounded-xl bg-gradient-to-br from-sky-500 to-blue-700 flex items-center justify-center shrink-0">
				<Cloud class="w-5 h-5 text-white" />
			</div>
			<div class="min-w-0 flex-1">
				<h2 class="font-semibold">Google Drive</h2>
				<p class="text-sm text-muted-foreground">Sign in to stream audio content from your Google Drive.</p>
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
						Sign in with Google
					{/if}
				</Button>
			{/if}
		</div>
	</Card>
</div>