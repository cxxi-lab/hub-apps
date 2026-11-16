#!/usr/bin/env node
// The APK ships no module: each one is installed from the server when enabled (see
// android/.../ModuleStore.java). Drops the modules' folders the web build copied into the assets,
// keeping modules/sdk.json (the SDK this APK provides) and the public catalogue files.
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const modules = join(dirname(fileURLToPath(import.meta.url)), '../android/app/src/main/assets/public/modules')
const dropped = readdirSync(modules).filter(name => statSync(join(modules, name)).isDirectory())
for (const name of dropped) rmSync(join(modules, name), { recursive: true })
// the restricted modules' entries: no trace of them in the APK (each account gets its own from the server)
if (existsSync(join(modules, 'restricted.json'))) rmSync(join(modules, 'restricted.json'))
console.log(`modules left out of the APK: ${dropped.join(', ') || 'none'}`)
