/*
 * Klawly design prototype: shared behavior.
 *
 * Plain JavaScript, no build. Every page loads it in <head>:
 *   <script src="../assets/app.js"></script>
 *
 * What it does:
 *   - Theme: dark by default; remembers your choice. Any element with
 *     data-action="toggle-theme" flips it. Add ?theme=light to a URL to force it.
 *   - Popovers: a button with data-popover-target="menu-id" opens and closes
 *     the element with id="menu-id" and the data-popover attribute.
 *     Click outside or press Escape to close. Add class "is-open" in the HTML
 *     to show a popover open when the page loads.
 *   - Tabs: inside [data-tabs], clicking [data-tab="x"] shows [data-tab-panel="x"].
 *     A link to page.html#x opens that page with tab x shown.
 *   - Toggles: clicking [data-toggle-class="is-on"] flips that class on itself
 *     (switches, checkboxes, collapsible rows).
 *   - Show and hide: clicking [data-toggle-hidden="part-id"] shows or hides the
 *     element with that id on the same page and flips is-active on itself
 *     (the Agents Sidebar button, which leaves the same chat on screen).
 *   - States: ?state=kept in the URL draws the page as it is after an action
 *     the app does in place, so such a click links to page.html?state=kept.
 *     It sets data-state on <html>, shows [data-state-show] elements whose
 *     space-separated list names the state and hides [data-state-hide] ones.
 *     Give [data-state-show] elements the hidden attribute in the HTML.
 *   - Pages drawer: the "Pages" tab on the right edge lists every screen,
 *     with Previous / Next, the theme switch and the Origins and Not in the
 *     app switches. It is prototype chrome, not part of the design.
 *   - Origins: outlines every element with data-origin and names it, colored
 *     by who owns it in the real app (see ORIGINS below). Turn it on from the
 *     drawer, with the O key, or with ?origins=1 in the URL.
 *   - Not in the app: every click was checked against the app. An element
 *     with data-app="idea" is not in the app (a proposal); data-app="differs"
 *     is in the app but does something else there, said in data-app-note.
 *     They are outlined while "Not in the app" is on (the default; the I key,
 *     or ?app=0 / ?app=1 in the URL), and their tooltip always says so.
 */
