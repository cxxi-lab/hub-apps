type StoreChange = { key: string; oldValue: string | null; newValue: string | null }

const target = new EventTarget()

function emit(change: StoreChange): void {
	target.dispatchEvent(new CustomEvent('change', { detail: change }))
}

export function get<T = unknown>(key: string): T | null {
	const v = localStorage.getItem(key)
	if (v === null) return null
	return JSON.parse(v) as T
}

export function set(key: string, value: unknown): void {
	const oldValue = localStorage.getItem(key)
	const newValue = JSON.stringify(value)
	localStorage.setItem(key, newValue)
	emit({ key, oldValue, newValue })
}

export function remove(key: string): void {
	const oldValue = localStorage.getItem(key)
	localStorage.removeItem(key)
	emit({ key, oldValue, newValue: null })
}

export function onChange(cb: (change: StoreChange) => void): () => void {
	const handler = (e: Event) => cb((e as CustomEvent).detail)
	target.addEventListener('change', handler)
	return () => target.removeEventListener('change', handler)
}
