import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import svgr from 'vite-plugin-svgr'
import { resolve } from 'path'
import { sharedRuntime } from '../../app/build/sharedRuntime'

// The renderer (shared UI) lives in the sibling `app/` workspace so the same
// React code can also be packaged by the mobile (Capacitor) shell. The Electron
// main/preload stay here; `@preload` still resolves into this package until the
// platform abstraction replaces window.api.
const appRoot = resolve(__dirname, '../../app')
const shared = sharedRuntime(appRoot)

export default defineConfig({
	main: {
		// the SDK's version (hubby manager) is read at build: bundled, not a dependency of the package
		plugins: [externalizeDepsPlugin({ exclude: ['@cxxi-lab/hubbyware-sdk'] })]
	},
	preload: {
		plugins: [externalizeDepsPlugin()],
		// Windows run sandboxed, and sandboxed preloads must be CommonJS (package is
		// "type": "hubby", hence the explicit .cjs extension).
		build: {
			rollupOptions: {
				output: {
					format: 'cjs',
					entryFileNames: '[name].cjs'
				}
			}
		}
	},
	renderer: {
		root: appRoot,
		envDir: appRoot,
		plugins: [react(), tailwindcss(), svgr(), shared.plugin],
		resolve: {
			alias: {
				...shared.alias,
				'@': resolve(appRoot, 'src'),
				'@core': resolve(appRoot, 'src/core'),
				'@shared': resolve(appRoot, 'src/shared'),
					'@platform': resolve(appRoot, 'src/platform'),
				'@platform-impl': resolve(appRoot, 'src/platform/electron.ts'),
				'@preload': resolve(__dirname, 'src/preload')
			}
		},
		build: shared.build
	}
})
