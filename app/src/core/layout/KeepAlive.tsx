import { useEffect, useState, type ReactNode } from 'react'

interface Props {
	when: boolean
	children: ReactNode
}

export function KeepAlive({ when, children }: Props) {
	const [hasMatched, setHasMatched] = useState(when)

	useEffect(() => {
		if (when) setHasMatched(true)
	}, [when])

	if (!hasMatched) return null

	return (
		<div className={when ? 'contents' : 'hidden'}>
			{children}
		</div>
	)
}
