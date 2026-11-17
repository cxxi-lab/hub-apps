import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Plugin, UserConfig } from 'vite'

/**
 * What the app shares with the hubby bundles, one instance each: the app build emits them as
 * `shared/<name>.js` entries with their real export names, and a hubby bundle imports them from
 * there instead of embedding its own copy (see scripts/build-hubbies.mjs). The SDK is the hubby
 * contract, the design system its components; the others are the libraries that must stay single (React and its renderers, the
 * router, FontAwesome's React component and core). Icons are embedded by each hubby.
 */
export const SHARED: Record<string, string> = createRequire(import.meta.url)('@cxxi-lab/hubbyware-sdk/shared.json')

const VIRTUAL = 'virtual:hub-shared/'
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/

/**
 * The app build's extra entries (`shared/<name>.js`) and the plugin generating the npm ones: a
 * CommonJS package (React) has no static export names, so each entry re-exports, by name, every
 * key the package has.
 */
/**
 * Where the hubbies' sources are, for development (the app loads them from there, hot reload):
 * HUB_HUBBIES_DIR, else src/hubbies if there is one, else the official hubbies' checkout next to the apps'
 * (repos/hubbies beside repos/client).
 */
export function hubbiesDir(appRoot: string): string {
	if (process.env.HUB_HUBBIES_DIR) return resolve(process.env.HUB_HUBBIES_DIR)
	const inside = resolve(appRoot, 'src/modules')
	if (existsSync(inside)) return inside
	const next = resolve(appRoot, '../../hubbies')
	return existsSync(next) ? next : resolve(appRoot, '../../modules')
}

/** A hubby's id: its hubby.json's, else its folder's name (as hubby-cli reads it); null: not a hubby. */
function hubbyId(dir: string): string | null {
	const file = join(dir, 'hubby.json')
	if (!existsSync(file)) return null
	const id = (JSON.parse(readFileSync(file, 'utf8')) as { id?: unknown }).id
	return typeof id === 'string' ? id : basename(dir)
}

export function sharedRuntime(appRoot: string): { plugin: Plugin[], build: NonNullable<UserConfig['build']>, alias: Record<string, string> } {
	const require = createRequire(resolve(appRoot, 'package.json'))
	// ES sources, entries as they are: the SDK (implemented by the app) and the design system
	const SOURCES: Record<string, string> = { '@cxxi-lab/hubbyware-sdk': resolve(appRoot, 'src/sdk/index.ts'), '@cxxi-lab/hubbyware-ui': '@cxxi-lab/hubbyware-ui' }
	const inputs: Record<string, string> = {}
	for (const [specifier, name] of Object.entries(SHARED)) {
		inputs[`shared/${name}`] = SOURCES[specifier] ?? VIRTUAL + specifier
	}
	// the SDK's entry is instantiated once per hubby (sdk.js?hubby=<id>, src/sdk/index.ts): all
	// but its API calls in an entry of their own, so nothing else is duplicated with it
	inputs['shared/sdk-contract'] = resolve(appRoot, 'src/sdk/contract.ts')

	let outDir = ''
	const plugin: Plugin = {
		name: 'hub-shared-runtime',
		apply: 'build',
		configResolved(config) {
			outDir = resolve(config.root, config.build.outDir)
		},
		// The app ships no hubby (each is installed from the catalogue): an empty built-in catalogue
		// and the SDK version it provides (what a hubby must fit).
		async closeBundle() {
			const { writeBuiltInCatalog } = await import(pathToFileURL(resolve(appRoot, 'scripts/build-hubbies.mjs')).href)
			writeBuiltInCatalog(outDir)
			// the runtime of the hubbies running isolated (their frames): docs/plan-hubby-architecture.md § 4 ter
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
	let serving = false
	const sdk: Plugin = {
		name: 'hubbyware-sdk-source',
		enforce: 'pre',
		// development: the hubbies' sources live outside this repository (../../hubbies)
		config: () => ({ server: { fs: { allow: [resolve(appRoot, '..'), hubbiesDir(appRoot)] } } }),
		configResolved(config) {
			serving = config.command === 'serve'
		},
		resolveId(id, importer) {
			if (id !== '@cxxi-lab/hubbyware-sdk') return null
			// a hubby's sources (development): its own instance, as its bundle gets (src/sdk/index.ts)
			if (!serving) return SOURCES[id]
			const rel = importer ? relative(hubbiesDir(appRoot), importer.split('?')[0]) : '..'
			const folder = rel.startsWith('..') || isAbsolute(rel) ? null : rel.split(sep)[0]
			const hubby = folder ? hubbyId(join(hubbiesDir(appRoot), folder)) : null
			return hubby ? `${SOURCES[id]}?hubby=${hubby}` : SOURCES[id]
		}
	}

	return {
		alias: { '@hub-hubbies': hubbiesDir(appRoot) },
		plugin: [sdk, plugin],
		build: {
			rollupOptions: {
				input: { index: resolve(appRoot, 'index.html'), ...inputs },
				// the shared entries keep their export names: hubbies import them by name
				preserveEntrySignatures: 'exports-only',
				output: {
					// what only the SDK's entry imports (the web socle it binds to each hubby…): in a
					// chunk of its own, not in the entry, which is instantiated once per hubby
					manualChunks(id, { getModuleInfo }) {
						const entry = SOURCES['@cxxi-lab/hubbyware-sdk']
						const seen = new Set<string>()
						const onlyFromSdk = (m: string): boolean => {
							if (seen.has(m)) return true
							seen.add(m)
							const importers = getModuleInfo(m)?.importers ?? []
							return importers.length > 0 && importers.every(i => i === entry || onlyFromSdk(i))
						}
						return id !== entry && onlyFromSdk(id) ? 'sdk-bound' : undefined
					},
					entryFileNames: chunk => chunk.name.startsWith('shared/') ? '[name].js' : 'assets/[name]-[hash].js'
				}
			}
		}
	}
}
