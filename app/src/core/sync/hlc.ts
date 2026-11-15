/**
 * A hybrid logical clock (docs/plan-local-first.md § 3.3): a total order of the writes across the
 * devices that a wrong system clock can't break — the wall time when it moves forward, a counter
 * when it doesn't (or goes back), and the device to break ties.
 *
 * A timestamp is a string that sorts as the clock does: `<wall ms, base 36, 9>-<counter, base 36,
 * 4>-<device>`. Comparing two is comparing the strings.
 */

/**
 * This clock never jumps further ahead of the system's than this, whatever it receives: a device
 * with a clock far in the future gets its operations applied (refusing them would split the
 * devices for good), but doesn't drag the others' clocks along.
 */
export const MAX_DRIFT_MS = 5 * 60 * 1000
const MAX_COUNTER = 36 ** 4 - 1

export interface Timestamp {
	wall: number
	counter: number
	device: string
}

export function format({ wall, counter, device }: Timestamp): string {
	return `${wall.toString(36).padStart(9, '0')}-${counter.toString(36).padStart(4, '0')}-${device}`
}

export function parse(value: string): Timestamp {
	const match = /^([0-9a-z]{9})-([0-9a-z]{4})-([0-9a-z]+)$/.exec(value)
	if (!match) throw new Error(`Not a timestamp: ${value}`)
	return { wall: parseInt(match[1], 36), counter: parseInt(match[2], 36), device: match[3] }
}

export class Clock {
	private last: Timestamp

	constructor(readonly device: string, private readonly now: () => number = Date.now, from?: string) {
		if (!/^[0-9a-z]+$/.test(device)) throw new Error('A device id is lowercase letters and digits')
		this.last = from ? { ...parse(from), device } : { wall: 0, counter: 0, device }
	}

	/** The timestamp of a write made here. */
	tick(): string {
		const now = this.now()
		this.last = now > this.last.wall
			? { wall: now, counter: 0, device: this.device }
			: this.bump(this.last.wall, this.last.counter)
		return format(this.last)
	}

	/**
	 * A timestamp received from another device: this clock moves past it, unless it is further
	 * ahead than MAX_DRIFT_MS (then returns false: a device's clock is wrong, worth a warning).
	 */
	receive(remote: string): boolean {
		const other = parse(remote)
		const now = this.now()
		if (other.wall - now > MAX_DRIFT_MS) return false
		const wall = Math.max(now, this.last.wall, other.wall)
		this.last = wall === this.last.wall && wall === other.wall ? this.bump(wall, Math.max(this.last.counter, other.counter))
			: wall === this.last.wall ? this.bump(wall, this.last.counter)
			: wall === other.wall ? this.bump(wall, other.counter)
			: { wall, counter: 0, device: this.device }
		return true
	}

	/** The last timestamp (to keep it across restarts). */
	current(): string {
		return format(this.last)
	}

	private bump(wall: number, counter: number): Timestamp {
		if (counter >= MAX_COUNTER) throw new Error('Too many writes in one millisecond')
		return { wall, counter: counter + 1, device: this.device }
	}
}
