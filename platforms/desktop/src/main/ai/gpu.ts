import { execFile, spawnSync } from 'node:child_process'

/**
 * The GPU's limits while local AI runs (the engine, the companion while it is still here): sustained
 * inference can make a laptop GPU drop off the bus (power spikes, heat). A clock cap (and a power
 * cap) is applied while anything holds the GPU, stepped down as it heats up, and lifted when the
 * last holder lets go. nvidia-smi needs root: this relies on a sudoers rule allowing exactly these
 * commands without a password (`sudo -n` never prompts; without the rule nothing is capped).
 * Measured on the benchmark (client docs/plan-ia-moteur.md § 3): 1500 MHz, 1200 above 83 °C, 900
 * above 87 °C — no drop-off.
 */

const NVIDIA_SMI = '/usr/bin/nvidia-smi'

// the thermal governor: the clock cap steps down as the GPU heats up, back up once it has cooled
// this much below a step
const THERMAL_POLL_MS = 5_000
const THERMAL_HYSTERESIS = 4
// before a generation: above GUARD_TEMP it waits for the GPU to cool to RESUME_TEMP, at most
// GUARD_MAX_WAIT_MS (a reply is never blocked for good)
const GUARD_TEMP = 87
const RESUME_TEMP = 82
const GUARD_MAX_WAIT_MS = 60_000

export interface ThermalStep { aboveTemp: number, clockLock: string }

export interface GpuLimits {
	/** `min,max` MHz (nvidia-smi -lgc), null: no clock cap */
	clockLock: string | null
	steps: ThermalStep[]
	/** a power cap while held, and the value given back (nvidia-smi -pl) */
	power: { watts: number, restoreWatts: number } | null
}

/** The engine's: what the benchmark ran with. */
export const DEFAULT_LIMITS: GpuLimits = {
	clockLock: '210,1500',
	steps: [{ aboveTemp: 83, clockLock: '210,1200' }, { aboveTemp: 87, clockLock: '210,900' }],
	power: null
}

function run(args: string[]): void {
	execFile('sudo', ['-n', NVIDIA_SMI, ...args], (err, _stdout, stderr) => {
		if (err) console.warn('[ai:gpu] nvidia-smi', args.join(' '), 'failed:', stderr.trim() || err.message)
		else console.log('[ai:gpu] nvidia-smi', args.join(' '))
	})
}

function runSync(args: string[]): void {
	spawnSync('sudo', ['-n', NVIDIA_SMI, ...args], { timeout: 3_000 })
}

/** The GPU's temperature (reading it needs no root and puts no load on the GPU), null: unknown. */
function readTemperature(): Promise<number | null> {
	return new Promise(resolve => {
		execFile(NVIDIA_SMI, ['--query-gpu=temperature.gpu', '--format=csv,noheader,nounits'], { timeout: 3_000 }, (err, stdout) => {
			const temp = Number.parseInt(stdout, 10)
			resolve(err || Number.isNaN(temp) ? null : temp)
		})
	})
}

/** Waits for a hot GPU to cool down before a generation; resolves with the time waited (ms). */
export async function waitForCoolGpu(): Promise<number> {
	let temp = await readTemperature()
	if (temp === null || temp < GUARD_TEMP) return 0
	const started = Date.now()
	console.log(`[ai:gpu] ${temp} °C: waiting for the GPU to cool down before generating`)
	const deadline = Date.now() + GUARD_MAX_WAIT_MS
	while (temp !== null && temp >= RESUME_TEMP && Date.now() < deadline) {
		await new Promise(resolve => setTimeout(resolve, THERMAL_POLL_MS))
		temp = await readTemperature()
	}
	console.log(`[ai:gpu] ${temp ?? '?'} °C: generating${temp !== null && temp >= RESUME_TEMP ? ' (gave up waiting)' : ''}`)
	return Date.now() - started
}

/**
 * The clock cap for `temp`: the base cap, or the step the temperature has reached. Stepping back
 * up waits until the GPU is THERMAL_HYSTERESIS degrees below the step, so it does not flap.
 */
export function thermalLock(temp: number, current: string, base: string, steps: ThermalStep[]): string {
	const levels = [base, ...steps.map(s => s.clockLock)]
	let level = Math.max(0, levels.indexOf(current))
	while (level < steps.length && temp >= steps[level].aboveTemp) level++
	while (level > 0 && temp < steps[level - 1].aboveTemp - THERMAL_HYSTERESIS) level--
	return levels[level]
}

// who holds the GPU, with their limits (the first holder's apply while it holds it)
const holders = new Map<string, GpuLimits>()
let active: GpuLimits | null = null
let activeOwner: string | null = null
let governor: NodeJS.Timeout | null = null
let appliedLock: string | null = null

function applyLock(lock: string): void {
	if (lock === appliedLock) return
	appliedLock = lock
	run(['-lgc', lock])
}

function apply(owner: string, limits: GpuLimits): void {
	active = limits
	activeOwner = owner
	if (limits.clockLock) {
		const base = limits.clockLock
		applyLock(base)
		const steps = [...limits.steps].sort((a, b) => a.aboveTemp - b.aboveTemp)
		if (steps.length) {
			governor = setInterval(() => {
				void readTemperature().then(temp => {
					if (temp === null || !governor) return
					const lock = thermalLock(temp, appliedLock ?? base, base, steps)
					if (lock !== appliedLock) console.log(`[ai:gpu] ${temp} °C → clocks ${lock}`)
					applyLock(lock)
				})
			}, THERMAL_POLL_MS)
		}
	}
	if (limits.power) run(['-pl', String(limits.power.watts)])
}

function lift(sync: boolean): void {
	const limits = active
	if (governor) clearInterval(governor)
	governor = null
	appliedLock = null
	active = null
	activeOwner = null
	if (!limits) return
	const exec = sync ? runSync : run
	if (limits.clockLock) exec(['-rgc'])
	if (limits.power) exec(['-pl', String(limits.power.restoreWatts)])
}

/** `owner` uses the GPU: its limits apply (unless another holder's already do). */
export function holdGpu(owner: string, limits: GpuLimits): void {
	holders.set(owner, limits)
	if (!active) apply(owner, limits)
}

/** `owner` is done with the GPU: its clocks come back once nothing holds it. */
export function releaseGpu(owner: string, sync = false): void {
	if (!holders.delete(owner)) return
	if (holders.size === 0) lift(sync)
	else if (owner === activeOwner) {
		// the limits applied were the leaving holder's: the next holder's apply
		lift(sync)
		const [next, limits] = holders.entries().next().value!
		apply(next, limits)
	}
}
