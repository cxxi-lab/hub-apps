#!/usr/bin/env node
// The APK ships no hubby: each one is installed from the server when enabled (see
// android/.../HubbyStore.java). Drops the hubbies' folders the web build copied into the assets,
// keeping hubbies/sdk.json (the SDK this APK provides) and the public catalogue files.
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const hubbies = join(dirname(fileURLToPath(import.meta.url)), '../android/app/src/main/assets/public/modules')
const dropped = readdirSync(hubbies).filter(name => statSync(join(hubbies, name)).isDirectory())
for (const name of dropped) rmSync(join(hubbies, name), { recursive: true })
// the restricted hubbies' entries: no trace of them in the APK (each account gets its own from the server)
if (existsSync(join(hubbies, 'restricted.json'))) rmSync(join(hubbies, 'restricted.json'))
console.log(`modules left out of the APK: ${dropped.join(', ') || 'none'}`)
