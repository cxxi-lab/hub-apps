import createPlatform from '@platform-impl'

// `@platform-impl` is remapped per shell at build time (electron-vite → electron.ts,
// the mobile Vite build → capacitor.ts), so each bundle pulls in only its own
// adapter — the Electron adapter and its `@preload` dependency never reach the
// mobile build, and vice versa.
export const platform = createPlatform()

export * from './types'
