import { app } from 'electron'

import { applyMenu } from '../app/menu'
import { localEngine } from './engine'

/**
 * The local AI engine in the desktop (client docs/plan-ia-moteur.md): its state in the menu, and
 * never left running after the app quits (it holds the GPU's memory). Development only:
 * HUB_AI_ENGINE_SELFTEST=<a GGUF file> starts it at launch, asks it one question with and without
 * its token, and logs what happened ([ai:selftest]).
 */
export function setupLocalAi(): void {
	localEngine.on('status', () => applyMenu())
	app.on('will-quit', () => { void localEngine.stop(true) })
	const model = process.env.HUB_AI_ENGINE_SELFTEST
	if (model && !app.isPackaged) void selfTest(model)
}

async function selfTest(model: string): Promise<void> {
	const log = (...args: unknown[]) => console.log('[ai:selftest]', ...args)
	try {
		const started = Date.now()
		await localEngine.text(model)
		log(`on in ${Date.now() - started} ms`, localEngine.getInfo())
		const body = JSON.stringify({ messages: [{ role: 'user', content: 'Réponds en un mot : quelle est la capitale de la France ?' }], max_tokens: 16, temperature: 0, chat_template_kwargs: { enable_thinking: false } })
		const res = await localEngine.request('/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })
		const data = await res.json() as { choices?: Array<{ message?: { content?: string } }>, timings?: { predicted_per_second?: number } }
		log('with its token:', res.status, JSON.stringify(data.choices?.[0]?.message?.content), `${data.timings?.predicted_per_second?.toFixed(1)} t/s`)
		const url = (localEngine as unknown as { url: string }).url
		const bare = await fetch(`${url}/v1/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })
		log('without a token:', bare.status)
		log('waiting for the idle stop…')
	}
	catch (err) {
		log('failed:', err)
	}
}
