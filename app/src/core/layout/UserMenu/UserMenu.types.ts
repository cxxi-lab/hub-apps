export interface UserMenuProps {
	onModules?: () => void
	onDevices?: () => void
	onSettings?: () => void
	onLogout?: () => void | Promise<void>
}
