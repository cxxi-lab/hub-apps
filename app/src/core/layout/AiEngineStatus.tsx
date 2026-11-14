import { useEffect, useRef, useState } from 'react'
import type { CompanionEngineInfo, CompanionEngineStatus } from '@platform'
import { platform } from '@platform'

const DOT_COLOR: Record<CompanionEngineStatus, string> = {
	on: 'bg-product-green shadow-[0_0_4px_rgba(63,185,80,0.6)]',
	starting: 'bg-product-yellow shadow-[0_0_4px_rgba(210,153,34,0.6)] animate-pulse',
	error: 'bg-red-500 shadow-[0_0_4px_rgba(229,72,77,0.6)]',
	off: 'bg-steel-700'
}

const STATUS_LABEL: Record<CompanionEngineStatus, string> = {
	on: 'Running',
	starting: 'Starting…',
	error: 'Error',
	off: 'Off'
}

/** Status-bar indicator of the local AI engine, with an on/off switch. */
export function AiEngineStatus() {
	const [engine, setEngine] = useState<CompanionEngineInfo>({ status: 'off', external: false, error: null })
	const [open, setOpen] = useState(false)
	const popoverRef = useRef<HTMLDivElement>(null)
	const triggerRef = useRef<HTMLButtonElement>(null)

	useEffect(() => {
		void platform.companion.getEngine().then(setEngine)
		return platform.companion.onEngineChange(setEngine)
	}, [])

	useEffect(() => {
		if (!open) return
		const onDocDown = (e: MouseEvent) => {
			const target = e.target as Node
			if (popoverRef.current?.contains(target) || triggerRef.current?.contains(target)) return
			setOpen(false)
		}
		document.addEventListener('mousedown', onDocDown)
		return () => document.removeEventListener('mousedown', onDocDown)
	}, [open])

	const running = engine.status === 'on' || engine.status === 'starting'

	return (
		<div className="relative">
			<button
				ref={triggerRef}
				type="button"
				onClick={() => setOpen(v => !v)}
				className="inline-flex items-center gap-1.5 text-steel-500 tracking-wide bg-transparent border-0 cursor-pointer hover:text-steel-300 transition px-1 py-0.5"
				title={`AI Engine: ${STATUS_LABEL[engine.status]}`}
			>
				AI
				<span className={`inline-block size-1.5 rounded-full -translate-y-px ${DOT_COLOR[engine.status]}`} />
			</button>

			{open && (
				<div
					ref={popoverRef}
					className="absolute bottom-full right-0 mb-2 w-[240px] bg-steel-900 border border-steel-700 rounded-md shadow-[0_4px_16px_rgba(0,0,0,0.6)] p-3 text-[10px] font-sans normal-case"
					onClick={e => e.stopPropagation()}
				>
					<div className="flex items-center justify-between">
						<span className="text-steel-300 uppercase tracking-wider text-[9px] font-bold">AI Engine</span>
						<span className="flex items-center gap-1.5">
							<span className={`inline-block size-2 rounded-full ${DOT_COLOR[engine.status]}`} />
							<span className="text-white">{STATUS_LABEL[engine.status]}</span>
						</span>
					</div>

					{engine.error && (
						<div className="mt-2 pt-2 border-t border-steel-700 text-red-300 break-words">{engine.error}</div>
					)}

					<div className="mt-3 flex justify-end">
						<button
							type="button"
							onClick={() => platform.companion.setEngine(!running)}
							disabled={engine.status === 'starting'}
							className="text-[9px] uppercase tracking-wider text-steel-300 hover:text-white bg-steel-800 hover:bg-steel-700 px-2 py-1 rounded border-0 cursor-pointer disabled:opacity-40 disabled:cursor-default"
						>
							{running ? 'Turn off' : 'Turn on'}
						</button>
					</div>
				</div>
			)}
		</div>
	)
}
