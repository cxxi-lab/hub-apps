import { useEffect, useState } from 'react'
import type { VpnInfo } from '@platform'
import { platform } from '@platform'

const INITIAL: VpnInfo = {
	status: 'disabled',
	port: null,
	error: null,
	endpoint: null,
}

export function useVpnStatus(): VpnInfo {
	const [info, setInfo] = useState<VpnInfo>(INITIAL)

	useEffect(() => {
		platform.getVpnStatus().then(setInfo).catch(() => {})
		return platform.onVpnStatusChange(setInfo)
	}, [])

	return info
}
