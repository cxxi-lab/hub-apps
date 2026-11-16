/** Plain x.y.z versions and the ranges hubbies declare (^x.y.z, or an exact x.y.z, or several joined by ||). */

function parts(version: string): [number, number, number] {
	const [major = 0, minor = 0, patch = 0] = version.split('.').map(n => Number.parseInt(n, 10) || 0)
	return [major, minor, patch]
}

export function compareVersions(a: string, b: string): number {
	const [x, y] = [parts(a), parts(b)]
	return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]
}

function satisfiesOne(version: string, range: string): boolean {
	if (!range.startsWith('^')) return compareVersions(version, range) === 0
	const base = range.slice(1)
	const [major, minor] = parts(base)
	const [vMajor, vMinor] = parts(version)
	if (compareVersions(version, base) < 0) return false
	return major > 0 ? vMajor === major : vMajor === 0 && vMinor === minor
}

/** Whether `version` is in `range`: ^1.2.3 = >=1.2.3 <2.0.0 (^0.2.3 = >=0.2.3 <0.3.0), else exact; alternatives joined by `||`. */
export function satisfies(version: string, range: string): boolean {
	// alternatives (`^1.12.0 || ^2.0.0`): a hubby running on two majors of the SDK
	return range.split('||').some(part => satisfiesOne(version, part.trim()))
}

/**
 * Whether the SDK this app provides fits a hubby's range: its version, or one of the former ones it
 * still serves (version.json `compatible`: an SDK keeping a former major's names at run time).
 */
export function fits(sdk: { version: string, compatible?: string[] }, range: string): boolean {
	return [sdk.version, ...(sdk.compatible ?? [])].some(version => satisfies(version, range))
}
