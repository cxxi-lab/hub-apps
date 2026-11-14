import { api } from './client'

export function fetchSettings<T = Record<string, unknown>>(scope: string) {
	return api<{ data: T }>(`/api/hub/settings/${scope}`).then(r => r.data)
}

export function updateSettings<T = Record<string, unknown>>(scope: string, values: Partial<T>) {
	return api<{ data: T }>(`/api/hub/settings/${scope}`, {
		method: 'PATCH',
		body: JSON.stringify(values),
	}).then(r => r.data)
}
