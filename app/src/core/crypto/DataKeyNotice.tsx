import { useState } from 'react'
import { platform } from '@platform'
import { useDataKey } from './dataKey'

/**
 * A device not linked yet (the account has a data key, this device doesn't): a reminder, until it
 * is linked or dismissed for this session.
 */
export function DataKeyNotice() {
	const key = useDataKey()
	const [dismissed, setDismissed] = useState(false)
	if (key.status !== 'missing' || dismissed) return null

	return (
		<div className="fixed bottom-20 sm:bottom-4 left-1/2 -translate-x-1/2 z-50 max-w-[calc(100vw-2rem)] flex items-center gap-3 px-4 py-2 rounded-md bg-steel-800 border border-amber-500/60 shadow-lg text-xs text-steel-100">
			<span>This device is not linked yet: your encrypted data can't be read here.</span>
			<button type="button" className="text-primary-400 hover:text-primary-300 font-semibold whitespace-nowrap" onClick={() => void platform.openSettings('security')}>Link it</button>
			<button type="button" className="text-steel-400 hover:text-white" aria-label="Dismiss" onClick={() => setDismissed(true)}>✕</button>
		</div>
	)
}
