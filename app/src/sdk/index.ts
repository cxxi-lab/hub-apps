/**
 * The hubby SDK (@cxxi-lab/hubbyware-sdk): everything a hubby (its own repository) may use from the app
 * around it. The app implements it here and provides it to the hubby bundles at run time
 * (@cxxi-lab/hubbyware-sdk/shared.json); the package publishes its types (packages/hubbyware-sdk/types,
 * scripts/emit-sdk-types.mjs).
 * A hubby imports its own files, this, the design system and npm packages, nothing else
 * (scripts/check-boundaries.mjs checks it). What is not here is the app's own business: to give
 * hubbies something more, export it here on purpose, as part of the contract they build on (then
 * regenerate the types: npm run types:sdk -w @hub/app).
 */

// The hubby contract: its manifest, and what hubbies offer each other (contributions)
export type { HubbyManifest, HubbyNavItem, HubbyRoute, HubbyWindow } from '@core/hubby/types'
export { describe, type HubbyInfo } from '@core/hubby/describe'
export type { Contribution, ContributionPoint, ContributionPoints, TimelineContribution } from '@core/hubby/contributions'
export type { TimelineItem, TimelineItemsProvider, TimelineDetailRenderer } from '@core/hubby/capabilities/timeline'
export { useContributions } from '@core/contexts/HubbiesContext'
export { useAmountsBlurred, useHubbyVisible, usePrivateMode } from '@core/privacy/hidden'
export { Amount } from '@core/privacy/Amount'

// The server API (authenticated)
export { api, ApiError, errorMessage } from '@core/api/client'
export { getApiBaseUrl } from '@core/api/baseUrl'
export { apiStream, readEventStream, type StreamEventHandler } from '@core/api/stream'
export { fetchSettings, updateSettings } from '@core/api/settings'
export type { ListResponse, PaginatedResponse, SingleResponse } from '@shared/apiResponse'

// The host (desktop or phone shell) and its native capabilities
export { platform } from '@platform'
export type {
	CompanionActivity, CompanionEngineInfo, CompanionLogEntry, CompanionMessage, CompanionProfile,
	NativeIcon, NativePlayerAction, VpnInfo, VpnStatus
} from '@platform'

// The web socle: sites' integrations (cookies and referer rules applied before a site loads) and
// their embedded players (scripts per site, ad/tracker blocklist)
export { ensureIntegrationForUrl, isIntegrationKnownSync } from '@shared/web/integrations'
export { getPlayerConfig, type PlayerConfig, type PlayerScripts } from '@shared/web/players'
export { syncPlayerBlocklist } from '@shared/web/playerBlocklist'

// UI kit (@cxxi-lab/hubbyware-ui: a hubby may also import the design system directly)
export {
	Button, IconButton, Checkbox, ChoiceSwitch, Form, InputField, Switch, Dropdown, ConfirmationModal, Modal,
	Table, TableCell, TableHead, TableHeadGroup, TableRow, TableRowGroup, type FormData
} from '@cxxi-lab/hubbyware-ui'

// Helpers
export { useMediaQuery, useBackHandler } from '@cxxi-lab/hubbyware-ui'
export { BottomBar, type BottomBarEntry, type BottomBarTab } from '@core/layout/BottomBar'
export { collection, type BatchOperation, type CollectionPage, type CollectionQuery, type FilterValue, type HubbyDocument } from '@core/hubby/collections'
export { useVpnStatus } from '@shared/hooks/useVpnStatus'
export { formatDate, formatDuration } from '@shared/utils'
