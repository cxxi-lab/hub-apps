import { execFile, spawnSync } from 'node:child_process'

import { getProfile } from './db'

// Optional GPU limits while the AI engine runs: sustained inference can make a laptop GPU
// drop off the bus (power spikes, heat). A clock cap and a power cap are applied when the
// engine starts and lifted when it stops. nvidia-smi needs root, so this relies on a sudoers
// rule allowing exactly these commands without a password (`sudo -n` never prompts).
const NVIDIA_SMI = '/usr/bin/nvidia-smi'

// Thermal governor: while the engine runs, the clock cap steps down as the GPU heats up
// (profile `gpuThermalSteps`) and back up once it has cooled this much below a step.
const THERMAL_POLL_MS = 5_000
const THERMAL_HYSTERESIS = 4
// Guard before each generation: above GUARD_TEMP it waits for the GPU to cool to RESUME_TEMP,
// at most GUARD_MAX_WAIT_MS (a reply should not be blocked forever).
const GUARD_TEMP = 87
const RESUME_TEMP = 82
const GUARD_MAX_WAIT_MS = 60_000

function run(args: string[]): void {
	execFile('sudo', ['-n', NVIDIA_SMI, ...args], (err, _stdout, stderr) => {
		if (err) console.warn('[companion:gpu] nvidia-smi', args.join(' '), 'failed:', stderr.trim() || err.message)
		else console.log('[companion:gpu] nvidia-smi', args.join(' '))
	})
}

function runSync(args: string[]): void {
	spawnSync('sudo', ['-n', NVIDIA_SMI, ...args], { timeout: 3_000 })
}

let governor: NodeJS.Timeout | null = null
let appliedLock: string | null = null

/** Current GPU temperature (reading it needs no root and puts no load on the GPU). */
function readTemperature(): Promise<number | null> {
	return new Promise(resolve => {
		execFile(NVIDIA_SMI, ['--query-gpu=temperature.gpu', '--format=csv,noheader,nounits'], { timeout: 3_000 }, (err, stdout) => {
			const temp = Number.parseInt(stdout, 10)
			resolve(err || Number.isNaN(temp) ? null : temp)
		})
	})
}

/**
 * Waits for a hot GPU to cool down before a generation starts (no-op below GUARD_TEMP or
 * when the temperature cannot be read).
 */
/** Waits for a hot GPU to cool down before a generation; resolves with the time waited (ms). */
export async function waitForCoolGpu(): Promise<number> {
	let temp = await readTemperature()
	if (temp === null || temp < GUARD_TEMP) return 0
	const started = Date.now()
	console.log(`[companion:gpu] ${temp} °C: waiting for the GPU to cool down before generating`)
	const deadline = Date.now() + GUARD_MAX_WAIT_MS
	while (temp !== null && temp >= RESUME_TEMP && Date.now() < deadline) {
		await new Promise(resolve => setTimeout(resolve, THERMAL_POLL_MS))
		temp = await readTemperature()
	}
	console.log(`[companion:gpu] ${temp ?? '?'} °C: generating${temp !== null && temp >= RESUME_TEMP ? ' (gave up waiting)' : ''}`)
	return Date.now() - started
}

function applyLock(lock: string): void {
	if (lock === appliedLock) return
	appliedLock = lock
	run(['-lgc', lock])
}

/**
 * Clock cap for `temp`: the base cap, or the step the temperature has reached. Stepping back
 * up waits until the GPU is THERMAL_HYSTERESIS degrees below the step, so it does not flap.
 */
export function thermalLock(temp: number, current: string, base: string, steps: { aboveTemp: number; clockLock: string }[]): string {
	const levels = [base, ...steps.map(s => s.clockLock)]
	let level = Math.max(0, levels.indexOf(current))
	while (level < steps.length && temp >= steps[level].aboveTemp) level++
	while (level > 0 && temp < steps[level - 1].aboveTemp - THERMAL_HYSTERESIS) level--
	return levels[level]
}

function startGovernor(base: string): void {
	stopGovernor()
	const steps = [...(getProfile().gpuThermalSteps ?? [])].sort((a, b) => a.aboveTemp - b.aboveTemp)
	if (steps.length === 0) return
	governor = setInterval(() => {
		void readTemperature().then(temp => {
			if (temp === null || !governor) return
			const lock = thermalLock(temp, appliedLock ?? base, base, steps)
			if (lock !== appliedLock) console.log(`[companion:gpu] ${temp} °C → clocks ${lock}`)
			applyLock(lock)
		})
	}, THERMAL_POLL_MS)
}

function stopGovernor(): void {
	if (governor) clearInterval(governor)
	governor = null
}

export function limitGpu(): void {
	const { gpuClockLock, gpuPowerLimit } = getProfile()
	if (gpuClockLock) {
		applyLock(gpuClockLock)
		startGovernor(gpuClockLock)
	}
	if (gpuPowerLimit) run(['-pl', String(gpuPowerLimit.watts)])
}

/** Gives the GPU its full clocks and power back (games, video…) once the engine is off. */
export function releaseGpu(sync = false): void {
	const { gpuClockLock, gpuPowerLimit } = getProfile()
	const exec = sync ? runSync : run
	stopGovernor()
	appliedLock = null
	if (gpuClockLock) exec(['-rgc'])
	if (gpuPowerLimit) exec(['-pl', String(gpuPowerLimit.restoreWatts)])
}
