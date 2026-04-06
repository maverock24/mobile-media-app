import netlifyAdapter from '@sveltejs/adapter-netlify';
import staticAdapter from '@sveltejs/adapter-static';

const isMobileBuild = process.env.BUILD_TARGET === 'mobile';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	kit: {
		adapter: isMobileBuild
			? staticAdapter({
				pages: 'dist-mobile',
				assets: 'dist-mobile'
			})
			: netlifyAdapter({
				edge: false,
				split: false
			}),
		csp: {
			mode: 'hash',
			directives: {
				'default-src': ['self'],
				'script-src': ['self', 'https://accounts.google.com'],
				'connect-src': [
					'self',
					'https://www.googleapis.com',
					'https://accounts.google.com',
					'https://oauth2.googleapis.com',
					'https://api.rss2json.com',
					'https://itunes.apple.com',
					'https://geocoding-api.open-meteo.com',
					'https://api.open-meteo.com',
					'https://mobile-media-app-maverock24.netlify.app',
					'https://raw.githubusercontent.com'
				],
				'img-src': ['self', 'data:', 'blob:', 'https:'],
				'media-src': ['self', 'blob:', 'https:'],
				'style-src': ['self', 'unsafe-inline'],
				'font-src': ['self', 'data:'],
				'frame-src': ['none'],
				'object-src': ['none'],
				'base-uri': ['self'],
				'form-action': ['self']
			}
		}
	},
	vitePlugin: {
		dynamicCompileOptions: ({ filename }) =>
			filename.includes('node_modules') ? undefined : { runes: true }
	}
};

export default config;
