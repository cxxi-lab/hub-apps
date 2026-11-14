import { tv } from 'tailwind-variants'

export const styles = {
	container: tv({ base: 'flex items-center gap-3' }),
	menu: tv({ base: 'flex flex-col w-[200px] [&>*:not(:first-child)]:border-t [&>*:not(:first-child)]:border-steel-700' }),
	section: tv({ base: 'flex flex-col py-2' }),
	item: tv({
		base: [
			'block w-full text-left flex-1 px-6 py-2 text-sm',
			'cursor-pointer hover:text-primary-500',
			'bg-transparent border-0'
		]
	}),
	empty: tv({ base: 'px-5 py-4 text-sm text-steel-300 text-center' })
}
