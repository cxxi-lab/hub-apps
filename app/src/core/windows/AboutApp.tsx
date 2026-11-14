import { useEffect, useState } from 'react'
import { platform } from '@platform'

const PLATFORM_LABEL: Record<string, string> = {
	linux: 'Linux',
	darwin: 'macOS',
	win32: 'Windows',
}

export function AboutApp() {
	const { os, versions } = platform.runtime
	const [appVersion, setAppVersion] = useState<string>('—')
	const [devMode, setDevMode] = useState(false)

	useEffect(() => {
		platform.getAppVersion().then(setAppVersion).catch(() => {})
		platform.getDevMode().then(setDevMode).catch(() => {})
		return platform.onDevModeChange(setDevMode)
	}, [])

	const rows: Array<[string, React.ReactNode]> = [
		['App', `v${appVersion}`],
		['Mode', devMode
			? <span className="text-product-orange uppercase">Developer</span>
			: <span className="text-product-green uppercase">Production</span>
		],
		['OS', PLATFORM_LABEL[os] ?? os],
		['Electron', `v${versions.electron}`],
		['Chrome', `v${versions.chrome}`],
		['Node', `v${versions.node}`],
	]

	return (
		<div className="flex flex-col h-screen bg-steel-950 text-steel-100 p-6">
			<h1 className="text-xl font-semibold text-white mb-5">hub</h1>

			<dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
				{rows.map(([label, value]) => (
					<div key={label} className="contents">
						<dt className="text-steel-300 font-mono text-xs uppercase tracking-wider self-center">{label}</dt>
						<dd className="text-white font-mono m-0">{value}</dd>
					</div>
				))}
			</dl>
		</div>
	)
}
