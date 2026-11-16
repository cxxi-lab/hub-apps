// The runtime a hubby's frame loads next to the hubby's own code (docs/plan-hubby-architecture.md
// § 4 ter): React, the design system and the guest SDK, as ES hubbies sharing one React, plus the
// base stylesheet. A hubby imports them by name (react, react/jsx-runtime, react-dom/client,
// @fortawesome/react-fontawesome, @cxxi-lab/hubbyware-ui, @cxxi-lab/hubbyware-sdk/frame), mapped to these files by the frame's import map.
//   <out>/hubby-runtime/<name>.js, <out>/hubby-runtime/runtime.css
// Run by the app build (build/sharedRuntime.ts, after the hubbies), or by hand:
//   node scripts/build-hubby-runtime.mjs [out]
import { build } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import svgr from 'vite-plugin-svgr'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const APP = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(join(APP, 'package.json'))
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/

/** The import map's names → the runtime's files (the frame page, desktop and Android, uses it). */
export const RUNTIME = {
	'react': 'react',
	'react/jsx-runtime': 'jsx-runtime',
	'react-dom/client': 'react-dom-client',
	'@fortawesome/react-fontawesome': 'fontawesome-react',
	'@cxxi-lab/hubbyware-ui': 'ui',
	'@cxxi-lab/hubbyware-sdk/frame': 'sdk'
}

/**
 * The names hubbies built before import (same files): kept for the bundles already published —
 * the monorepo's (@hub/…), then the packages' before the rename (until layer 5 of the rename).
 */
const LEGACY = { '@hub/ui': 'ui', '@hub/sdk': 'sdk', '@cxxi-lab/hub-ui': 'ui', '@cxxi-lab/hub-sdk/frame': 'sdk' }

const NPM = ['react', 'react/jsx-runtime', 'react-dom/client', '@fortawesome/react-fontawesome']

export async function buildHubbyRuntime(out) {
	const outDir = join(resolve(out), 'hubby-runtime')
	// CommonJS packages (React) have no static export names: a small file re-exports each by name
	// (lib mode wants real files as entries; this place resolves the packages as the app does)
	const generated = join(APP, 'node_modules/.cache/hubby-runtime')
	mkdirSync(generated, { recursive: true })
	const entry = { ui: require.resolve('@cxxi-lab/hubbyware-ui'), sdk: require.resolve('@cxxi-lab/hubbyware-sdk/frame') }
	for (const spec of NPM) {
		const mod = require(spec)
		const keys = Object.keys(mod).filter(k => k !== 'default' && IDENTIFIER.test(k))
		const file = join(generated, `${RUNTIME[spec]}.js`)
		// a CommonJS package (react…) gets its hubby as default; an ES one without a default, its namespace
		const fallback = mod.__esModule && !('default' in mod) ? 'export default m' : 'export default (m.default ?? m)'
		writeFileSync(file, [`import * as m from '${spec}'`, fallback, keys.length ? `export const { ${keys.join(', ')} } = m` : ''].join('\n') + '\n')
		entry[RUNTIME[spec]] = file
	}
	await build({
		configFile: false,
		root: APP,
		logLevel: 'warn',
		publicDir: false,
		plugins: [react(), tailwindcss(), svgr()],
		define: { 'process.env.NODE_ENV': JSON.stringify('production') },
		build: {
			outDir,
			emptyOutDir: true,
			cssCodeSplit: false,
			lib: { entry, formats: ['es'], fileName: (_format, name) => `${name}.js`, cssFileName: 'runtime' },
			rollupOptions: { output: { chunkFileNames: 'chunks/[name]-[hash].js' }, preserveEntrySignatures: 'exports-only' }
		}
	})
	// The frame's page, the same for every hubby (the platform serves it at the hubby's root, the
	// runtime under /_runtime/, the hubby's files at the root): the import map (allowed by its hash,
	// nothing else inline), the base styles then the hubby's, the boot script. No network.
	const importMap = JSON.stringify({ imports: Object.fromEntries(Object.entries({ ...RUNTIME, ...LEGACY }).map(([spec, name]) => [spec, `/_runtime/${name}.js`])) })
	const mapHash = createHash('sha256').update(importMap).digest('base64')
	const csp = [
		"default-src 'none'",
		`script-src 'self' 'sha256-${mapHash}'`,
		"style-src 'self' 'unsafe-inline'",
		"font-src 'self' data:",
		"img-src 'self' data: blob:",
		"connect-src 'none'"
	].join('; ')
	writeFileSync(join(outDir, 'frame.html'), `<!doctype html>
<html lang="en">
<head>
	<meta charset="utf-8" />
	<meta name="viewport" content="width=device-width, initial-scale=1" />
	<meta http-equiv="Content-Security-Policy" content="${csp}" />
	<script type="importmap">${importMap}</script>
	<link rel="stylesheet" href="/_runtime/runtime.css" />
	<link rel="stylesheet" href="/style.css" />
	<title>hubby</title>
</head>
<body>
	<div id="root"></div>
	<script type="module" src="/_runtime/boot.js"></script>
</body>
</html>
`)
	// the hubby's own code (its index.js, at the root) defines it; the SDK runs it
	writeFileSync(join(outDir, 'boot.js'), "import definition from '/index.js'\nimport { start } from '@cxxi-lab/hubbyware-sdk/frame'\nstart(definition)\n")
	console.log(`hubby runtime → ${outDir}`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	await buildHubbyRuntime(process.argv[2] ?? join(APP, 'dist'))
}
