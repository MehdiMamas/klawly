/*
 * Tailwind config for the Klawly design prototype.
 *
 * Every page loads the Tailwind Play CDN and then this file, so you can use
 * Tailwind classes straight in the HTML with no build step. The names below
 * point at the CSS variables in global.css, so they follow the dark/light theme:
 *
 *   bg-chrome  bg-surface  bg-raised  bg-fill-1..5  bg-hover  bg-active
 *   text-ink  text-ink-2  text-muted  text-faint  text-teal  text-indigo ...
 *   border-line  border-line-strong  border-line-faint
 *   rounded-xs/sm/md/lg/xl (3/4/6/8/12px)   text-2xs/xs/sm/md/chat/lg/xl/2xl
 *
 * Change a color in global.css (:root for dark, [data-theme="light"] for
 * light) and every utility that uses it changes too.
 */
tailwind.config = {
	darkMode: ['selector', '[data-theme="dark"]'],
	corePlugins: {
		preflight: false // global.css has its own reset
	},
	theme: {
		extend: {
			colors: {
				chrome: 'var(--k-chrome)',
				surface: 'var(--k-surface)',
				raised: 'var(--k-raised)',
				'code-bg': 'var(--k-code-bg)',
				input: 'var(--k-input)',

				ink: 'var(--k-ink)',
				'ink-2': 'var(--k-ink-2)',
				muted: 'var(--k-muted)',
				faint: 'var(--k-faint)',

				'fill-1': 'var(--k-fill-1)',
				'fill-2': 'var(--k-fill-2)',
				'fill-3': 'var(--k-fill-3)',
				'fill-4': 'var(--k-fill-4)',
				'fill-5': 'var(--k-fill-5)',
				hover: 'var(--k-hover)',
				active: 'var(--k-active)',

				line: 'var(--k-line)',
				'line-strong': 'var(--k-line-strong)',
				'line-faint': 'var(--k-line-faint)',
				'line-solid': 'var(--k-line-solid)',

				teal: 'var(--k-teal)',
				indigo: 'var(--k-indigo)',
				'indigo-hover': 'var(--k-indigo-hover)',
				'on-accent': 'var(--k-on-accent)',
				link: 'var(--k-link)',
				focus: 'var(--k-focus)',

				green: 'var(--k-green)',
				red: 'var(--k-red)',
				amber: 'var(--k-amber)',
				purple: 'var(--k-purple)',
				'git-added': 'var(--k-git-added)',
				'git-modified': 'var(--k-git-modified)',
				'git-deleted': 'var(--k-git-deleted)',

				'mode-plan': 'var(--k-mode-plan)',
				'mode-plan-solid': 'var(--k-mode-plan-solid)',
				'mode-ask': 'var(--k-mode-ask)',
				'mode-ask-solid': 'var(--k-mode-ask-solid)',

				'diff-add': 'var(--k-diff-add-line)',
				'diff-del': 'var(--k-diff-del-line)'
			},
			fontFamily: {
				sans: 'var(--k-font)',
				mono: 'var(--k-font-mono)'
			},
			fontSize: {
				'2xs': ['10px', '11px'],
				xs: ['11px', '14px'],
				sm: ['12px', '16px'],
				md: ['13px', '18px'],
				chat: ['14px', '22px'],
				lg: ['15px', '20px'],
				xl: ['17px', '21px'],
				'2xl': ['22px', '28px']
			},
			borderRadius: {
				xs: 'var(--k-radius-xs)',
				sm: 'var(--k-radius-sm)',
				md: 'var(--k-radius-md)',
				lg: 'var(--k-radius-lg)',
				xl: 'var(--k-radius-xl)',
				pill: 'var(--k-radius-pill)'
			},
			boxShadow: {
				popup: 'var(--k-shadow-popup)',
				soft: 'var(--k-shadow-soft)'
			},
			height: {
				row: 'var(--k-row)',
				'row-tree': 'var(--k-row-tree)',
				'row-menu': 'var(--k-row-menu)',
				control: 'var(--k-control-h)'
			}
		}
	}
};
