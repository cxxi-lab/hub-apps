import { holdGpu, releaseGpu as release, type GpuLimits } from '../ai/gpu'
import { getProfile } from './db'

export { waitForCoolGpu } from '../ai/gpu'

/**
 * The companion's GPU limits (its profile: gpuClockLock, gpuThermalSteps, gpuPowerLimit), through
 * the shared governor (ai/gpu.ts): the engine and the companion never fight over the clocks.
 */
function limits(): GpuLimits {
	const { gpuClockLock, gpuThermalSteps, gpuPowerLimit } = getProfile()
	return { clockLock: gpuClockLock ?? null, steps: gpuThermalSteps ?? [], power: gpuPowerLimit ?? null }
}

export function limitGpu(): void {
	holdGpu('companion', limits())
}

/** Gives the GPU its full clocks and power back (games, video…) once the engine is off. */
export function releaseGpu(sync = false): void {
	release('companion', sync)
}
