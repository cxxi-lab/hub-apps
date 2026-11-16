import { useEffect, useRef, useState, type KeyboardEvent, type RefObject } from 'react'
import { useBackHandler } from '@cxxi-lab/hubbyware-ui'
import { faTerminal } from '@fortawesome/free-solid-svg-icons'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { runCommand } from '@core/commands'

export interface Entry {
	id: number
	command: string
	lines: string[]
	error: boolean
}

const MAX_ENTRIES = 50
/** how long the last result stays above the bar once the console closed */
const FLASH_MS = 6000

/**
 * A console's line, its history (↑/↓) and its output: Enter runs the line through the command
 * registry, then `onRun` (with the entry); `/clear` empties the output.
 */
export function useConsole(onRun: (entry: Entry | null) => void) {
	const [value, setValue] = useState('')
	const [entries, setEntries] = useState<Entry[]>([])
	const [busy, setBusy] = useState(false)
	const history = useRef<string[]>([])
	const historyIndex = useRef(-1)
	const nextId = useRef(0)

	const reset = () => {
		setValue('')
		historyIndex.current = -1
	}

	const submit = async () => {
		const line = value.trim()
		reset()
		if (!line) return
		// a reveal shortcut is never kept nor shown (history, output)
		const shown = line.replace(/^(\/?reveal\s+)\S+/i, '$1••••')
		history.current = [shown, ...history.current.filter(h => h !== shown)].slice(0, MAX_ENTRIES)
		if (line.replace(/^\//, '') === 'clear') {
			setEntries([])
			onRun(null)
			return
		}
		setBusy(true)
		try {
			const entry = { id: nextId.current++, command: shown, ...(await runCommand(line)) }
			setEntries(prev => [...prev, entry].slice(-MAX_ENTRIES))
			onRun(entry)
		}
		finally {
			setBusy(false)
		}
	}

	/** Enter, ↑/↓; Escape calls `onEscape`. */
	const onKeyDown = (e: KeyboardEvent<HTMLInputElement>, onEscape: () => void) => {
		if (e.key === 'Enter') {
			e.preventDefault()
			void submit()
		}
		else if (e.key === 'Escape') {
			e.preventDefault()
			onEscape()
		}
		else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
			e.preventDefault()
			const step = e.key === 'ArrowUp' ? 1 : -1
			const index = Math.max(-1, Math.min(history.current.length - 1, historyIndex.current + step))
			historyIndex.current = index
			setValue(index === -1 ? '' : history.current[index])
		}
	}

	return { value, setValue, entries, busy, reset, onKeyDown }
}

export function Output({ entries, outputRef, className }: { entries: Entry[], outputRef?: RefObject<HTMLDivElement | null>, className: string }) {
	return (
		<div ref={outputRef} className={`overflow-y-auto font-mono leading-relaxed select-text ${className}`}>
			{entries.map(entry => (
				<div key={entry.id} className="mb-1.5 last:mb-0">
					<div className="text-steel-300"><span className="text-primary-500">&gt;</span> {entry.command}</div>
					{entry.lines.map((l, i) => (
						<div key={i} className={`whitespace-pre-wrap break-words ${entry.error ? 'text-red-300' : 'text-steel-100'}`}>{l}</div>
					))}
				</div>
			))}
		</div>
	)
}

export const inputProps = {
	spellCheck: false,
	autoCapitalize: 'off',
	autoComplete: 'off',
	autoCorrect: 'off',
	placeholder: 'type /help'
} as const

/**
 * Status-bar console: the >_ button opens an input in the bar; Enter runs the
 * line through the command registry and closes the console, the result
 * staying briefly above the bar (until a tap elsewhere or FLASH_MS). Reopening
 * shows the whole output history. Escape closes, ↑/↓ walk the history,
 * `/clear` empties it.
 */
export function CommandConsole() {
	const [open, setOpen] = useState(false)
	useBackHandler(open, () => setOpen(false))
	const [flash, setFlash] = useState<Entry | null>(null)
	const inputRef = useRef<HTMLInputElement>(null)
	const outputRef = useRef<HTMLDivElement>(null)
	const cmd = useConsole(entry => {
		setFlash(entry)
		close()
	})

	useEffect(() => {
		if (open) inputRef.current?.focus()
	}, [open])

	useEffect(() => {
		outputRef.current?.scrollTo({ top: outputRef.current.scrollHeight })
	}, [cmd.entries, open])

	useEffect(() => {
		if (!flash) return
		const timer = setTimeout(() => setFlash(null), FLASH_MS)
		const dismiss = () => setFlash(null)
		document.addEventListener('pointerdown', dismiss)
		return () => {
			clearTimeout(timer)
			document.removeEventListener('pointerdown', dismiss)
		}
	}, [flash])

	const openConsole = () => {
		setFlash(null)
		setOpen(true)
	}

	function close() {
		setOpen(false)
		cmd.reset()
	}

	return (
		<div className="relative flex items-center gap-2 min-w-0 flex-1">
			<button
				type="button"
				onClick={() => (open ? close() : openConsole())}
				className={`inline-flex items-center bg-transparent border-0 cursor-pointer transition px-1 py-0.5 ${open ? 'text-primary-500' : 'text-steel-500 hover:text-steel-300'}`}
				title="Console"
				aria-label="Console"
			>
				<FontAwesomeIcon icon={faTerminal} className="text-[10px]" />
			</button>

			{open && (
				<>
					<span className="text-primary-500">&gt;</span>
					<input
						ref={inputRef}
						value={cmd.value}
						onChange={e => cmd.setValue(e.target.value)}
						onKeyDown={e => cmd.onKeyDown(e, close)}
						disabled={cmd.busy}
						{...inputProps}
						className="flex-1 min-w-0 max-w-[360px] bg-transparent border-0 outline-none text-steel-100 placeholder:text-steel-700 font-mono text-[10px] p-0"
					/>
				</>
			)}

			{((open && cmd.entries.length > 0) || (!open && flash)) && (
				<Output
					outputRef={outputRef}
					entries={open ? cmd.entries : flash ? [flash] : []}
					className="absolute bottom-full left-0 mb-2 w-[min(480px,calc(100vw-24px))] max-h-[40vh] bg-steel-900 border border-steel-700 rounded-md shadow-[0_4px_16px_rgba(0,0,0,0.6)] p-2 text-[10px]"
				/>
			)}
		</div>
	)
}
