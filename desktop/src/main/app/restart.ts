import { app } from 'electron'
import { spawn } from 'node:child_process'

/** Marks an instance started by "Restart hub": it waits for the previous one to quit. */
export const RELAUNCH_FLAG = '--relaunched'

const LOCK_POLL_MS = 250
const LOCK_WAIT_MS = 30_000

/**
 * Quits and starts hub again. The AppImage is spawned directly, like electron-updater does:
 * app.relaunch() goes through a helper living in the old AppImage mount, gone once it quits
 * ("Cannot mount AppImage").
 */
export function restartApp(): void {
	const args = [...process.argv.slice(1).filter(a => a !== RELAUNCH_FLAG), RELAUNCH_FLAG]
	const appImage = process.env.APPIMAGE
	if (appImage) spawn(appImage, args, { detached: true, stdio: 'ignore' }).unref()
	else app.relaunch({ args })
	app.quit()
}

/**
 * Single-instance lock. A relaunched instance starts while the previous one is still
 * shutting down (engine, services): it waits for the lock instead of giving up.
 */
export function acquireSingleInstanceLock(): Promise<boolean> {
	if (app.requestSingleInstanceLock()) return Promise.resolve(true)
	if (!process.argv.includes(RELAUNCH_FLAG)) return Promise.resolve(false)
	const deadline = Date.now() + LOCK_WAIT_MS
	return new Promise(resolve => {
		const timer = setInterval(() => {
			if (app.requestSingleInstanceLock()) {
				clearInterval(timer)
				resolve(true)
			}
			else if (Date.now() > deadline) {
				clearInterval(timer)
				resolve(false)
			}
		}, LOCK_POLL_MS)
	})
}
