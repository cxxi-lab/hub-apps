import { getApiBaseUrl } from './baseUrl'
import { lockedByServer, unlockHeaders } from '@core/privacy/locks'
import { getAuthData, resetAuthState } from '@core/auth/authState'
import { tryRefreshToken } from '@core/auth/refresh'
import { waitsForTunnel } from '@core/vpn/tunnel'
import { TunnelDownError } from '@core/api/client'

export type StreamEventHandler = (event: string, data: unknown) => void

/**
 * Opens an authenticated server-sent event stream — over fetch, so it can POST a
 * body and carry the token — and resolves once the server closes it. Like api(),
 * a 401 refreshes the token once before giving up.
 */
export async function apiStream(path: string, options: RequestInit, onEvent: StreamEventHandler, retry = true): Promise<void> {
	if (waitsForTunnel(path)) throw new TunnelDownError()
	const { token } = await getAuthData()

	const headers = {
		'Content-Type': 'application/json',
		...options.headers,
		...unlockHeaders(path),
		...(token ? { Authorization: `Bearer ${token}` } : {})
	}

	const response = await fetch(`${getApiBaseUrl(path)}${path}`, { ...options, headers })

	if (response.status === 423) lockedByServer(path)

	if (response.status === 401) {
		if (retry && await tryRefreshToken()) {
			return apiStream(path, options, onEvent, false)
		}
		await resetAuthState()
		throw new Error('Unauthorized')
	}

	if (!response.ok || !response.body) {
		throw new Error(`HTTP ${response.status}`)
	}

	await readEventStream(response.body, onEvent)
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
