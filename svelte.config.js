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
			})
	},
	vitePlugin: {
		dynamicCompileOptions: ({ filename }) =>
			filename.includes('node_modules') ? undefined : { runes: true }
	}
};

export default config;
