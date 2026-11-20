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

// The local AI engine on a phone (client docs/plan-ia-android.md, phase 1): the native self-test,
// on models pushed by adb into the app's files (Android/data/cxxi.hub/files/ai-test/)
registerCommand({
	name: 'ai-selftest',
	usage: 'text | voice | stop',
	description: 'try the phone\'s AI engine on the models in ai-test/ (Android, development)',
	async run(args) {
		const plugin = (window as unknown as { Capacitor?: { Plugins?: Record<string, { selfTest?(o: object): Promise<object>, stop?(): Promise<void> }> } }).Capacitor?.Plugins?.LocalAi
		if (!plugin?.selfTest) return 'no local AI engine here (Android only)'
		const what = (args[0] ?? 'text').toLowerCase()
		if (what === 'stop') { await plugin.stop?.(); return 'stopped' }
		try {
			const result = what === 'voice'
				? await plugin.selfTest({ engine: 'voice', talker: 'qwen-talker-1.7b-base-Q4_K_M.gguf', codec: 'qwen-tokenizer-12hz-Q8_0.gguf', sample: 'normal.wav', text: 'Coucou toi, tu m\'as manqué aujourd\'hui.' })
				: await plugin.selfTest({ engine: 'text', model: 'TheDrummer_Fallen-Gemma3-4B-v1-Q4_K_M.gguf', prompt: args.slice(1).join(' ') || 'Dis bonjour en une phrase, comme dans un SMS.' })
			console.log('[ai-selftest]', JSON.stringify(result))
			return JSON.stringify(result)
		}
		catch (err) {
			return `failed: ${err instanceof Error ? err.message : String(err)}`
		}
	}
})
