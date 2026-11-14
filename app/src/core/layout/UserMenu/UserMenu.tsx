import { faGear } from '@fortawesome/free-solid-svg-icons'
import { IconButton, Dropdown } from '@cxxi-lab/hub-ui'
import { type UserMenuProps } from './UserMenu.types'
import { styles } from './UserMenu.variants'
import { NotificationsMenu } from './NotificationsMenu'

export function UserMenu({ onModules, onSettings, onLogout }: UserMenuProps) {
	const userHeader = (isOpen: boolean) => (
		<IconButton
			size="xl"
			shape="circle"
			color="dark"
			active={isOpen}
			icon={faGear}
			aria-label="Menu"
		/>
	)

	return (
		<ul className={styles.container()}>
			<li>
				<NotificationsMenu />
			</li>

			<li>
				<Dropdown side="right" header={userHeader}>
					<div className={styles.menu()}>
						<div className={styles.section()}>
							{onModules && (
								<button type="button" onClick={onModules} className={styles.item()}>
									Modules
								</button>
							)}
							{onSettings && (
								<button type="button" onClick={onSettings} className={styles.item()}>
									Settings
								</button>
							)}
						</div>
						<div className={styles.section()}>
							{onLogout && (
								<button type="button" onClick={() => void onLogout()} className={styles.item()}>
									Log out
								</button>
							)}
						</div>
					</div>
				</Dropdown>
			</li>
		</ul>
	)
}
