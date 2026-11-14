// Importing the commands registers them; consumers go through this entry point.
import './builtin'

export { listCommands, registerCommand, runCommand } from './registry'
export type { Command, CommandOutput, CommandResult } from './registry'
