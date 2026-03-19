import {
	fetchGoogleDriveUser,
	getGoogleDriveClientId,
	isGoogleDriveConfigured,
	requestGoogleDriveAccessToken,
	revokeGoogleDriveAccess,
	type GoogleDriveUser
} from '$lib/google-drive';

const GOOGLE_DRIVE_SESSION_KEY = 'google-drive-session';

type StoredGoogleDriveSession = {
	accessToken?: string;
	expiresAt?: number;
	user?: GoogleDriveUser | null;
};

function readStoredSession(): StoredGoogleDriveSession {
	if (typeof localStorage === 'undefined') {
		return {};
	}

	try {
		const raw = localStorage.getItem(GOOGLE_DRIVE_SESSION_KEY);
		if (!raw) {
			return {};
		}

		const parsed = JSON.parse(raw) as StoredGoogleDriveSession;
		return {
			accessToken: typeof parsed.accessToken === 'string' ? parsed.accessToken : '',
			expiresAt: typeof parsed.expiresAt === 'number' ? parsed.expiresAt : 0,
			user: parsed.user ?? null
		};
	} catch {
		return {};
	}
}

function writeStoredSession(session: StoredGoogleDriveSession) {
	if (typeof localStorage === 'undefined') {
		return;
	}

	if (!session.accessToken || !session.expiresAt || session.expiresAt <= Date.now()) {
		localStorage.removeItem(GOOGLE_DRIVE_SESSION_KEY);
		return;
	}

	localStorage.setItem(GOOGLE_DRIVE_SESSION_KEY, JSON.stringify(session));
}

const storedSession = readStoredSession();

function formatDriveAuthError(error: unknown): string {
	const message = error instanceof Error ? error.message : 'Unable to access Google Drive.';

	if (/popup_closed|popup closed|access denied|interrupted/i.test(message)) {
		return 'Google sign-in was cancelled.';
	}

	if (/public_google_client_id/i.test(message)) {
		return 'Google Drive is not configured. Add PUBLIC_GOOGLE_CLIENT_ID to enable sign-in.';
	}

	return message;
}

export const googleDriveSession = $state.raw({
	accessToken: storedSession.accessToken ?? '',
	expiresAt: storedSession.expiresAt ?? 0,
	user: storedSession.user ?? null,
	error: '',
	isAuthenticating: false,
	configured: isGoogleDriveConfigured(),
	clientId: getGoogleDriveClientId(),

	hasValidToken() {
		return this.accessToken.length > 0 && Date.now() < this.expiresAt - 60_000;
	},

	refreshConfiguration() {
		this.clientId = getGoogleDriveClientId();
		this.configured = isGoogleDriveConfigured();
	},

	hydrateFromStorage() {
		const stored = readStoredSession();
		if (!stored.accessToken || !stored.expiresAt || stored.expiresAt <= Date.now()) {
			return;
		}

		this.accessToken = stored.accessToken;
		this.expiresAt = stored.expiresAt;
		this.user = stored.user ?? this.user;
	},

	persist() {
		writeStoredSession({
			accessToken: this.accessToken,
			expiresAt: this.expiresAt,
			user: this.user
		});
	},

	async ensureUser(force = false): Promise<GoogleDriveUser | null> {
		this.hydrateFromStorage();

		if (!this.hasValidToken()) {
			return null;
		}

		if (this.user && !force) {
			return this.user;
		}

		try {
			this.user = await fetchGoogleDriveUser(this.accessToken);
			this.error = '';
			this.persist();
			return this.user;
		} catch (error) {
			this.error = formatDriveAuthError(error);
			return null;
		}
	},

	async ensureAccessToken(interactive = false): Promise<string | null> {
		this.refreshConfiguration();
		this.hydrateFromStorage();

		if (this.hasValidToken()) {
			this.persist();
			return this.accessToken;
		}

		if (!interactive) {
			return null;
		}

		if (!this.configured) {
			this.error = 'Google Drive is not configured. Add PUBLIC_GOOGLE_CLIENT_ID to enable sign-in.';
			return null;
		}

		this.isAuthenticating = true;

		try {
			const response = await requestGoogleDriveAccessToken({
				clientId: this.clientId,
				prompt: this.accessToken ? '' : 'consent'
			});

			this.accessToken = response.access_token;
			this.expiresAt = Date.now() + Number(response.expires_in ?? 3600) * 1000;
			this.error = '';
			this.persist();
			return this.accessToken;
		} catch (error) {
			this.error = formatDriveAuthError(error);
			return null;
		} finally {
			this.isAuthenticating = false;
		}
	},

	async signIn(): Promise<boolean> {
		const token = await this.ensureAccessToken(true);
		if (!token) {
			return false;
		}

		return Boolean(await this.ensureUser(true));
	},

	async signOut() {
		try {
			await revokeGoogleDriveAccess(this.accessToken);
		} catch {
			// Ignore revoke failures and clear session state regardless.
		}

		this.accessToken = '';
		this.expiresAt = 0;
		this.user = null;
		this.error = '';
		this.persist();
	},

	setError(message: string) {
		this.error = message;
	}
});