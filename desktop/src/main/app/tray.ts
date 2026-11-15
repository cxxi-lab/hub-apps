import { app, Menu, nativeImage, Tray } from 'electron'

import { appIcon, onIconChange } from './icon'
import { restartApp } from './restart'
import { engine } from '../companion/engine'
import { checkForUpdateNow, onUpdateFound, openPendingUpdate, pendingUpdateVersion } from '../network/updater'
import { hideMainWindow, isMainWindowVisible, showMainWindow } from '../windows/main'

// System tray icon, like Steam or Discord: closing the window keeps hub running in the
// background; the tray brings it back, and its menu is the way to really quit.
let tray: Tray | null = null

function buildMenu(): Menu {
	const status = engine.getInfo().status
	const update = pendingUpdateVersion()
	return Menu.buildFromTemplate([
		{ label: 'Open hub', click: () => showMainWindow() },
		update
			? { label: `Update to v${update}`, click: openPendingUpdate }
			: { label: 'Check for updates', click: () => void checkForUpdateNow() },
		{ type: 'separator' },
		{
			// Neutral label on purpose, same as the Window menu.
			label: status === 'starting' ? 'Toggle AI Engine (starting…)' : 'Toggle AI Engine',
			type: 'checkbox',
			checked: status === 'on' || status === 'starting',
			click: () => void (status === 'off' || status === 'error' ? engine.start() : engine.stop())
		},
		{ type: 'separator' },
		{ label: 'Restart hub', click: restartApp },
		{ label: 'Quit hub', click: () => app.quit() }
	])
}

export function refreshTray(): void {
	tray?.setContextMenu(buildMenu())
}

const TRAY_SIZE = process.platform === 'darwin' ? 16 : 22
// drawn larger than shown, so the dot's edge stays smooth once scaled down
const DRAW_SIZE = 64

function trayIcon(dot: boolean): Electron.NativeImage {
	if (appIcon.isEmpty()) return appIcon
	if (!dot) return appIcon.resize({ width: TRAY_SIZE, height: TRAY_SIZE })
	const base = appIcon.resize({ width: DRAW_SIZE, height: DRAW_SIZE, quality: 'best' })
	return withDot(base).resize({ width: TRAY_SIZE, height: TRAY_SIZE, quality: 'best' })
}

/** The icon with a red dot top right (like a chat app's unread mark). */
function withDot(image: Electron.NativeImage): Electron.NativeImage {
	const { width, height } = image.getSize()
	const pixels = Buffer.from(image.toBitmap()) // BGRA
	const r = width * 0.17
	const cx = width - r
	const cy = r
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			// coverage of this pixel by the disc, anti-aliased over one pixel
			const cover = Math.min(1, Math.max(0, r + 0.5 - Math.hypot(x + 0.5 - cx, y + 0.5 - cy)))
			if (cover === 0) continue
			const i = (y * width + x) * 4
			const a = pixels[i + 3] / 255
			const outA = cover + a * (1 - cover)
			const mix = (dot: number, c: number) => Math.round((dot * cover + c * a * (1 - cover)) / outA)
			pixels[i] = mix(0x45, pixels[i])     // B
			pixels[i + 1] = mix(0x42, pixels[i + 1]) // G
			pixels[i + 2] = mix(0xed, pixels[i + 2]) // R
			pixels[i + 3] = Math.round(outA * 255)
		}
	}
	return nativeImage.createFromBitmap(pixels, { width, height })
}

let dotShown = false

/** Marks the tray icon when the app has notifications. */
export function setTrayDot(dot: boolean): void {
	if (dot === dotShown) return
	dotShown = dot
	tray?.setImage(trayIcon(dot))
}

export function setupTray(): void {
	if (tray) return
	tray = new Tray(trayIcon(dotShown))
	// the icon in another accent colour: the tray's follows
	onIconChange(() => tray?.setImage(trayIcon(dotShown)))
	tray.setToolTip(app.getName())
	tray.setContextMenu(buildMenu())
	tray.on('click', () => (isMainWindowVisible() ? hideMainWindow() : showMainWindow()))
	engine.on('status', refreshTray)
	onUpdateFound(refreshTray)
}
