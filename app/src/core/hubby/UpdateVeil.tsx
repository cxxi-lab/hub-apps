import { useEffect, useState } from 'react'
import { progressOf, type Updating } from './updates'

/**
 * A hubby updating, on its icon (as phones do): a dark veil over it, leaving clockwise from the top
 * as the update goes (a conic mask: the part done is clear). Its parent is `relative` and gives the
 * shape (rounded, clipped).
 */
export function UpdateVeil({ updating }: { updating: Updating }) {
	const [now, setNow] = useState(Date.now)
	useEffect(() => {
		let frame = 0
		const tick = () => { setNow(Date.now()); frame = requestAnimationFrame(tick) }
		frame = requestAnimationFrame(tick)
		return () => cancelAnimationFrame(frame)
	}, [])
	const angle = Math.round(progressOf(updating, now) * 360)
	const mask = `conic-gradient(from 0deg, transparent 0deg ${angle}deg, #000 ${angle}deg 360deg)`
	return (
		<span
			aria-label="Updating"
			role="progressbar"
			aria-valuenow={Math.round(angle / 3.6)}
			className="absolute inset-0 rounded-[inherit] bg-black/65 pointer-events-none"
			style={{ maskImage: mask, WebkitMaskImage: mask }}
		/>
	)
}
