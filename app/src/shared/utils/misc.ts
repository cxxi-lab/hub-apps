export function formatDuration(seconds: number | null): string {
	if (seconds === null) return '—'
	const h = Math.floor(seconds / 3600)
	const m = Math.floor((seconds % 3600) / 60)
	const s = seconds % 60
	const pad = (n: number) => String(n).padStart(2, '0')
	return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
}

export function formatDate(iso: string | null): string {
	if (!iso) return '—'
	return new Date(iso).toLocaleDateString()
}

export function enhanceEmbedUrl(url: string): string {
	try {
		const u = new URL(url)
		u.searchParams.set('hd', '1')
		return u.toString()
	}
	catch {
		return url
	}
}
