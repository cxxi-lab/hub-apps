import { useEffect, useState, type ReactNode } from 'react'
import { useAmountsBlurred, useBlurEpoch } from '@core/privacy/hidden'

/**
 * An amount of a module (money, a balance…): blurred when the module's Privacy asks for it
 * (`supports: ['amounts']`), a click shows that one until it is clicked again, the page is left or
 * Ctrl+Alt+Q. Not for an amount being typed (a field): only shown ones.
 */
export function Amount({ module, children, className = '' }: { module: string, children: ReactNode, className?: string }) {
	const blurred = useAmountsBlurred(module)
	const epoch = useBlurEpoch()
	const [shown, setShown] = useState(false)

	useEffect(() => setShown(false), [epoch])

	if (!blurred) return <span className={className}>{children}</span>
	return (
		<span
			role="button"
			tabIndex={0}
			title={shown ? 'Hide the amount' : 'Show the amount'}
			onClick={e => { e.stopPropagation(); setShown(v => !v) }}
			onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setShown(v => !v) } }}
			className={`${className} cursor-pointer transition-[filter] ${shown ? '' : 'blur-[6px] select-none'}`}
		>
			{children}
		</span>
	)
}
