import { useEffect, useRef } from 'react'
import { useBackHandler } from '@cxxi-lab/hubbyware-ui'
import { faXmark } from '@fortawesome/free-solid-svg-icons'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { inputProps, Output, useConsole } from './CommandConsole'
import { StatusItems } from './StatusBar'

/**
 * The phone's console (no status bar there): a sheet from the top, opened by a double tap on the
 * logo. The line, the output (it stays open after a command), and the background pieces' state
 * at the bottom. Kept mounted while closed, so the history stays.
 */
export function CommandSheet({ open, onClose }: { open: boolean, onClose: () => void }) {
	useBackHandler(open, onClose)
	const inputRef = useRef<HTMLInputElement>(null)
	const outputRef = useRef<HTMLDivElement>(null)
	const cmd = useConsole(() => inputRef.current?.focus())

	useEffect(() => {
		if (open) inputRef.current?.focus()
		else cmd.reset()
	}, [open])

	useEffect(() => {
		outputRef.current?.scrollTo({ top: outputRef.current.scrollHeight })
	}, [cmd.entries, open])

	if (!open) return null

	return (
		<div className="fixed inset-0 z-100 flex flex-col">
			<div className="flex flex-col max-h-[70vh] bg-steel-900 border-b border-steel-700 shadow-[0_8px_24px_rgba(0,0,0,0.6)] pt-[env(safe-area-inset-top)]">
				<div className="flex items-center gap-2 h-12 px-4 font-mono text-sm border-b border-steel-700">
					<span className="text-primary-500">&gt;</span>
					<input
						ref={inputRef}
						value={cmd.value}
						onChange={e => cmd.setValue(e.target.value)}
						onKeyDown={e => cmd.onKeyDown(e, onClose)}
						disabled={cmd.busy}
						enterKeyHint="send"
						{...inputProps}
						className="flex-1 min-w-0 bg-transparent border-0 outline-none text-steel-100 placeholder:text-steel-700 font-mono text-sm p-0"
					/>
					<button type="button" onClick={onClose} aria-label="Close" className="size-8 -mr-2 flex items-center justify-center bg-transparent border-0 text-steel-300 cursor-pointer">
						<FontAwesomeIcon icon={faXmark} />
					</button>
				</div>
				{cmd.entries.length > 0 && (
					<Output outputRef={outputRef} entries={cmd.entries} className="flex-1 min-h-0 px-4 py-3 text-xs" />
				)}
				<div className="flex items-center gap-3 min-h-8 px-4 py-2 font-mono text-[10px] text-steel-500 border-t border-steel-700">
					<StatusItems always />
				</div>
			</div>
			<button type="button" aria-label="Close console" onClick={onClose} className="flex-1 bg-black/50 border-0 cursor-default" />
		</div>
	)
}
