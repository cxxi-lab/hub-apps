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

export function openOperation(key: Uint8Array, envelope: Envelope): Operation {
	const op = JSON.parse(open(key, where(envelope.module, envelope.id), envelope.sealed)) as Operation
	// the id outside is the one inside: an envelope can't carry another operation
	if (op.id !== envelope.id) throw new Error('An operation under another id')
	return op
}
