import { hideAll, reveal } from '@core/privacy/hidden'
import { HUBBY_MANIFESTS } from '@core/hubby/registry'
import { registerCommand } from './registry'

registerCommand({
	name: 'reveal',
	usage: '<keys>',
	description: 'reveal the hidden hubbies these keys open (their shortcut, Ctrl+Alt + keys on a keyboard)',
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
	description: 'hide the revealed hubbies again (Ctrl+Alt+Q)',
	run() {
		hideAll()
		return 'hidden'
	}
})

registerCommand({
	name: 'settings',
	usage: '<hubby>',
	description: "open a hubby's settings, a hidden one's too (its Privacy: the shortcut, with the password)",
	run(args) {
		const id = (args[0] ?? '').toLowerCase()
		if (!id) return 'usage: /settings <hubby>'
		if (!HUBBY_MANIFESTS.some(m => m.id === id)) return `no hubby "${id}"`
		window.location.hash = `#/hubbies/${id}`
		return `${id} settings`
	}
})

