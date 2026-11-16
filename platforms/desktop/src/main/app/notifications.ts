import { ipcMain, Notification } from 'electron'

import type { SystemNotification } from '@hub/app/platform'
import { appIcon } from './icon'
import { setTrayDot } from './tray'
import { sendToMainWindow, showMainWindow } from '../windows/main'

/**
 * The app's notifications as system ones: a bubble from the desktop, and a dot on the tray icon
 * while there are some. The main window hands over the whole list each time it changes: a new one is
 * shown, one that grew is shown again with its new text, one gone (read, dismissed) is closed.
 * One that shrank keeps its bubble: showing it again would pop it up at each mail read.
 */

interface Shown {
	item: SystemNotification
	notification: Notification
}

const shown = new Map<number, Shown>()

function show(item: SystemNotification): Notification {
	const notification = new Notification({
		title: item.title,
		body: item.body ?? '',
		icon: appIcon.isEmpty() ? undefined : appIcon
	})
	notification.on('click', () => {
		showMainWindow()
		if (item.link) sendToMainWindow('system-notifications:open', item.link)
	})
	notification.show()
	return notification
}

function sync(items: SystemNotification[]): void {
	setTrayDot(items.length > 0)
	if (!Notification.isSupported()) return
	const ids = new Set(items.map(i => i.id))
	for (const [id, entry] of shown) {
		if (ids.has(id)) continue
		entry.notification.close()
		shown.delete(id)
	}
	for (const item of items) {
		const entry = shown.get(item.id)
		if (entry && (item.count ?? 1) <= (entry.item.count ?? 1)) {
			entry.item = item
			continue
		}
		entry?.notification.close()
		shown.set(item.id, { item, notification: show(item) })
	}
}

export function setupSystemNotifications(): void {
	ipcMain.on('system-notifications:sync', (_event, items: unknown) => {
		if (!Array.isArray(items)) return
		sync(items.filter((i): i is SystemNotification =>
			typeof i === 'object' && i !== null && typeof i.id === 'number' && typeof i.title === 'string'
		))
	})
}
