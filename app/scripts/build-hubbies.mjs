#!/usr/bin/env node
// The app ships no hubby: each one is installed from the catalogue when enabled (the hubby
// managers, desktop and Android). Its build only writes, next to it:
//   <out>/hubbies/catalog.js, catalog.json  the built-in hubbies: none (the managers answer catalog.js
//                                           themselves, with the installed ones)
//   <out>/hubbies/sdk.json                  the SDK version this build provides (what a hubby must fit)
// Run by the app build itself (build/sharedRuntime.ts).

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const APP = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(join(APP, 'package.json'))

export function writeBuiltInCatalog(out) {
	const dir = join(resolve(out), 'modules')
	mkdirSync(dir, { recursive: true })
	writeFileSync(join(dir, 'catalog.js'), 'export default []\n')
	writeFileSync(join(dir, 'catalog.json'), '[]\n')
	writeFileSync(join(dir, 'sdk.json'), readFileSync(require.resolve('@cxxi-lab/hubbyware-sdk/version.json')))
}

