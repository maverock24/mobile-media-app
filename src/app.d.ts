// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
declare global {
	interface GoogleTokenClient {
		requestAccessToken(options?: { prompt?: string }): void;
	}

	interface GoogleTokenClientConfig {
		client_id: string;
		scope: string;
		callback: (response: {
			access_token?: string;
			expires_in?: number;
			error?: string;
			error_description?: string;
			scope?: string;
			token_type?: string;
		}) => void;
		error_callback?: (error: { type: string }) => void;
	}

	interface Window {
		__GOOGLE_CLIENT_ID__?: string;
		google?: {
			accounts?: {
				oauth2: {
					initTokenClient(config: GoogleTokenClientConfig): GoogleTokenClient;
					revoke(token: string, done: () => void): void;
				};
			};
		};
	}

	namespace App {
		// interface Error {}
		// interface Locals {}
		// interface PageData {}
		// interface PageState {}
		// interface Platform {}
	}
}

export {};
