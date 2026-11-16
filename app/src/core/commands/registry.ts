/**
 * Commands typed in the status bar console. Core and hubbies register theirs
 * with registerCommand(); the console only parses the line and prints what a
 * command returns.
 */

export type CommandOutput = string | string[] | void

export interface Command {
	/** what is typed (with or without a leading "/"), lowercase, no spaces */
	name: string
	/** one line shown by `help` */
	description: string
	/** argument hint shown by `help`, e.g. "<id>" */
	usage?: string
	run(args: string[]): CommandOutput | Promise<CommandOutput>
}

export interface CommandResult {
	lines: string[]
	error: boolean
}

const commands = new Map<string, Command>()

export function registerCommand(command: Command): void {
	if (commands.has(command.name)) {
		console.warn(`[commands] "${command.name}" registered twice; keeping the last one`)
	}
	commands.set(command.name, command)
}

export function listCommands(): Command[] {
	return [...commands.values()].sort((a, b) => a.name.localeCompare(b.name))
}

/** Runs one console line ("name arg1 arg2…"). Never throws: failures come back as error lines. */
export async function runCommand(line: string): Promise<CommandResult> {
	const [word, ...args] = line.trim().split(/\s+/)
	const name = word.replace(/^\//, '').toLowerCase()
	if (!name) return { lines: [], error: false }
	const command = commands.get(name)
	if (!command) return { lines: [`unknown command: ${word} (type /help)`], error: true }
	try {
		const out = await command.run(args)
		return { lines: out === undefined ? [] : Array.isArray(out) ? out : [out], error: false }
	}
	catch (err) {
		return { lines: [err instanceof Error ? err.message : String(err)], error: true }
	}
}

registerCommand({
	name: 'help',
	description: 'list the available commands',
	run: () => listCommands().map(c => `/${c.name}${c.usage ? ' ' + c.usage : ''} — ${c.description}`)
})
