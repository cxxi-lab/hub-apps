import { open, seal } from '@core/crypto/format'
import type { Operation } from './replica'

/**
 * An operation as the relay holds it (docs/plan-local-first.md § 3.2): sealed whole on the device
 * with the data key, the module and the operation's id as associated data. The relay sees the
 * account, the module, the id, the size, nothing else.
 */
export interface Envelope {
	id: string
	module: string
	sealed: string
}

const where = (module: string, id: string) => `sync/${module}/${id}`

export function sealOperation(key: Uint8Array, module: string, op: Operation): Envelope {
	return { id: op.id, module, sealed: seal(key, where(module, op.id), JSON.stringify(op)) }
}

/**
 * An operation from the relay. `formerly`: the module's former ids — an operation sealed before it
 * was renamed (its log moved with it, app:modules:rename) opens under one of them.
 */
export function openOperation(key: Uint8Array, envelope: Envelope, formerly: string[] = []): Operation {
	let plain: string | null = null
	let failure: unknown = null
	for (const module of [envelope.module, ...formerly]) {
		try {
			plain = open(key, where(module, envelope.id), envelope.sealed)
			break
		}
		catch (err) {
			failure ??= err
		}
	}
	if (plain === null) throw failure
	const op = JSON.parse(plain) as Operation
	// the id outside is the one inside: an envelope can't carry another operation
	if (op.id !== envelope.id) throw new Error('An operation under another id')
	return op
}
