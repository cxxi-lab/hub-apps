/**
 * What goes in and out of a hubby's API, checked against its api.json (docs/plan-api-hubbies.md):
 * a subset of JSON Schema, the keywords below (hubby-cli refuses any other, so none is silently
 * ignored). Interpreted, no generated code (the app's CSP has no `unsafe-eval`).
 */

export const SCHEMA_KEYWORDS = [
	'type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const', 'anyOf',
	'minimum', 'maximum', 'minLength', 'maxLength', 'minItems', 'maxItems', 'pattern',
	'description', 'title', 'default', 'examples', 'format'
] as const

export type Schema = {
	type?: string | string[]
	properties?: Record<string, Schema>
	required?: string[]
	additionalProperties?: boolean | Schema
	items?: Schema
	enum?: unknown[]
	const?: unknown
	anyOf?: Schema[]
	minimum?: number
	maximum?: number
	minLength?: number
	maxLength?: number
	minItems?: number
	maxItems?: number
	pattern?: string
}

function typeOf(value: unknown): string {
	if (value === null) return 'null'
	if (Array.isArray(value)) return 'array'
	return typeof value
}

function fits(type: string, value: unknown): boolean {
	if (type === 'integer') return Number.isInteger(value)
	if (type === 'number') return typeof value === 'number' && Number.isFinite(value)
	return typeOf(value) === type
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/** The first thing the value gets wrong ("at.path: why"), null when it fits. */
export function validate(schema: Schema, value: unknown, at = '$'): string | null {
	if (schema.type !== undefined) {
		const types = Array.isArray(schema.type) ? schema.type : [schema.type]
		if (!types.some(t => fits(t, value))) return `${at}: expected ${types.join(' or ')}, got ${typeOf(value)}`
	}
	if (schema.enum && !schema.enum.some(v => same(v, value))) return `${at}: not one of the allowed values`
	if ('const' in schema && !same(schema.const, value)) return `${at}: not the expected value`
	if (schema.anyOf && !schema.anyOf.some(s => validate(s, value, at) === null)) return `${at}: fits none of its forms`
	if (typeof value === 'number') {
		if (schema.minimum !== undefined && value < schema.minimum) return `${at}: below ${schema.minimum}`
		if (schema.maximum !== undefined && value > schema.maximum) return `${at}: above ${schema.maximum}`
	}
	if (typeof value === 'string') {
		if (schema.minLength !== undefined && value.length < schema.minLength) return `${at}: shorter than ${schema.minLength}`
		if (schema.maxLength !== undefined && value.length > schema.maxLength) return `${at}: longer than ${schema.maxLength}`
		if (schema.pattern !== undefined && !new RegExp(schema.pattern, 'u').test(value)) return `${at}: does not match its pattern`
	}
	if (Array.isArray(value)) {
		if (schema.minItems !== undefined && value.length < schema.minItems) return `${at}: fewer than ${schema.minItems} items`
		if (schema.maxItems !== undefined && value.length > schema.maxItems) return `${at}: more than ${schema.maxItems} items`
		if (schema.items) {
			for (let i = 0; i < value.length; i++) {
				const error = validate(schema.items, value[i], `${at}[${i}]`)
				if (error) return error
			}
		}
	}
	if (typeOf(value) === 'object') {
		const object = value as Record<string, unknown>
		for (const key of schema.required ?? []) {
			if (!Object.hasOwn(object, key)) return `${at}.${key}: required`
		}
		for (const [key, item] of Object.entries(object)) {
			const own = schema.properties && Object.hasOwn(schema.properties, key) ? schema.properties[key] : undefined
			if (own) {
				const error = validate(own, item, `${at}.${key}`)
				if (error) return error
			}
			else if (schema.additionalProperties === false) return `${at}.${key}: not allowed`
			else if (typeof schema.additionalProperties === 'object') {
				const error = validate(schema.additionalProperties, item, `${at}.${key}`)
				if (error) return error
			}
		}
	}
	return null
}
