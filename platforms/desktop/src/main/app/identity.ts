import { app } from 'electron'
import { join } from 'node:path'

/**
 * The app's name inside the system, imported before anything else (index.ts): hubbies read the data
 * folder as they load. The shipped app is `hub`, a development build `hub-dev`: its single-instance
 * lock (both run side by side) and the keyring entry protecting the data key. The name shown,
 * Hubbyware (productName), is another: changing this one would lose them.
 */
export const APP_NAME = app.isPackaged ? 'hub' : 'hub-dev'
app.setName(APP_NAME)

/**
 * Its data folder, set rather than derived from a name: the shipped app's has always been
 * ~/.config/hub-desktop (package.json's `name`, Electron's default before any setName; NOT
 * ~/.config/hub, an older folder of other things), its session, base, device secrets, VPN config.
 * A development build keeps its own (~/.config/hub-dev). The command line may give another
 * (--user-data-dir).
 */
const DATA_FOLDER = app.isPackaged ? 'hub-desktop' : 'hub-dev'
if (!app.commandLine.hasSwitch('user-data-dir')) app.setPath('userData', join(app.getPath('appData'), DATA_FOLDER))
