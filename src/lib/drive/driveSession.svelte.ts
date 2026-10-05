/**
 * driveSession.svelte.ts — one deck's Google Drive access-token session.
 *
 * Extracted from `Mp3PlayerView.svelte` (PR 3.1 of docs/refactoring-plan.md).
 * Owns the access token, its expiry, the signed-in user and the last auth error
 * for one deck, plus the two functions that keep them fresh.
 * `googleDriveSession` stays the persistence owner: this module mirrors its
 * fields into per-deck state and writes back through `persist()`.
 *
 * Seam: `createDriveSession` is a factory, not a module singleton. Two decks
 * mount at once (the `deck` prop), so a shared instance would let deck A's token
 * answer for deck B. The caller injects the toast sink, because an interactive
 * sign-in failure must reach the user and the module stays UI-free, and the
 * OAuth client id it already read once at init.
 *
 * Order preserved from the view, because it is behaviour and not style:
 * `ensureDriveAccessToken` hydrates from the persisted session, then consumes a
 * pending native authorisation exactly once, then (interactive only) requests an
 * interactive token.
 */
import {
	consumePendingGoogleDriveAccessToken,
	requestGoogleDriveAccessToken,
	type GoogleDriveUser
} from '$lib/google-drive';
import { formatGoogleDriveAuthError } from '$lib/google-drive-auth-error';
import { googleDriveSession } from '$lib/stores/googleDriveSession.svelte';
import type { AddToastOptions } from '$lib/stores/toastStore.svelte';

export interface DriveSessionOptions {
	/** Sink for interactive auth failures (the view passes the toast store call). */
	addToast: (options: AddToastOptions) => void;
	/** Google OAuth client id, read once by the caller via getGoogleDriveClientId(). */
	clientId: string;
}

/** Per-deck Drive session state and the accessors that keep it current. */
export interface DriveSession {
	/** Access token in use by this deck. */
	accessToken: string;
	/** Epoch ms at which `accessToken` expires. */
	expiresAt: number;
	/** Signed-in Google user, when a session or profile fetch provided one. */
	user: GoogleDriveUser | null;
	/** Last auth failure, already formatted for display. */
	error: string;

	hasValidDriveToken(): boolean;
	ensureDriveAccessToken(interactive: boolean): Promise<string | null>;
}

export function createDriveSession(opts: DriveSessionOptions): DriveSession {
	const state = $state({
		accessToken: '',
		expiresAt: 0,
		user: null as GoogleDriveUser | null,
		error: ''
	});

	function hasValidDriveToken(): boolean {
		return state.accessToken.length > 0 && Date.now() < state.expiresAt - 60_000;
	}

	async function ensureDriveAccessToken(interactive: boolean): Promise<string | null> {
		if (hasValidDriveToken()) {
			return state.accessToken;
		}

		// Hydrate silently from the persisted session (survives page refresh)
		googleDriveSession.hydrateFromStorage();
		if (googleDriveSession.hasValidToken()) {
			state.accessToken = googleDriveSession.accessToken;
			state.expiresAt = googleDriveSession.expiresAt;
			state.user = googleDriveSession.user;
			return state.accessToken;
		}

		try {
			const pendingNativeAuthorization = await consumePendingGoogleDriveAccessToken();
			if (pendingNativeAuthorization?.access_token) {
				state.accessToken = pendingNativeAuthorization.access_token;
				state.expiresAt = Date.now() + Number(pendingNativeAuthorization.expires_in ?? 3600) * 1000;
				state.user = googleDriveSession.user;
				state.error = '';
				googleDriveSession.accessToken = state.accessToken;
				googleDriveSession.expiresAt = state.expiresAt;
				googleDriveSession.persist();
				return state.accessToken;
			}
		} catch {
			// Native auth recovery is best-effort; fall through to the normal flow.
		}

		if (!interactive) {
			return null;
		}

		try {
			const response = await requestGoogleDriveAccessToken({
				clientId: opts.clientId,
				prompt: state.accessToken ? '' : 'consent'
			});

			state.accessToken = response.access_token;
			state.expiresAt = Date.now() + Number(response.expires_in ?? 3600) * 1000;
			state.error = '';
			googleDriveSession.accessToken = state.accessToken;
			googleDriveSession.expiresAt = state.expiresAt;
			googleDriveSession.persist();
			return state.accessToken;
		} catch (error) {
			state.error = formatGoogleDriveAuthError(error);
			// Surface the real failure in every view (the browse header has no error
			// slot), so a failed Google sign-in is never a silent "nothing happened".
			if (interactive) {
				opts.addToast({ message: state.error, type: 'error' });
			}
			return null;
		}
	}

	return {
		get accessToken() { return state.accessToken; },
		set accessToken(value: string) { state.accessToken = value; },
		get expiresAt() { return state.expiresAt; },
		set expiresAt(value: number) { state.expiresAt = value; },
		get user() { return state.user; },
		set user(value: GoogleDriveUser | null) { state.user = value; },
		get error() { return state.error; },
		set error(value: string) { state.error = value; },
		hasValidDriveToken,
		ensureDriveAccessToken
	};
}
