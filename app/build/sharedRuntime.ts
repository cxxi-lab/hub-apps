import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Plugin, UserConfig } from 'vite'

/**
 * What the app shares with the module bundles, one instance each: the app build emits them as
 * `shared/<name>.js` entries with their real export names, and a module bundle imports them from
 * there instead of embedding its own copy (see scripts/build-modules.mjs). The SDK is the module
 * contract, the design system its components; the others are the libraries that must stay single (React and its renderers, the
 * router, FontAwesome's React component and core). Icons are embedded by each module.
 */
export const SHARED: Record<string, string> = createRequire(import.meta.url)('@cxxi-lab/hub-sdk/shared.json')

const VIRTUAL = 'virtual:hub-shared/'
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/

/**
 * The app build's extra entries (`shared/<name>.js`) and the plugin generating the npm ones: a
 * CommonJS package (React) has no static export names, so each entry re-exports, by name, every
 * key the package has.
 */
/**
 * Where the modules' sources are, for development (the app loads them from there, hot reload):
 * HUB_MODULES_DIR, else src/modules if there is one, else the modules' folder next to the apps'
 * (~/dev/hub/modules, each module's repository).
 */
export function modulesDir(appRoot: string): string {
	if (process.env.HUB_MODULES_DIR) return resolve(process.env.HUB_MODULES_DIR)
	const inside = resolve(appRoot, 'src/modules')
	return existsSync(inside) ? inside : resolve(appRoot, '../../modules')
}

export function sharedRuntime(appRoot: string): { plugin: Plugin[], build: NonNullable<UserConfig['build']>, alias: Record<string, string> } {
	const require = createRequire(resolve(appRoot, 'package.json'))
	// ES sources, entries as they are: the SDK (implemented by the app) and the design system
	const SOURCES: Record<string, string> = { '@cxxi-lab/hub-sdk': resolve(appRoot, 'src/sdk/index.ts'), '@cxxi-lab/hub-ui': '@cxxi-lab/hub-ui' }
	const inputs: Record<string, string> = {}
	for (const [specifier, name] of Object.entries(SHARED)) {
		inputs[`shared/${name}`] = SOURCES[specifier] ?? VIRTUAL + specifier
	}

	let outDir = ''
	const plugin: Plugin = {
		name: 'hub-shared-runtime',
		apply: 'build',
		configResolved(config) {
			outDir = resolve(config.root, config.build.outDir)
		},
		// The app ships no module (each is installed from the catalogue): an empty built-in catalogue
		// and the SDK version it provides (what a module must fit).
		async closeBundle() {
			const { writeBuiltInCatalog } = await import(pathToFileURL(resolve(appRoot, 'scripts/build-modules.mjs')).href)
			writeBuiltInCatalog(outDir)
			// the runtime of the hubbies running isolated (their frames): docs/plan-module-architecture.md § 4 ter
			const { buildHubbyRuntime } = await import(pathToFileURL(resolve(appRoot, 'scripts/build-hubby-runtime.mjs')).href)
			await buildHubbyRuntime(outDir)
		},
		resolveId(id) {
			return id.startsWith(VIRTUAL) ? '\0' + id : null
		},
		load(id) {
			if (!id.startsWith('\0' + VIRTUAL)) return null
			const specifier = id.slice(1 + VIRTUAL.length)
			const keys = Object.keys(require(specifier) as object).filter(k => k !== 'default' && IDENTIFIER.test(k))
			return [
				`import * as m from '${specifier}'`,
				`export default (m.default ?? m)`,
				keys.length ? `export const { ${keys.join(', ')} } = m` : ''
			].join('\n')
		}
	}

	// The SDK's package holds its types only: the app is its implementation (dev and build alike;
	// its subpaths, /frame and /protocol, are the package's own files)
	const sdk: Plugin = {
		name: 'hub-sdk-source',
		enforce: 'pre',
		// development: the modules' sources live outside this repository (../../modules)
		config: () => ({ server: { fs: { allow: [resolve(appRoot, '..'), modulesDir(appRoot)] } } }),
		resolveId(id) {
			return id === '@cxxi-lab/hub-sdk' ? SOURCES[id] : null
		}
	}

	return {
		alias: { '@hub-modules': modulesDir(appRoot) },
		plugin: [sdk, plugin],
		build: {
			rollupOptions: {
				input: { index: resolve(appRoot, 'index.html'), ...inputs },
				// the shared entries keep their export names: modules import them by name
				preserveEntrySignatures: 'exports-only',
				output: {
					entryFileNames: chunk => chunk.name.startsWith('shared/') ? '[name].js' : 'assets/[name]-[hash].js'
				}
			}
		}
	}
}
