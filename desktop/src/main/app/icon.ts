import { app, nativeImage } from 'electron'
import { existsSync, readdirSync } from 'fs'
import { join } from 'path'

function buildAppIcon(): Electron.NativeImage {
	const iconsDir = app.isPackaged
		? join(process.resourcesPath, 'icons')
		: join(__dirname, '..', '..', 'resources', 'icons')

	const icon = nativeImage.createEmpty()

	if (!existsSync(iconsDir)) {
		console.warn('[icon] directory not found:', iconsDir)
		return icon
	}

	const files = readdirSync(iconsDir)
		.map(name => ({ name, match: /^(\d+)x\d+\.png$/i.exec(name) }))
		.filter((f): f is { name: string; match: RegExpExecArray } => f.match !== null)
		.map(f => ({ name: f.name, size: Number(f.match[1]) }))
		.sort((a, b) => a.size - b.size)

	for (const { name, size } of files) {
		const rep = nativeImage.createFromPath(join(iconsDir, name))
		if (rep.isEmpty()) continue
		icon.addRepresentation({
			scaleFactor: 1,
			width: size,
			height: size,
			buffer: rep.toPNG()
		})
	}

	if (icon.isEmpty()) {
		console.warn('[icon] no representations loaded from', iconsDir)
	}

	return icon
}

export const appIcon = buildAppIcon()
