import type { FieldSpec, ModelFile } from '@core/crypto/documents'

/**
 * A document checked against its model on the device, as the server does it for its collections
 * (server DocumentCodec::decode): a local-first module's writes are sealed whole for the relay, which
 * can't read them, so this is the only check they get. Same rules, same messages, and the values
 * as the server would give them back (a datetime as `…T…:…:….sssZ`, a decimal with its scale).
 * Encrypted fields are in clear here: checked like the others.
 */

export interface Violation { path: string, message: string }

export class InvalidDocument extends Error {
	constructor(readonly violations: Violation[]) {
		super(`The document is not valid: ${violations.map(v => `${v.path}: ${v.message}`).join('; ')}`)
	}
}

type Spec = FieldSpec & Record<string, unknown>

const FORMATS: Record<string, RegExp> = {
	// as PHP's FILTER_VALIDATE_EMAIL, near enough: local part, @, a dotted domain
	email: /^[^\s@"(),:;<>[\\\]]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i,
	url: /^https?:\/\/[^\s/$.?#][^\s]*$/i,
	uuid: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
	'hex-color': /^#[0-9a-f]{6}$/i,
}

/**
 * The fields of `input` checked and normalized. `partial` (an update): only the fields given;
 * otherwise defaults filled and required fields asked for. Throws InvalidDocument.
 */
export function decode(model: ModelFile, input: Record<string, unknown>, partial: boolean): Record<string, unknown> {
	const violations: Violation[] = []
	const out = decodeFields(model.fields as Record<string, Spec>, input, '', partial, violations)
	if (violations.length) throw new InvalidDocument(violations)
	return out
}

function decodeFields(fields: Record<string, Spec>, input: Record<string, unknown>, prefix: string, partial: boolean, violations: Violation[]): Record<string, unknown> {
	const out: Record<string, unknown> = {}
	for (const key of Object.keys(input)) {
		if (key === 'id' || key.startsWith('_')) continue
		if (!(key in fields)) violations.push({ path: prefix + key, message: 'Unknown field' })
	}
	for (const [name, field] of Object.entries(fields)) {
		const path = prefix + name
		if (!(name in input) || input[name] === undefined) {
			if (partial) continue
			if (field.default !== undefined) out[name] = decodeValue(field, field.default, path, violations)
			else if (field.required) violations.push({ path, message: 'Required' })
			continue
		}
		out[name] = decodeValue(field, input[name], path, violations)
	}
	return out
}

function decodeValue(field: Spec, value: unknown, path: string, violations: Violation[]): unknown {
	const fail = (message: string): null => {
		violations.push({ path, message })
		return null
	}
	if (value === null) return field.required ? fail('Required') : null
	const num = (key: string): number | undefined => typeof field[key] === 'number' ? field[key] as number : undefined

	switch (field.type) {
		case 'string':
		case 'text': {
			if (typeof value !== 'string') return fail('Must be a string')
			const length = [...value].length
			const max = num('max') ?? (field.type === 'text' ? 100000 : 255)
			if (length > max) return fail(`At most ${max} characters`)
			if (length < (num('min') ?? 0)) return fail(`At least ${num('min')} characters`)
			if (field.required && value.trim() === '') return fail('Required')
			if (typeof field.pattern === 'string' && value !== '' && !new RegExp(field.pattern, 'u').test(value)) return fail('Does not match the expected format')
			if (typeof field.format === 'string' && value !== '' && !FORMATS[field.format]?.test(value)) return fail(`Not a valid ${field.format}`)
			return value
		}
		case 'int': {
			if (typeof value !== 'number' || !Number.isInteger(value)) return fail('Must be an integer')
			const min = num('min'), max = num('max')
			if (min !== undefined && value < min) return fail(`At least ${min}`)
			if (max !== undefined && value > max) return fail(`At most ${max}`)
			return value
		}
		case 'decimal': {
			const text = typeof value === 'number' ? String(value) : value
			if (typeof text !== 'string' || !/^-?\d{1,26}(\.\d+)?$/.test(text)) return fail('Must be a decimal number ("12.50")')
			const scale = num('scale') ?? 2
			const decimals = text.includes('.') ? text.split('.')[1].length : 0
			if (decimals > scale) return fail(`At most ${scale} decimals`)
			const min = field.min, max = field.max
			if (min !== undefined && compareDecimals(text, String(min)) < 0) return fail(`At least ${min}`)
			if (max !== undefined && compareDecimals(text, String(max)) > 0) return fail(`At most ${max}`)
			return withScale(text, scale)
		}
		case 'bool':
			return typeof value === 'boolean' ? value : fail('Must be true or false')
		case 'date': {
			if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return fail('Must be a date (YYYY-MM-DD)')
			const d = new Date(`${value}T00:00:00Z`)
			return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value ? value : fail('Must be a date (YYYY-MM-DD)')
		}
		case 'datetime': {
			const d = typeof value === 'string' ? new Date(value) : null
			return d && !isNaN(d.getTime()) ? d.toISOString() : fail('Must be a date and time (ISO 8601)')
		}
		case 'enum': {
			const values = Array.isArray(field.values) ? field.values : []
			return values.includes(value) ? value : fail(`Must be one of: ${values.join(', ')}`)
		}
		case 'ref':
			return typeof value === 'string' && /^[0-9a-f-]{36}$/.test(value) ? value : fail('Must be the id of a document')
		case 'array': {
			if (!Array.isArray(value)) return fail('Must be a list')
			const max = num('maxItems') ?? 100
			if (value.length > max) return fail(`At most ${max} items`)
			const out: unknown[] = []
			value.forEach((item, i) => {
				if (item === null || item === undefined) violations.push({ path: `${path}[${i}]`, message: 'Must not be empty' })
				else out.push(decodeValue(field.items as Spec, item, `${path}[${i}]`, violations))
			})
			return out
		}
		case 'object':
			if (typeof value !== 'object' || Array.isArray(value)) return fail('Must be an object')
			return decodeFields((field.fields ?? {}) as Record<string, Spec>, value as Record<string, unknown>, `${path}.`, false, violations)
		case 'file': {
			const f = value as Record<string, unknown>
			if (typeof value !== 'object' || typeof f.id !== 'string' || typeof f.name !== 'string') return fail('Must be a file reference')
			return { id: f.id, name: [...f.name].slice(0, 255).join(''), type: String(f.type ?? ''), size: Number(f.size ?? 0) | 0 }
		}
	}
	return fail('Unknown type')
}

/** "12.5" → "12.50" (decode already refused more decimals than the scale). */
function withScale(value: string, scale: number): string {
	const negative = value.startsWith('-')
	const [whole, frac = ''] = value.replace(/^-/, '').split('.')
	const int = whole.replace(/^0+/, '') || '0'
	const out = scale > 0 ? `${int}.${frac.padEnd(scale, '0').slice(0, scale)}` : int
	return negative && out.replace(/[0.]/g, '') !== '' ? `-${out}` : out
}

/** -1, 0 or 1, on decimal strings of any size. */
function compareDecimals(a: string, b: string): number {
	const parts = (v: string) => {
		const [i, f = ''] = v.replace(/^-/, '').split('.')
		return { negative: v.startsWith('-'), int: i.replace(/^0+/, ''), frac: f }
	}
	const pa = parts(a), pb = parts(b)
	const width = Math.max(pa.frac.length, pb.frac.length)
	const ma = pa.int + pa.frac.padEnd(width, '0'), mb = pb.int + pb.frac.padEnd(width, '0')
	const sa = pa.negative && /[1-9]/.test(ma) ? -1 : 1
	const sb = pb.negative && /[1-9]/.test(mb) ? -1 : 1
	if (sa !== sb) return sa < sb ? -1 : 1
	const cmp = pa.int.length !== pb.int.length ? (pa.int.length < pb.int.length ? -1 : 1) : ma === mb ? 0 : ma < mb ? -1 : 1
	return sa * cmp
}
