import { api } from '@core/api/client'
import { platform } from '@platform'

/**
 * This device's push registration (Android): its token goes to the server at each start, so the
 * server's changes reach the phone even with the app closed; it is withdrawn on sign-out.
 */

let registered: string | null = null

/** Registers this device for push (asks the permission to notify once). Without push: nothing. */
export async function registerPushDevice(): Promise<void> {
	const device = await platform.push?.register()
	if (!device) return
	try {
		await api('/api/hub/push/devices', { method: 'PUT', body: JSON.stringify(device) })
		registered = device.token
	}
	catch (err) {
		console.warn('[push] not registered', err)
	}
}

/** Stops the pushes to this device (sign-out), while still signed in. */
export async function forgetPushDevice(): Promise<void> {
	if (!registered) return
	const token = registered
	registered = null
	try {
		await api('/api/hub/push/devices', { method: 'DELETE', body: JSON.stringify({ token }) })
	}
	catch (err) {
		console.warn('[push] not withdrawn', err)
	}
}
