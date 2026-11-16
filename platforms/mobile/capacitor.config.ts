import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
	appId: 'cxxi.hub',
	appName: 'hub',
	// The shared UI is built by the @hub/app workspace (vite build → app/dist).
	webDir: '../../app/dist',
	// The UI's background (steel-900), so the WebView doesn't flash grey before
	// its first paint; matches the native splash (android res/values/colors.xml).
	backgroundColor: '#1E2025',
	// Forward the web console to logcat in release builds too (tag Capacitor/Console):
	// the release WebView isn't inspectable, and the updater/tunnel logs are the
	// only way to see what a sideloaded build does.
	loggingBehavior: 'production',
	plugins: {
		// The first style, the app's default theme (dark): light system bar icons (DEFAULT would follow
		// the phone's theme). The app's own theme then wins (ThemePlugin, Android).
		SystemBars: { style: 'DARK' }
	}
}

export default config
