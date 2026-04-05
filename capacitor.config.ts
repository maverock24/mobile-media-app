import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
	appId: 'com.maverock24.mobilemediaapp',
	appName: 'Media Hub',
	webDir: 'dist-mobile',
	android: {
		// Allow HTTP audio URLs from the HTTPS-scheme WebView (mixed content)
		// Required for podcasts with HTTP stream URLs on Android 9+
		allowMixedContent: true
	}
};

export default config;