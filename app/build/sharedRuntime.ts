import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Plugin, UserConfig } from 'vite'

/**
 * What the app build adds for the hubbies, which all run isolated (docs/plan-isolation.md): the
 * runtime their frames load (scripts/build-hubby-runtime.mjs: React, react-router, the design
 * system, the SDK's common API) and the built-in catalogue (none: each hubby is installed from the
 * catalogue). No hubby code runs in the app any more: it shares nothing with them but this runtime.
 */

/**
 * Where the hubbies' sources are, for development (the app reads their hubby.json and models
 * there, their frames load their built files): HUB_HUBBIES_DIR, else the official hubbies'
 * checkout next to the apps' (repos/hubbies beside repos/client).
 */
export function hubbiesDir(appRoot: string): string {
	if (process.env.HUB_HUBBIES_DIR) return resolve(process.env.HUB_HUBBIES_DIR)
	const next = resolve(appRoot, '../../hubbies')
	return existsSync(next) ? next : resolve(appRoot, '../../modules')
}

export function sharedRuntime(appRoot: string): { plugin: Plugin[], build: NonNullable<UserConfig['build']>, alias: Record<string, string> } {
	let outDir = ''
	const plugin: Plugin = {
		name: 'hub-hubby-runtime',
		apply: 'build',
		configResolved(config) {
			outDir = resolve(config.root, config.build.outDir)
		},
		// The app ships no hubby (each is installed from the catalogue): an empty built-in catalogue
		// and the SDK version it provides (what a hubby must fit); the frames' runtime.
		async closeBundle() {
			const { writeBuiltInCatalog } = await import(pathToFileURL(resolve(appRoot, 'scripts/build-hubbies.mjs')).href)
			writeBuiltInCatalog(outDir)
			const { buildHubbyRuntime } = await import(pathToFileURL(resolve(appRoot, 'scripts/build-hubby-runtime.mjs')).href)
			await buildHubbyRuntime(outDir)
		}
	}
	// development: the hubbies' sources live outside this repository
	const sources: Plugin = {
		name: 'hub-hubby-sources',
		config: () => ({ server: { fs: { allow: [resolve(appRoot, '..'), hubbiesDir(appRoot)] } } })
	}

	return {
		alias: { '@hub-hubbies': hubbiesDir(appRoot) },
		plugin: [sources, plugin],
		build: {
			rollupOptions: {
				input: { index: resolve(appRoot, 'index.html') }
			}
		}
	}
}
