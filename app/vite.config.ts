import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import svgr from 'vite-plugin-svgr'
import { resolve } from 'path'
import { sharedRuntime } from './build/sharedRuntime'

const shared = sharedRuntime(__dirname)

// Standalone build of the shared UI for the mobile (Capacitor) shell. The
// Electron build goes through desktop/electron.vite.config.ts instead; the only
// deliberate difference is `@platform-impl`, mapped here to the Capacitor
// adapter so the Electron adapter and its `@preload` import never enter this
// bundle.
export default defineConfig({
	root: __dirname,
	plugins: [react(), tailwindcss(), svgr(), shared.plugin],
	resolve: {
		alias: {
			...shared.alias,
			'@': resolve(__dirname, 'src'),
			'@core': resolve(__dirname, 'src/core'),
			'@shared': resolve(__dirname, 'src/shared'),
			'@platform': resolve(__dirname, 'src/platform'),
			'@platform-impl': resolve(__dirname, 'src/platform/capacitor.ts')
		}
	},
	build: {
		outDir: 'dist',
		emptyOutDir: true,
		...shared.build
	}
})
