import { getApiBaseUrl } from './baseUrl'
import { resetAuthState } from '@core/auth/authState'
import { waitsForTunnel } from '@core/vpn/tunnel'
import { accountCaller, TunnelDownError, type Caller } from '@core/api/client'

export type StreamEventHandler = (event: string, data: unknown) => void

/**
 * Opens an authenticated server-sent event stream — over fetch, so it can POST a
 * body and carry the token — and resolves once the server closes it. Like api(),
 * a 401 renews the credentials once before giving up.
 */
export async function stream(caller: Caller, path: string, options: RequestInit, onEvent: StreamEventHandler, retry = true): Promise<void> {
	if (waitsForTunnel(path, caller.hubby)) throw new TunnelDownError()

	const headers = {
		'Content-Type': 'application/json',
		...options.headers,
		...await caller.headers(path)
	}

	const response = await fetch(`${getApiBaseUrl(path, caller.hubby)}${path}`, { ...options, headers })

	if (response.status === 423) caller.locked(path)

	if (response.status === 401) {
		if (retry && await caller.unauthorized()) {
			return stream(caller, path, options, onEvent, false)
		}
		if (!retry && caller === accountCaller) await resetAuthState()
		throw new Error('Unauthorized')
	}

	if (!response.ok || !response.body) {
		throw new Error(`HTTP ${response.status}`)
	}

	await readEventStream(response.body, onEvent)
}

/** A stream as the account (the app itself). */
export function apiStream(path: string, options: RequestInit, onEvent: StreamEventHandler, retry = true): Promise<void> {
	return stream(accountCaller, path, options, onEvent, retry)
}

/**
 * Parses a text/event-stream body, calling onEvent with each event name and its
 * JSON-decoded data. Comments, empty blocks and undecodable data are skipped.
 */
export async function readEventStream(body: ReadableStream<Uint8Array>, onEvent: StreamEventHandler): Promise<void> {
	const reader = body.getReader()
	const decoder = new TextDecoder()
	let buffer = ''

	while (true) {
		const { value, done } = await reader.read()
		if (done) return

		buffer += decoder.decode(value, { stream: true })

		let separatorIdx
		while ((separatorIdx = buffer.indexOf('\n\n')) !== -1) {
			const block = buffer.slice(0, separatorIdx)
			buffer = buffer.slice(separatorIdx + 2)

			if (!block.trim()) continue

			let eventName = 'message'
			let data = ''

			for (const line of block.split('\n')) {
				if (line.startsWith('event:')) {
					eventName = line.slice(6).trim()
				} else if (line.startsWith('data:')) {
					data += line.slice(5).trimStart()
				}
			}

			if (!data) continue

			let payload: unknown
			try {
				payload = JSON.parse(data)
			} catch {
				continue
			}

			onEvent(eventName, payload)
		}
	}
}
