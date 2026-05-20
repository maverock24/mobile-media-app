import { Capacitor, registerPlugin } from '@capacitor/core';

export interface NativeGoogleDriveAuthOptions {
	interactive?: boolean;
	scopes: string[];
}

export interface NativeGoogleDriveAuthResult {
	accessToken: string;
	expiresIn?: number;
	grantedScopes?: string[];
}

interface GoogleDriveNativePlugin {
	authorize(options: NativeGoogleDriveAuthOptions): Promise<NativeGoogleDriveAuthResult>;
}

const GoogleDriveNative = registerPlugin<GoogleDriveNativePlugin>('GoogleDriveNative');

export function isNativeGoogleDriveAuthAvailable(): boolean {
	return Capacitor.getPlatform() === 'android';
}

export async function requestNativeGoogleDriveAccessToken(
	options: NativeGoogleDriveAuthOptions
): Promise<NativeGoogleDriveAuthResult> {
	if (!isNativeGoogleDriveAuthAvailable()) {
		throw new Error('Native Google Drive authorization is only available on Android.');
	}

	return GoogleDriveNative.authorize(options);
}