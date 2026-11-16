#!/usr/bin/env node
// Hubby boundaries of the app (see app/src/sdk):
//  - a hubby (src/hubbies/<id>, in development only: the hubbies have their own repositories) imports
//    only its own files and packages: the SDK (@cxxi-lab/hubbyware-sdk),
//    the design system (@cxxi-lab/hubbyware-ui), npm ones;
//  - nothing outside the hubbies imports a hubby, except the hubby catalogue (core/hubby/registry).
// Reports every crossing; with --strict, fails when there is one (CI, once the hubbies are clean).
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, normalize, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src')
const STRICT = process.argv.includes('--strict')
const ALIASES = { '@core': 'core', '@shared': 'shared', '@platform': 'platform', '@': '' }
// Core files allowed to know the hubbies (to be emptied by the hubby system, then this list too).
const CORE_ALLOWED = new Set(['core/hubby/registry.tsx'])

function files(dir) {
	return readdirSync(dir).flatMap(name => {
		const path = join(dir, name)
		return statSync(path).isDirectory() ? files(path) : /\.(ts|tsx)$/.test(name) ? [path] : []
	})
}

/** The import's target, relative to src ('core/api/client'), or null for an npm package. */
function target(spec, file) {
	if (spec.startsWith('.')) return relative(SRC, normalize(join(dirname(file), spec))).split(sep).join('/')
	for (const [alias, dir] of Object.entries(ALIASES)) {
		if (spec === alias || spec.startsWith(alias + '/')) return (dir + spec.slice(alias.length)).replace(/^\//, '')
	}
	return null
}

const IMPORT = /(?:^|[\s;])(?:import|export)\s+(?:type\s+)?(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g
const crossings = []
for (const file of files(SRC)) {
	const rel = relative(SRC, file).split(sep).join('/')
	const owner = rel.startsWith('modules/') ? rel.split('/')[1] : null
	const source = readFileSync(file, 'utf8')
	for (const match of source.matchAll(IMPORT)) {
		const spec = match[1] ?? match[2]
		const to = target(spec, file)
		if (to === null) continue
		if (owner) {
			if (to.startsWith(`modules/${owner}/`) || to === `modules/${owner}`) continue
			crossings.push({ owner, file: rel, spec })
		}
		else if (to.startsWith('modules/') && !CORE_ALLOWED.has(rel) && !rel.startsWith('sdk/')) {
			crossings.push({ owner: '(core)', file: rel, spec })
		}
	}
}

const byOwner = Object.groupBy(crossings, c => c.owner)
for (const [owner, list] of Object.entries(byOwner).sort()) {
	console.log(`${owner}: ${list.length}`)
	for (const c of list) console.log(`  ${c.file}  →  ${c.spec}`)
}
console.log(crossings.length === 0 ? 'Hubby boundaries: clean.' : `Hubby boundaries: ${crossings.length} crossing(s).`)
process.exit(STRICT && crossings.length > 0 ? 1 : 0)
