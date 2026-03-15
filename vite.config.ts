import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
	plugins: [
		tailwindcss(),
		sveltekit(),
		VitePWA({
			registerType: 'autoUpdate',
			devOptions: { enabled: true },
			workbox: {
				// Don't cache the File System Access API responses — they're local files
				globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}']
			},
			manifest: {
				name: 'Mobile Media App',
				short_name: 'MediaApp',
				description: 'Music, Podcasts, Weather — all in one place',
				theme_color: '#0ea5e9',
				background_color: '#0f172a',
				display: 'standalone',
				scope: '/',
				start_url: '/',
				icons: [
					{ src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
					{ src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' }
				]
			}
		})
	]
});