(function () {
	'use strict';

	const THEME_KEY = 'klawly-proto-theme';
	const ORIGINS_KEY = 'klawly-proto-origins';
	const APP_KEY = 'klawly-proto-app';

	/** The values of data-origin, and what each means for a redesign. */
	const ORIGINS = {
		klawly: { name: 'Klawly', help: 'Klawly code. Change anything: layout, content, style.' },
		mixed: { name: 'VS Code, Klawly-styled', help: 'A VS Code part Klawly already styles or fills. Colors and spacing are easy; layout changes mean patching VS Code.' },
		vscode: { name: 'VS Code', help: 'Stock VS Code. Only theme colors are easy; anything else means patching VS Code.' }
	};

	/** Every screen in the prototype, in reading order. Paths are relative to design/. */
	const PAGES = [
		{ group: 'Start', path: 'index.html', title: 'All screens' },
		{ group: 'Start', path: 'onboarding/first-run.html', title: 'First run and sign-in' },
		{ group: 'Start', path: 'home/home.html', title: 'Home (empty window)' },
		{ group: 'Start', path: 'home/empty-editor.html', title: 'Project with no open editor' },

		{ group: 'Workbench', path: 'workbench/editor.html', title: 'Editor with agent pane' },
		{ group: 'Workbench', path: 'workbench/search.html', title: 'Search view' },
		{ group: 'Workbench', path: 'workbench/source-control.html', title: 'Source control' },
		{ group: 'Workbench', path: 'workbench/run-debug.html', title: 'Run and debug' },
		{ group: 'Workbench', path: 'workbench/extensions.html', title: 'Extensions' },
		{ group: 'Workbench', path: 'workbench/quick-open.html', title: 'Quick Open' },
		{ group: 'Workbench', path: 'workbench/command-palette.html', title: 'Command palette' },
		{ group: 'Workbench', path: 'workbench/menus.html', title: 'Title bar and context menus' },
		{ group: 'Workbench', path: 'workbench/editor-widgets.html', title: 'Find, suggest and hover' },
		{ group: 'Workbench', path: 'workbench/diff-editor.html', title: 'Diff editor' },
		{ group: 'Workbench', path: 'workbench/panel.html', title: 'Terminal and problems panel' },
		{ group: 'Workbench', path: 'workbench/notifications.html', title: 'Notifications and status bar' },
		{ group: 'Workbench', path: 'workbench/feedback.html', title: 'Send Feedback' },
		{ group: 'Workbench', path: 'workbench/palette.html', title: 'Palette v2 swatches' },

		{ group: 'Agent chat', path: 'chat/new-chat.html', title: 'New chat' },
		{ group: 'Agent chat', path: 'chat/composer-typed.html', title: 'Composer with a typed prompt' },
		{ group: 'Agent chat', path: 'chat/turn-running.html', title: 'Turn running' },
		{ group: 'Agent chat', path: 'chat/terminal-wait.html', title: 'Waiting in the terminal' },
		{ group: 'Agent chat', path: 'chat/turn-finished.html', title: 'Turn finished with edits' },
		{ group: 'Agent chat', path: 'chat/turn-limit.html', title: 'Turn stopped at its step limit' },
		{ group: 'Agent chat', path: 'chat/pull-request.html', title: 'Pull request opened' },
		{ group: 'Agent chat', path: 'chat/permission.html', title: 'Permission request' },
		{ group: 'Agent chat', path: 'chat/allow-everything.html', title: 'Allow Everything on' },
		{ group: 'Agent chat', path: 'chat/mode-menu.html', title: 'Mode menu' },
		{ group: 'Agent chat', path: 'chat/plan-mode.html', title: 'Plan mode selected' },
		{ group: 'Agent chat', path: 'chat/model-menu.html', title: 'Model menu' },
		{ group: 'Agent chat', path: 'chat/compare-models.html', title: 'Compare models' },
		{ group: 'Agent chat', path: 'chat/compare-editor.html', title: 'Compare editor' },
		{ group: 'Agent chat', path: 'chat/context-menu.html', title: '@ context menu' },
		{ group: 'Agent chat', path: 'chat/slash-menu.html', title: '/ command menu' },
		{ group: 'Agent chat', path: 'chat/context-window.html', title: 'Context window popover' },
		{ group: 'Agent chat', path: 'chat/more-menu.html', title: 'Chat header menu' },
		{ group: 'Agent chat', path: 'chat/agents-list.html', title: 'Agents list' },
		{ group: 'Agent chat', path: 'chat/agent-editor.html', title: 'Agent in an editor tab' },
		{ group: 'Agent chat', path: 'chat/agent-pane-placeholder.html', title: 'Agent pane while the chat is in a tab' },
		{ group: 'Agent chat', path: 'chat/agents-window.html', title: 'Agents window' },
		{ group: 'Agent chat', path: 'chat/agent-sessions-window.html', title: 'Agents window (Agent Host)' },

		{ group: 'Review and plan', path: 'review/review-editor.html', title: 'Review editor' },
		{ group: 'Review and plan', path: 'review/inline-changes.html', title: 'Pending changes in the editor' },
		{ group: 'Review and plan', path: 'plan/plan-card.html', title: 'Plan card in chat' },
		{ group: 'Review and plan', path: 'plan/plan-editor.html', title: 'Plan editor' },

		{ group: 'Editor AI', path: 'editor/selection-toolbar.html', title: 'Selection toolbar' },
		{ group: 'Editor AI', path: 'editor/browser-preview.html', title: 'Browser preview' },
		{ group: 'Editor AI', path: 'editor/inline-edit.html', title: 'Inline edit (Ctrl+K)' },
		{ group: 'Editor AI', path: 'editor/inline-edit-result.html', title: 'Inline edit result and follow-up' },
		{ group: 'Editor AI', path: 'editor/tab-completion.html', title: 'Tab completion' },
		{ group: 'Editor AI', path: 'editor/line-attribution.html', title: 'Line attribution' },
		{ group: 'Editor AI', path: 'editor/terminal-prompt.html', title: 'Terminal Ctrl+K' },
		{ group: 'Editor AI', path: 'editor/terminal-selection-bar.html', title: 'Terminal Selection Bar' },

		{ group: 'Settings', path: 'settings/general.html', title: 'General' },
		{ group: 'Settings', path: 'settings/plan-usage.html', title: 'Plan and usage' },
		{ group: 'Settings', path: 'settings/agents.html', title: 'Agents' },
		{ group: 'Settings', path: 'settings/automations.html', title: 'Automations' },
		{ group: 'Settings', path: 'settings/automation-editor.html', title: 'Automation Editor' },
		{ group: 'Settings', path: 'settings/models.html', title: 'Models' },
		{ group: 'Settings', path: 'settings/git.html', title: 'Git and pull requests' },
		{ group: 'Settings', path: 'settings/customize.html', title: 'Customize' },
		{ group: 'Settings', path: 'settings/customize-discover.html', title: 'Customize: Discover' },
		{ group: 'Settings', path: 'settings/tab.html', title: 'Tab' },
		{ group: 'Settings', path: 'settings/beta.html', title: 'Beta' },
		{ group: 'Settings', path: 'settings/classic-settings.html', title: 'Editor settings (classic)' },
		{ group: 'Settings', path: 'settings/keyboard-shortcuts.html', title: 'Keyboard shortcuts' }
	];

	// Base URL of the design/ folder, worked out from this script's own URL.
	const script = document.currentScript;
	const base = script ? new URL('..', script.src) : new URL('./', location.href);

	// ---- Theme (runs before paint so there is no flash) ----------------------
	function readTheme() {
		const forced = new URLSearchParams(location.search).get('theme');
		if (forced === 'light' || forced === 'dark') {
			return forced;
		}
		try {
			return localStorage.getItem(THEME_KEY) || 'dark';
		} catch {
			return 'dark';
		}
	}

	function applyTheme(theme) {
		document.documentElement.setAttribute('data-theme', theme);
	}

	function toggleTheme() {
		const next = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
		applyTheme(next);
		try {
			localStorage.setItem(THEME_KEY, next);
		} catch {
			// Storage can be blocked; the toggle still works for this page.
		}
	}

	applyTheme(readTheme());

	// ---- Helpers -------------------------------------------------------------
	function currentIndex() {
		const here = location.href.split(/[?#]/)[0];
		return PAGES.findIndex(p => new URL(p.path, base).href === here);
	}

	/** The values of data-app: clicks the prototype shows but the app does not do. */
	const APP_MARKS = {
		idea: { name: 'Idea', help: 'Not in the app. The prototype proposes it.' },
		differs: { name: 'App differs', help: 'In the app, but a click there does something else.' }
	};

	// ---- Origins overlay -----------------------------------------------------
	let originsLayer;
	let appLayer;
	let originsFrame = 0;

	function readOrigins() {
		const forced = new URLSearchParams(location.search).get('origins');
		if (forced === '1' || forced === '0') {
			return forced === '1';
		}
		try {
			return localStorage.getItem(ORIGINS_KEY) === '1';
		} catch {
			return false;
		}
	}

	function drawOrigins() {
		originsFrame = 0;
		if (!originsLayer) {
			return;
		}
		originsLayer.textContent = '';
		const placed = [];
		document.querySelectorAll('[data-origin]').forEach(el => {
			const rect = el.getBoundingClientRect();
			if (rect.width < 2 || rect.height < 2) {
				return; // closed popovers, hidden tab panels
			}
			const origin = ORIGINS[el.getAttribute('data-origin')];
			const box = document.createElement('div');
			box.className = 'proto-origin-box is-' + el.getAttribute('data-origin') + (rect.width < 90 ? ' is-small' : '');
			box.style.left = rect.left + 'px';
			box.style.top = rect.top + 'px';
			box.style.width = rect.width + 'px';
			box.style.height = rect.height + 'px';
			const tag = document.createElement('span');
			tag.className = 'proto-origin-tag';
			const label = el.getAttribute('data-label') || '';
			tag.textContent = rect.width < 90 ? '' : (origin ? origin.name : '?') + ' · ' + label;
			tag.title = label + '\n' + (origin ? origin.help : '') + '\n\nSource:\n' + (el.getAttribute('data-source') || '').split(' ').join('\n');
			box.appendChild(tag);
			originsLayer.appendChild(box);
			// A child usually starts where its parent does; move its tag right of any tag it would cover.
			for (let i = 0; i < 6 && tag.textContent; i++) {
				const t = tag.getBoundingClientRect();
				const hit = placed.find(p => t.left < p.right && t.right > p.left && t.top < p.bottom && t.bottom > p.top);
				if (!hit) {
					break;
				}
				tag.style.left = (hit.right - rect.left + 2) + 'px';
			}
			placed.push(tag.getBoundingClientRect());
		});
	}

	function drawAppMarks() {
		if (!appLayer) {
			return;
		}
		appLayer.textContent = '';
		document.querySelectorAll('[data-app]').forEach(el => {
			const rect = el.getBoundingClientRect();
			const mark = APP_MARKS[el.getAttribute('data-app')];
			if (!mark || rect.width < 2 || rect.height < 2) {
				return;
			}
			const box = document.createElement('div');
			box.className = 'proto-app-box is-' + el.getAttribute('data-app');
			box.style.left = rect.left + 'px';
			box.style.top = rect.top + 'px';
			box.style.width = rect.width + 'px';
			box.style.height = rect.height + 'px';
			const badge = document.createElement('span');
			badge.className = 'proto-app-badge';
			badge.textContent = el.getAttribute('data-app') === 'idea' ? '?' : '≠';
			badge.title = appNote(el);
			box.appendChild(badge);
			appLayer.appendChild(box);
		});
	}

	function appNote(el) {
		const mark = APP_MARKS[el.getAttribute('data-app')];
		const note = el.getAttribute('data-app-note');
		return mark ? mark.name + ': ' + (note || mark.help) : '';
	}

	function scheduleOrigins() {
		if ((originsLayer || appLayer) && !originsFrame) {
			originsFrame = requestAnimationFrame(() => {
				drawOrigins();
				drawAppMarks();
			});
		}
	}

	function setOrigins(on, remember) {
		if (on && !originsLayer) {
			originsLayer = document.createElement('div');
			originsLayer.className = 'proto-origins-layer';
			document.body.appendChild(originsLayer);
			scheduleOrigins();
		} else if (!on && originsLayer) {
			originsLayer.remove();
			originsLayer = undefined;
		}
		document.querySelectorAll('[data-proto="origins"]').forEach(b => b.classList.toggle('is-on', on));
		if (remember) {
			try {
				localStorage.setItem(ORIGINS_KEY, on ? '1' : '0');
			} catch {
				// Storage can be blocked; the switch still works for this page.
			}
		}
	}

	function readApp() {
		const forced = new URLSearchParams(location.search).get('app');
		if (forced === '1' || forced === '0') {
			return forced === '1';
		}
		try {
			return localStorage.getItem(APP_KEY) !== '0';
		} catch {
			return true;
		}
	}

	function setApp(on, remember) {
		if (on && !appLayer) {
			appLayer = document.createElement('div');
			appLayer.className = 'proto-origins-layer';
			document.body.appendChild(appLayer);
			scheduleOrigins();
		} else if (!on && appLayer) {
			appLayer.remove();
			appLayer = undefined;
		}
		document.querySelectorAll('[data-proto="app"]').forEach(b => b.classList.toggle('is-on', on));
		if (remember) {
			try {
				localStorage.setItem(APP_KEY, on ? '1' : '0');
			} catch {
				// Storage can be blocked; the switch still works for this page.
			}
		}
	}

	/** The tooltip of every marked control says what the app does, with or without the outlines. */
	function noteAppMarks() {
		document.querySelectorAll('[data-app]').forEach(el => {
			const note = appNote(el);
			if (note) {
				el.title = (el.title ? el.title + '\n' : '') + note;
			}
		});
	}

	function closeAllPopovers(except) {
		document.querySelectorAll('[data-popover].is-open').forEach(el => {
			if (el !== except && !el.hasAttribute('data-popover-static')) {
				el.classList.remove('is-open');
			}
		});
	}

	// ---- States --------------------------------------------------------------
	/** Draws the page in the state ?state= names (or its default state). */
	function applyState() {
		const state = new URLSearchParams(location.search).get('state');
		if (state) {
			document.documentElement.setAttribute('data-state', state);
		}
		const names = value => value.split(/\s+/).filter(Boolean);
		document.querySelectorAll('[data-state-show]').forEach(el => {
			el.hidden = !state || !names(el.getAttribute('data-state-show')).includes(state);
		});
		document.querySelectorAll('[data-state-hide]').forEach(el => {
			el.hidden = !!state && names(el.getAttribute('data-state-hide')).includes(state);
		});
	}

	// ---- Pages drawer --------------------------------------------------------
	function buildDrawer() {
		const index = currentIndex();
		const fab = document.createElement('button');
		fab.className = 'proto-fab';
		fab.type = 'button';
		fab.title = 'Prototype pages ( [ and ] to step through )';
		fab.innerHTML = 'Pages';

		const drawer = document.createElement('nav');
		drawer.className = 'proto-drawer';
		drawer.setAttribute('aria-label', 'Prototype pages');

		const prev = index > 0 ? PAGES[index - 1] : undefined;
		const next = index >= 0 && index < PAGES.length - 1 ? PAGES[index + 1] : undefined;

		const row = document.createElement('div');
		row.className = 'proto-row';
		row.innerHTML =
			'<button type="button" data-proto="prev"' + (prev ? '' : ' disabled') + '>‹ Previous</button>' +
			'<button type="button" data-action="toggle-theme">Theme</button>' +
			'<button type="button" data-proto="next"' + (next ? '' : ' disabled') + '>Next ›</button>';
		drawer.appendChild(row);

		const legend = document.createElement('div');
		legend.className = 'proto-legend';
		legend.innerHTML = '<button type="button" data-proto="origins" title="Show who owns each part (O)">Origins: what is VS Code?</button>';
		Object.keys(ORIGINS).forEach(key => {
			const item = document.createElement('div');
			item.className = 'is-' + key;
			item.innerHTML = '<i></i><span><b></b> <span></span></span>';
			item.querySelector('b').textContent = ORIGINS[key].name + ':';
			item.querySelector('span span').textContent = ORIGINS[key].help;
			legend.appendChild(item);
		});
		drawer.appendChild(legend);
		legend.querySelector('button').addEventListener('click', () => setOrigins(!originsLayer, true));

		const marks = document.createElement('div');
		marks.className = 'proto-legend';
		const count = document.querySelectorAll('[data-app]').length;
		marks.innerHTML = '<button type="button" data-proto="app" title="Outline clicks the app does not do (I)"></button>';
		marks.querySelector('button').textContent = 'Not in the app' + (count ? ' (' + count + ' on this page)' : ': none on this page');
		Object.keys(APP_MARKS).forEach(key => {
			const item = document.createElement('div');
			item.className = 'is-app-' + key;
			item.innerHTML = '<i></i><span><b></b> <span></span></span>';
			item.querySelector('b').textContent = APP_MARKS[key].name + ':';
			item.querySelector('span span').textContent = APP_MARKS[key].help;
			marks.appendChild(item);
		});
		drawer.appendChild(marks);
		marks.querySelector('button').addEventListener('click', () => setApp(!appLayer, true));

		let group = '';
		PAGES.forEach((page, i) => {
			if (page.group !== group) {
				group = page.group;
				const h = document.createElement('h4');
				h.textContent = group;
				drawer.appendChild(h);
			}
			const a = document.createElement('a');
			a.href = new URL(page.path, base).href;
			a.textContent = page.title;
			if (i === index) {
				a.className = 'is-current';
			}
			drawer.appendChild(a);
		});

		row.addEventListener('click', e => {
			const which = e.target.closest('[data-proto]');
			if (!which) {
				return;
			}
			const target = which.getAttribute('data-proto') === 'prev' ? prev : next;
			if (target) {
				location.href = new URL(target.path, base).href;
			}
		});

		fab.addEventListener('click', e => {
			e.stopPropagation();
			drawer.classList.toggle('is-open');
		});
		document.addEventListener('click', e => {
			if (!drawer.contains(e.target) && e.target !== fab) {
				drawer.classList.remove('is-open');
			}
		});
		document.addEventListener('keydown', e => {
			const typing = e.target.closest('input, textarea, [contenteditable="true"]');
			if (typing || e.ctrlKey || e.metaKey || e.altKey) {
				return;
			}
			if (e.key === '[' && prev) {
				location.href = new URL(prev.path, base).href;
			} else if (e.key === ']' && next) {
				location.href = new URL(next.path, base).href;
			} else if (e.key === 'o' || e.key === 'O') {
				setOrigins(!originsLayer, true);
			} else if (e.key === 'i' || e.key === 'I') {
				setApp(!appLayer, true);
			}
		});

		document.body.appendChild(drawer);
		document.body.appendChild(fab);
	}

	// ---- Tabs ----------------------------------------------------------------
	/** Shows the panel of a [data-tab] in its [data-tabs] group. False when it has no group. */
	function showTab(tab) {
		const group = tab.closest('[data-tabs]');
		if (!group) {
			return false;
		}
		const name = tab.getAttribute('data-tab');
		group.querySelectorAll('[data-tab]').forEach(t => t.classList.toggle('is-active', t === tab));
		group.querySelectorAll('[data-tab-panel]').forEach(p => {
			p.hidden = p.getAttribute('data-tab-panel') !== name;
		});
		return true;
	}

	/** page.html#x opens with tab x shown, so a link can land on any tab of a page. */
	function showTabFromHash() {
		const name = decodeURIComponent(location.hash.slice(1));
		const tab = name && document.querySelector(`[data-tabs] [data-tab="${CSS.escape(name)}"]`);
		if (tab) {
			showTab(tab);
		}
	}

	// ---- Wiring --------------------------------------------------------------
	document.addEventListener('DOMContentLoaded', () => {
		showTabFromHash();
		applyState();
		buildDrawer();
		noteAppMarks();
		setOrigins(readOrigins(), false);
		setApp(readApp(), false);
		window.addEventListener('resize', scheduleOrigins);
		document.addEventListener('scroll', scheduleOrigins, true);
		// Menus, tabs and toggles change what is visible; redraw after the click is handled.
		document.addEventListener('click', () => setTimeout(scheduleOrigins), true);
		document.addEventListener('keydown', () => setTimeout(scheduleOrigins), true);
		// A tab with data-tab-toggle closes its panel when clicked while shown (the status bar bell).
		document.addEventListener('click', e => {
			const tab = e.target.closest('[data-tab-toggle].is-active');
			const group = tab && tab.closest('[data-tabs]');
			if (group) {
				e.preventDefault();
				e.stopImmediatePropagation();
				tab.classList.remove('is-active');
				group.querySelectorAll(`[data-tab-panel="${CSS.escape(tab.getAttribute('data-tab'))}"]`).forEach(p => {
					p.hidden = true;
				});
			}
		}, true);

		document.addEventListener('click', e => {
			const themeBtn = e.target.closest('[data-action="toggle-theme"]');
			if (themeBtn) {
				e.preventDefault();
				toggleTheme();
				return;
			}

			const opener = e.target.closest('[data-popover-target]');
			if (opener) {
				e.preventDefault();
				e.stopPropagation();
				const target = document.getElementById(opener.getAttribute('data-popover-target'));
				if (target) {
					const open = !target.classList.contains('is-open');
					closeAllPopovers(target);
					target.classList.toggle('is-open', open);
				}
				return;
			}

			const tab = e.target.closest('[data-tab]');
			if (tab && showTab(tab)) {
				e.preventDefault();
			}

			const hider = e.target.closest('[data-toggle-hidden]');
			if (hider) {
				e.preventDefault();
				const part = document.getElementById(hider.getAttribute('data-toggle-hidden'));
				if (part) {
					part.hidden = !part.hidden;
					hider.classList.toggle('is-active', !part.hidden);
				}
				return;
			}

			const toggle = e.target.closest('[data-toggle-class]');
			if (toggle) {
				toggle.classList.toggle(toggle.getAttribute('data-toggle-class'));
			}

			if (!e.target.closest('[data-popover]')) {
				closeAllPopovers();
			}
		});

		document.addEventListener('keydown', e => {
			if (e.key === 'Escape') {
				closeAllPopovers();
			}
		});
	});
})();
