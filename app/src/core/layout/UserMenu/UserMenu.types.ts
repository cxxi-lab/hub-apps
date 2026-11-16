export interface UserMenuProps {
	onHubbies?: () => void
	onDevices?: () => void
	onSettings?: () => void
	onLogout?: () => void | Promise<void>
}
