export interface UserMenuProps {
	onModules?: () => void
	onSettings?: () => void
	onLogout?: () => void | Promise<void>
}
