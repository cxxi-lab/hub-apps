import { app } from 'electron'
import { join } from 'node:path'

/**
 * The app's name inside the system, imported before anything else (index.ts): modules read the data
 * folder as they load. The shipped app is `hub`, a development build `hub-dev`: its data folder
 * (~/.config/hub, ~/.config/hub-dev: session, local store, modules), its single-instance lock (both
 * run side by side), the keyring entry protecting the data key. The name shown, Hubbyware
 * (productName), is another: changing this one would lose them.
 */
export const APP_NAME = app.isPackaged ? 'hub' : 'hub-dev'
app.setName(APP_NAME)
// set, not derived from the product's name: its data where they have always been (unless the
// command line gives another folder, --user-data-dir)
if (!app.commandLine.hasSwitch('user-data-dir')) app.setPath('userData', join(app.getPath('appData'), APP_NAME))
