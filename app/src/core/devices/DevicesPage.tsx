import { DevicesList } from './DevicesList'

/** The devices signed in to the account: a page of its own, from the top bar's menu (like Modules). */
export function DevicesPage() {
	return (
		<div className="flex-1 min-h-0 overflow-y-auto">
			<div className="px-10 py-8 max-sm:px-4 max-sm:py-6 max-w-3xl">
				<h1 className="text-xl font-semibold text-white mb-6">Devices</h1>
				<DevicesList />
			</div>
		</div>
	)
}
