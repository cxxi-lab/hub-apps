import { hideAll, reveal } from '@core/privacy/hidden'
import { MODULE_MANIFESTS } from '@core/module/registry'
import { registerCommand } from './registry'

registerCommand({
	name: 'reveal',
	usage: '<keys>',
	description: 'reveal the hidden modules these keys open (their shortcut, Ctrl+Alt + keys on a keyboard)',
	async run(args) {
		const keys = (args[0] ?? '').toLowerCase()
		if (!keys) return 'usage: /reveal <keys>'
		const ids = await reveal(keys)
		return ids.length ? 'revealed' : 'nothing'
	}
})

registerCommand({
	name: 'hide',
	usage: '',
	description: 'hide the revealed modules again (Ctrl+Alt+Q)',
	run() {
		hideAll()
		return 'hidden'
	}
})

registerCommand({
	name: 'settings',
	usage: '<module>',
	description: "open a module's settings, a hidden one's too (its Privacy: the shortcut, with the password)",
	run(args) {
		const id = (args[0] ?? '').toLowerCase()
		if (!id) return 'usage: /settings <module>'
		if (!MODULE_MANIFESTS.some(m => m.id === id)) return `no module "${id}"`
		window.location.hash = `#/modules/${id}`
		return `${id} settings`
	}
})
