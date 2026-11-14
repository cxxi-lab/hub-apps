import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { HashRouter, Routes, Route } from 'react-router'
import { AuthGate } from '@core/auth/AuthGate'
import { StatusBar } from '@core/layout/StatusBar'
import { Home } from '@core/home/Home'
import { AppLayout } from '@core/layout/AppLayout'
import { AudioMutedProvider } from '@core/contexts/AudioMutedContext'
import { DevModeProvider } from '@core/contexts/DevModeContext'
import { AboutApp } from '@core/windows/AboutApp'
import { UpdateApp, UpdateGate } from '@core/windows/UpdateApp'
import { loadModules, MODULE_MANIFESTS } from '@core/module/registry'
import { SettingsApp } from '@core/settings/SettingsApp'
import { handleBack } from '@cxxi-lab/hub-ui'
import { initBaseUrl } from '@core/api/baseUrl'
import { bootAuth } from '@core/auth/authState'
import { platform } from '@platform'
import './styles/index.css'

// the phone's back button (MainActivity calls it; it does the rest itself when it answers false)
window.hubBack = handleBack

const windowKind = new URLSearchParams(window.location.search).get('window')

const root = createRoot(document.getElementById('app')!)

// The modules first: every window lists or renders them.
loadModules().then(render)

function render(): void {
	if (windowKind === 'settings') {
		initBaseUrl().then(() => {
			root.render(
				<StrictMode>
					<SettingsApp />
				</StrictMode>
			)
		})
	}
	else if (windowKind === 'module') {
		// A module's own window (ModuleManifest.windows), opened by the desktop for an active module.
		const params = new URLSearchParams(window.location.search)
		const Window = MODULE_MANIFESTS.find(m => m.id === params.get('module'))?.windows?.find(w => w.id === params.get('id'))?.Component
		initBaseUrl().then(() => {
			root.render(
				<StrictMode>
					{Window ? <Window /> : <div className="p-6 text-sm text-steel-300">This window belongs to a module that is not installed.</div>}
				</StrictMode>
			)
		})
	}
	else if (windowKind === 'update') {
		root.render(
			<StrictMode>
				<UpdateApp />
			</StrictMode>
		)
	}
	else if (windowKind === 'about') {
		root.render(
			<StrictMode>
				<AboutApp />
			</StrictMode>
		)
	}
	else {
		// Auth keys are scoped per server, so the base URL must be known before first render.
		initBaseUrl().then(() => {
		bootAuth()
		root.render(
			<StrictMode>
				<DevModeProvider>
					<AudioMutedProvider>
					<HashRouter>
						<AuthGate>
							<Routes>
								<Route element={<AppLayout />}>
									<Route index element={<Home />} />
									<Route path="*" element={null} />
								</Route>
							</Routes>
							<StatusBar />
						</AuthGate>
						{!platform.capabilities.nativeWindows && <UpdateGate />}
					</HashRouter>
					</AudioMutedProvider>
				</DevModeProvider>
			</StrictMode>
		)
		})
	}
}
