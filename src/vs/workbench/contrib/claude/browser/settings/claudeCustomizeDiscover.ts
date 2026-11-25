/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/claudeCustomizeDiscover.css';
import { $, addDisposableListener, append, clearNode, EventType, getActiveElement, isHTMLElement } from '../../../../../base/browser/dom.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { MarkdownString } from '../../../../../base/common/htmlContent.js';
import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../../base/common/network.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { CLAUDE_PLUGIN_KINDS, CLAUDE_PLUGINS_BUILT_IN_MARKETPLACES_SETTING, ClaudeMarketplaceInfo, ClaudePluginCatalog, ClaudePluginCatalogRequest, ClaudePluginCommand, ClaudePluginContents, ClaudePluginDetails, ClaudePluginEntry, ClaudePluginKind, ClaudePluginPolicy, ClaudePluginScope, filterClaudePlugins, IClaudePluginService, knownClaudePluginKinds } from '../../../../../platform/claude/common/claudePlugins.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IDialogService, IPromptButton } from '../../../../../platform/dialogs/common/dialogs.js';
import { IHoverService } from '../../../../../platform/hover/browser/hover.js';
import { IMarkdownRendererService } from '../../../../../platform/markdown/browser/markdownRenderer.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { IQuickInputService } from '../../../../../platform/quickinput/common/quickInput.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IWorkspaceTrustManagementService } from '../../../../../platform/workspace/common/workspaceTrust.js';
import { redactSecrets } from '../../../../services/claude/common/claudeAgentLog.js';
import { IClaudeAgentService } from '../../../../services/claude/common/claudeAgentService.js';
import { claudeCustomizeKindLabel } from '../../common/claudeSettingsPages.js';

/** What the Discover tab asks of the settings editor that hosts it. */
export interface IClaudeCustomizeDiscoverHost {
	/** The tab's content changed size: the page's scroll bar measures again. */
	layout(): void;
	/** A plugin was installed, updated or removed: the Installed tab reads Claude Code again. */
	changed(): void;
	/** Shows the chat with the current session, after Try in a New Session opened one. */
	openChat(): void;
}

function errorMessage(error: unknown): string {
	return redactSecrets(error instanceof Error ? error.message : String(error));
}

function scopeLabel(scope: string): string {
	switch (scope) {
		case 'user': return localize('claudeDiscoverScopeUser', "Installed for you.");
		case 'project': return localize('claudeDiscoverScopeProject', "Installed in this project, for everyone who opens it.");
		case 'local': return localize('claudeDiscoverScopeLocal', "Installed in this project, for you only.");
		default: return localize('claudeDiscoverScopeOther', "Installed ({0}).", scope);
	}
}

function hookLabel(hook: ClaudePluginContents['hooks'][number]): string {
	return hook.matcher ? localize('claudeDiscoverHookMatcher', "Hook: {0} ({1})", hook.event, hook.matcher) : localize('claudeDiscoverHook', "Hook: {0}", hook.event);
}

function serverCommand(server: ClaudePluginContents['mcpServers'][number]): string {
	return server.url ?? [server.command ?? '', ...(server.args ?? [])].join(' ').trim();
}

/** Everything a plugin runs on its own, for the install dialog: each hook and each MCP server. */
function installDetail(plugin: ClaudePluginEntry, contents: ClaudePluginContents | undefined): string {
	const lines: string[] = [];
	if (plugin.description) {
		lines.push(plugin.description, '');
	}
	if (!contents) {
		lines.push(localize('claudeDiscoverInstallUnknown', "Klawly could not read this plugin's files before install, so it cannot list the hooks and MCP servers it runs."));
	} else {
		for (const hook of contents.hooks) {
			lines.push(`${hookLabel(hook)}: ${hook.command}`);
		}
		for (const server of contents.mcpServers) {
			lines.push(localize('claudeDiscoverInstallServer', "MCP Server {0}: {1}", server.name, serverCommand(server)));
		}
		if (!contents.hooks.length && !contents.mcpServers.length) {
			lines.push(localize('claudeDiscoverInstallNothingRuns', "It adds no hooks and no MCP servers."));
		}
		if (!contents.complete) {
			lines.push('', localize('claudeDiscoverIncomplete', "Klawly could not read all of this plugin's files, so this list may be short."));
		}
	}
	lines.push('', localize('claudeDiscoverInstallTrust', "A plugin runs with your permissions. Install plugins only from sources you trust."));
	return lines.join('\n');
}

/** Plugins one icon request asks for, so the first rows paint before the last are fetched. */
const ICON_BATCH = 24;

/** One of the six monogram tints, picked by the name so a plugin keeps its color. */
function claudePluginTint(name: string): number {
	let hash = 0;
	for (const char of name.toLowerCase()) {
		hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
	}
	return hash % 6;
}

/**
 * Customize's Discover tab: plugins from the marketplaces Claude Code has and
 * from Klawly's built-in list, a details view of what each one adds, and
 * Install, Update and Remove, which run `claude plugin` through
 * {@link IClaudePluginService}. Rows sit on the customize row ramp (DL-06), the
 * one filled button in a row is Install (DL-09), and the words are Claude
 * Code's (DL-11).
 */
export class ClaudeCustomizeDiscover extends Disposable {

	private readonly _viewStore = this._register(new DisposableStore());
	private readonly _listStore = this._register(new DisposableStore());
	private _focusables = new Map<string, HTMLElement>();
	private _container: HTMLElement | undefined;
	private _list: HTMLElement | undefined;

	private _catalog: ClaudePluginCatalog | undefined;
	private _loading = false;
	private _loadError = '';
	private _loadToken = 0;
	private _query = '';
	private _kind: ClaudePluginKind | undefined;
	/** Plugins whose kinds are being read for a kind filter, and how many could not be read. */
	private _resolving = 0;
	private _unresolved = 0;
	/** The plugin whose details are on show. */
	private _selected: string | undefined;
	private _details: ClaudePluginDetails | undefined;
	private _detailsError = '';
	/** Plugin ids and marketplace names with a `claude plugin` command running. */
	private readonly _busy = new Set<string>();
	/** Plugin icons as `data:` URLs from the shared process; undefined once asked for and not (yet) found. */
	private readonly _icons = new Map<string, string | undefined>();

	constructor(
		private readonly _host: IClaudeCustomizeDiscoverHost,
		@IClaudePluginService private readonly _plugins: IClaudePluginService,
		@IConfigurationService private readonly _configuration: IConfigurationService,
		@IDialogService private readonly _dialogs: IDialogService,
		@IHoverService private readonly _hover: IHoverService,
		@IMarkdownRendererService private readonly _markdown: IMarkdownRendererService,
		@INotificationService private readonly _notifications: INotificationService,
		@IOpenerService private readonly _opener: IOpenerService,
		@IQuickInputService private readonly _quickInput: IQuickInputService,
		@IWorkspaceContextService private readonly _workspace: IWorkspaceContextService,
		@IWorkspaceTrustManagementService private readonly _trust: IWorkspaceTrustManagementService,
		@IClaudeAgentService private readonly _agent: IClaudeAgentService,
	) {
		super();
		this._register(this._configuration.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(CLAUDE_PLUGINS_BUILT_IN_MARKETPLACES_SETTING)) {
				void this.load(false);
			}
		}));
	}

	/**
	 * Draws the tab into `element`. Controls register in `focusables` under a
	 * stable key, so the host can return focus after it draws the page again.
	 */
	render(element: HTMLElement, focusables: Map<string, HTMLElement>): void {
		this._focusables = focusables;
		this._container = append(element, $('.claude-discover'));
		this.renderView();
		if (!this._catalog && !this._loading) {
			void this.load(false);
		}
	}

	/** Reads the catalog again, past the few minutes the last one is kept for. */
	refresh(): Promise<void> {
		return this.load(true);
	}

	private builtIn(): boolean {
		return this._configuration.getValue<boolean>(CLAUDE_PLUGINS_BUILT_IN_MARKETPLACES_SETTING) !== false;
	}

	/** What the catalog reads. A trusted folder adds the marketplaces its `.claude/settings.json` declares. */
	private request(): ClaudePluginCatalogRequest {
		return { builtIn: this.builtIn(), cwd: this._trust.isWorkspaceTrusted() ? this.projectCwd() : undefined };
	}

	private async load(refresh: boolean): Promise<void> {
		const token = ++this._loadToken;
		if (refresh) {
			this._icons.clear();
		}
		this._loading = true;
		this.redraw();
		try {
			const catalog = await this._plugins.getCatalog({ ...this.request(), refresh });
			if (token === this._loadToken) {
				this._catalog = catalog;
				this._loadError = '';
				this._unresolved = 0;
				void this.resolveKinds();
			}
		} catch (error) {
			if (token === this._loadToken) {
				this._loadError = errorMessage(error);
			}
		} finally {
			if (token === this._loadToken) {
				this._loading = false;
				this.redraw();
			}
		}
	}

	/**
	 * Reads what the plugins with unknown kinds add, once a kind filter needs it,
	 * and the ones whose kinds from Claude Code's catalog cache lack the filter's
	 * kind (the cache can miss one, issue 535). GitHub plugins are read through
	 * their repository tree; the rest stay out of the filter.
	 */
	private async resolveKinds(): Promise<void> {
		const catalog = this._catalog;
		const kind = this._kind;
		const ids = catalog?.plugins.filter(plugin => {
			const known = knownClaudePluginKinds(plugin);
			return !known || (plugin.kindsPartial && !!kind && !known.includes(kind));
		}).map(plugin => plugin.id) ?? [];
		if (!kind || !catalog || ids.length === 0 || this._resolving) {
			return;
		}
		this._resolving = ids.length;
		this.renderList();
		let kinds: Record<string, readonly ClaudePluginKind[]> = {};
		try {
			kinds = await this._plugins.resolveKinds(ids, this.request());
		} catch {
			// Counted below as plugins that could not be read.
		}
		this._resolving = 0;
		if (this._catalog === catalog) {
			this._catalog = { ...catalog, plugins: catalog.plugins.map(plugin => kinds[plugin.id] && ids.includes(plugin.id) ? { ...plugin, kinds: kinds[plugin.id], kindsPartial: undefined } : plugin) };
			this._unresolved = ids.filter(id => !kinds[id]).length;
			this.renderList();
		} else {
			// The catalog was read again meanwhile; read the new one's kinds.
			void this.resolveKinds();
		}
	}

	/** Draws again what depends on loaded data: the list, or the whole details view. */
	private redraw(): void {
		if (this._selected) {
			this.renderView();
		} else {
			this.renderList();
		}
	}

	private focusable<T extends HTMLElement>(element: T, key: string): T {
		element.dataset.focusKey = key;
		this._focusables.set(key, element);
		return element;
	}

	private button(parent: HTMLElement, key: string, className: string, label: string, run: () => void, store: DisposableStore, icon?: ThemeIcon): HTMLButtonElement {
		const button = this.focusable(append(parent, $<HTMLButtonElement>(`button.${className}`)), key);
		button.type = 'button';
		if (icon) {
			append(button, $(ThemeIcon.asCSSSelector(icon)));
			if (label) {
				append(button, $('span')).textContent = label;
			}
		} else {
			button.textContent = label;
		}
		store.add(addDisposableListener(button, EventType.CLICK, run));
		return button;
	}

	private sectionHead(parent: HTMLElement, label: string, count?: number): HTMLElement {
		const head = append(parent, $('.claude-settings-section-head'));
		const title = append(head, $('h3.claude-settings-section-label'));
		title.textContent = label;
		if (count !== undefined) {
			append(title, $('span.count')).textContent = String(count);
		}
		return head;
	}

	private note(parent: HTMLElement, text: string, error = false): void {
		const card = append(parent, $('.claude-settings-card'));
		const note = append(card, $('.claude-settings-row.is-note'));
		const description = append(note, $('.claude-settings-row-description'));
		description.classList.toggle('is-error', error);
		description.textContent = text;
	}

	private restoreFocus(scope: HTMLElement, run: () => void): void {
		const active = getActiveElement();
		const focusKey = isHTMLElement(active) && scope.contains(active) ? active.dataset.focusKey : undefined;
		run();
		if (focusKey) {
			this._focusables.get(focusKey)?.focus();
		}
		this._host.layout();
	}

	//#region List

	private renderView(): void {
		const container = this._container;
		if (!container?.isConnected) {
			return;
		}
		this.restoreFocus(container, () => {
			this._viewStore.clear();
			this._listStore.clear();
			this._list = undefined;
			clearNode(container);
			if (this._selected) {
				this.renderDetails(container, this._selected);
				return;
			}
			const bar = append(container, $('.claude-customize-bar'));
			const search = this.focusable(append(bar, $<HTMLInputElement>('input.claude-field.claude-customize-search')), 'discover.search');
			search.type = 'search';
			search.placeholder = localize('claudeDiscoverSearch', "Search plugins in your marketplaces");
			search.setAttribute('aria-label', localize('claudeDiscoverSearchLabel', "Search Plugins"));
			search.value = this._query;
			this._viewStore.add(addDisposableListener(search, EventType.INPUT, () => {
				this._query = search.value;
				this.renderList();
			}));
			this.button(bar, 'discover.addMarketplace', 'claude-btn.claude-customize-refresh', localize('claudeDiscoverAddMarketplace', "Add Marketplace"), () => void this.addMarketplace(), this._viewStore, Codicon.add);
			// DL-15: Refresh is an icon button with its name in a hover (issue 581).
			const refreshLabel = localize('claudeSettingsRefresh', "Refresh");
			const refresh = this.button(bar, 'discover.refresh', 'claude-btn.is-icon.claude-customize-refresh', '', () => void this.load(true), this._viewStore, Codicon.refresh);
			refresh.setAttribute('aria-label', refreshLabel);
			this._viewStore.add(this._hover.setupDelayedHover(refresh, { content: refreshLabel, additionalClasses: ['claude-root'] }));

			const chips = append(container, $('.claude-customize-chips'));
			chips.setAttribute('role', 'group');
			chips.setAttribute('aria-label', localize('claudeCustomizeKinds', "Show"));
			const chip = (kind: ClaudePluginKind | undefined, label: string) => {
				const button = this.button(chips, `discover.chip:${kind ?? 'all'}`, 'claude-chip.is-toggle.claude-customize-chip', label, () => {
					this._kind = kind;
					this.renderView();
					void this.resolveKinds();
				}, this._viewStore);
				button.dataset.kind = kind ?? 'all';
				const selected = this._kind === kind;
				button.classList.toggle('is-selected', selected);
				button.setAttribute('aria-pressed', String(selected));
			};
			chip(undefined, localize('claudeCustomizeAll', "All"));
			for (const kind of CLAUDE_PLUGIN_KINDS) {
				chip(kind, claudeCustomizeKindLabel(kind));
			}

			this._list = append(container, $('.claude-customize-list'));
			this.renderList();
		});
	}

	private renderList(): void {
		const list = this._list;
		if (!list?.isConnected) {
			return;
		}
		this.restoreFocus(list, () => {
			this._listStore.clear();
			clearNode(list);
			const catalog = this._catalog;
			if (!catalog) {
				this.note(list, this._loadError || localize('claudeDiscoverLoading', "Reading your plugin marketplaces..."), !!this._loadError);
				return;
			}
			if (this._loadError) {
				this.note(list, this._loadError, true);
			}
			const plugins = filterClaudePlugins(catalog.plugins, this._query, this._kind);
			const group = append(list, $('.claude-customize-group'));
			group.dataset.kind = 'plugins';
			this.sectionHead(group, localize('claudeDiscoverPlugins', "Plugins"), plugins.length);
			if (plugins.length === 0) {
				this.note(group, this.emptyText(catalog));
			} else {
				const card = append(group, $('.claude-settings-card.claude-customize-card'));
				for (const plugin of plugins) {
					this.renderPluginRow(card, plugin);
				}
				void this.loadIcons(plugins);
			}
			if (this._kind && (this._resolving || this._unresolved)) {
				append(group, $('.claude-discover-hint')).textContent = this._resolving
					? localize('claudeDiscoverResolving', "Reading what {0} more plugins add...", this._resolving)
					: this._unresolved === 1
						? localize('claudeDiscoverUnresolvedOne', "1 plugin could not be read before install, so this filter leaves it out.")
						: localize('claudeDiscoverUnresolved', "{0} plugins could not be read before install, so this filter leaves them out.", this._unresolved);
			}
			this.renderMarketplaces(list, catalog.marketplaces);
		});
	}

	private emptyText(catalog: ClaudePluginCatalog): string {
		if (this._query.trim()) {
			return localize('claudeCustomizeNoMatch', "Nothing matches \"{0}\".", this._query.trim());
		}
		if (catalog.marketplaces.length === 0) {
			return localize('claudeDiscoverNoMarketplaces', "No plugin marketplaces yet. Add one, or turn on Klawly's built-in list in settings.");
		}
		return localize('claudeDiscoverNoPlugins', "No plugins of this kind in your marketplaces.");
	}

	private renderPluginRow(card: HTMLElement, plugin: ClaudePluginEntry): void {
		const row = append(card, $('.claude-customize-item.claude-discover-item'));
		row.dataset.plugin = plugin.id;
		const open = this.focusable(append(row, $<HTMLButtonElement>('button.claude-discover-open')), `discover.open:${plugin.id}`);
		open.type = 'button';
		this.paintPluginIcon(append(open, $('span.claude-customize-icon.claude-plugin-icon')), plugin);
		const text = append(open, $('span.claude-customize-text'));
		append(text, $('span.name')).textContent = plugin.displayName ?? plugin.name;
		const kinds = (knownClaudePluginKinds(plugin) ?? []).map(kind => claudeCustomizeKindLabel(kind));
		append(text, $('span.detail')).textContent = [plugin.description, kinds.join(', '), plugin.marketplace].filter(part => part.length > 0).join(' · ');
		this._listStore.add(addDisposableListener(open, EventType.CLICK, () => this.openDetails(plugin.id)));
		this.renderActions(row, plugin, this._listStore, true);
	}

	/**
	 * Issue 534 (DL-57): the plugin's own image once the shared process has it,
	 * else the first letter of its name on a tint the name picks, so rows stay
	 * apart offline. A remote image only ever lands as a fixed-size `<img>`.
	 */
	private paintPluginIcon(icon: HTMLElement, plugin: ClaudePluginEntry): void {
		icon.dataset.pluginIcon = plugin.id;
		clearNode(icon);
		const image = this._icons.get(plugin.id);
		icon.classList.toggle('is-monogram', !image);
		if (image) {
			const img = append(icon, $<HTMLImageElement>('img'));
			img.alt = '';
			img.draggable = false;
			img.width = img.height = 28;
			img.src = image;
			return;
		}
		const name = plugin.displayName ?? plugin.name;
		icon.dataset.tint = String(claudePluginTint(name));
		icon.textContent = (/[\p{L}\p{N}]/u.exec(name)?.[0] ?? '?').toLocaleUpperCase();
	}

	/** Asks the shared process for the icons of these plugins a batch at a time, and paints each row as its batch comes. */
	private async loadIcons(plugins: readonly ClaudePluginEntry[]): Promise<void> {
		const wanted = plugins.filter(plugin => plugin.iconUrl && !this._icons.has(plugin.id));
		for (const plugin of wanted) {
			this._icons.set(plugin.id, undefined);
		}
		for (let start = 0; start < wanted.length; start += ICON_BATCH) {
			const batch = wanted.slice(start, start + ICON_BATCH);
			const icons = await this._plugins.getPluginIcons(batch.map(plugin => plugin.id), this.request()).catch((): Record<string, string> => ({}));
			for (const plugin of batch) {
				if (icons[plugin.id] && this._icons.has(plugin.id)) {
					this._icons.set(plugin.id, icons[plugin.id]);
					// Rows are rebuilt on every filter, so the row painted when the icon arrives is looked up, not kept.
					// eslint-disable-next-line no-restricted-syntax
					for (const icon of this._container?.querySelectorAll<HTMLElement>('.claude-plugin-icon') ?? []) {
						if (icon.dataset.pluginIcon === plugin.id) {
							this.paintPluginIcon(icon, plugin);
						}
					}
				}
			}
		}
	}

	/** The state badge and Install, Update or Remove for one plugin. */
	private renderActions(parent: HTMLElement, plugin: ClaudePluginEntry, store: DisposableStore, quiet: boolean): void {
		const busy = this._busy.has(plugin.id);
		if (plugin.policy) {
			this.renderPolicy(parent, plugin.policy, store);
		}
		if (plugin.installed) {
			const badge = append(parent, $('span.claude-badge.is-idle'));
			badge.textContent = localize('claudeDiscoverInstalled', "Installed");
			store.add(this._hover.setupDelayedHover(badge, { content: scopeLabel(plugin.installed.scope), additionalClasses: ['claude-root'] }));
			if (plugin.updateAvailable) {
				const update = this.button(parent, `discover.update:${plugin.id}`, 'claude-btn.is-secondary.is-small', localize('claudeDiscoverUpdate', "Update"), () => void this.updatePlugin(plugin), store);
				update.disabled = busy;
			}
			// DL-12: Claude Code turns a required plugin back on, so there is no Remove.
			if (plugin.policy === 'required') {
				return;
			}
			const label = localize('claudeDiscoverRemove', "Remove Plugin");
			if (quiet) {
				const remove = this.button(parent, `discover.remove:${plugin.id}`, 'claude-icon-btn.claude-customize-action', '', () => void this.uninstall(plugin), store, Codicon.trash);
				remove.setAttribute('aria-label', label);
				remove.disabled = busy;
				store.add(this._hover.setupDelayedHover(remove, { content: label, additionalClasses: ['claude-root'] }));
			} else {
				this.button(parent, `discover.remove:${plugin.id}`, 'claude-btn.is-ghost.is-small', label, () => void this.uninstall(plugin), store).disabled = busy;
			}
			return;
		}
		const install = this.button(parent, `discover.install:${plugin.id}`, 'claude-btn.is-primary.is-small', busy ? localize('claudeDiscoverInstalling', "Installing...") : localize('claudeDiscoverInstall', "Install"), () => void this.install(plugin), store);
		install.disabled = busy;
	}

	/** Issue 523: the badge for a plugin the project turns on by default, or the organization requires (DL-26). */
	private renderPolicy(parent: HTMLElement, policy: ClaudePluginPolicy, store: DisposableStore): void {
		const badge = append(parent, $('span.claude-badge.is-idle.claude-discover-policy'));
		badge.dataset.policy = policy;
		if (policy === 'required') {
			append(badge, $(ThemeIcon.asCSSSelector(Codicon.briefcase)));
		}
		append(badge, $('span')).textContent = policy === 'required' ? localize('claudeDiscoverRequired', "Required") : localize('claudeDiscoverDefaultOn', "Default On");
		const hover = policy === 'required'
			? localize('claudeDiscoverRequiredHover', "Managed by your organization. Claude Code's managed settings turn this plugin on, so it cannot be removed here.")
			: localize('claudeDiscoverDefaultOnHover', "This project's .claude/settings.json turns this plugin on for everyone who opens it.");
		store.add(this._hover.setupDelayedHover(badge, { content: hover, additionalClasses: ['claude-root'] }));
	}

	private renderMarketplaces(list: HTMLElement, marketplaces: readonly ClaudeMarketplaceInfo[]): void {
		if (marketplaces.length === 0) {
			return;
		}
		const group = append(list, $('.claude-customize-group'));
		group.dataset.kind = 'marketplaces';
		this.sectionHead(group, localize('claudeDiscoverMarketplaces', "Marketplaces"), marketplaces.length);
		const card = append(group, $('.claude-settings-card.claude-customize-card'));
		for (const marketplace of marketplaces) {
			const row = append(card, $('.claude-customize-item'));
			row.dataset.marketplace = marketplace.name;
			const icon = append(row, $('.claude-customize-icon'));
			append(icon, $(ThemeIcon.asCSSSelector(Codicon.package)));
			const text = append(row, $('.claude-customize-text'));
			append(text, $('.name')).textContent = marketplace.name;
			const detail = append(text, $('.detail'));
			detail.textContent = marketplace.error ?? localize('claudeDiscoverMarketplaceDetail', "{0} · {1} plugins", marketplace.source, marketplace.pluginCount);
			detail.classList.toggle('is-error', !!marketplace.error);
			const busy = this._busy.has(`marketplace:${marketplace.name}`);
			if (marketplace.builtIn) {
				append(row, $('span.claude-badge.is-idle')).textContent = localize('claudeDiscoverBuiltIn', "Built In");
			}
			if (marketplace.declaredIn) {
				const badge = append(row, $('span.claude-badge.is-idle'));
				badge.dataset.declaredIn = marketplace.declaredIn;
				// Issue 523: a marketplace the shared project settings or the organization declare is the team's.
				badge.textContent = marketplace.declaredIn === 'local' ? localize('claudeDiscoverProjectMarketplace', "Project") : localize('claudeDiscoverTeamMarketplace', "Team");
				const file = marketplace.declaredIn === 'local' ? '.claude/settings.local.json' : '.claude/settings.json';
				const hover = marketplace.declaredIn === 'managed'
					? localize('claudeDiscoverManagedMarketplaceHover', "Managed by your organization. Claude Code's managed settings list this marketplace.")
					: localize('claudeDiscoverProjectMarketplaceHover', "This project's {0} lists this marketplace.", file);
				this._listStore.add(this._hover.setupDelayedHover(badge, { content: hover, additionalClasses: ['claude-root'] }));
			}
			if (!marketplace.added) {
				this.button(row, `discover.addBuiltIn:${marketplace.name}`, 'claude-btn.is-ghost.is-small', localize('claudeDiscoverAddToClaudeCode', "Add to Claude Code"), () => void this.addKnownMarketplace(marketplace), this._listStore).disabled = busy;
			} else if (marketplace.declaredIn !== 'managed') {
				const label = localize('claudeDiscoverRemoveMarketplace', "Remove Marketplace");
				const remove = this.button(row, `discover.removeMarketplace:${marketplace.name}`, 'claude-icon-btn.claude-customize-action', '', () => void this.removeMarketplace(marketplace), this._listStore, Codicon.trash);
				remove.setAttribute('aria-label', label);
				remove.disabled = busy;
				this._listStore.add(this._hover.setupDelayedHover(remove, { content: label, additionalClasses: ['claude-root'] }));
			}
		}
	}

	//#endregion

	//#region Details

	private openDetails(id: string): void {
		this._selected = id;
		this._details = undefined;
		this._detailsError = '';
		this.renderView();
		this._focusables.get('discover.back')?.focus();
		void this.loadDetails(id);
	}

	private closeDetails(): void {
		const id = this._selected;
		this._selected = undefined;
		this._details = undefined;
		this.renderView();
		if (id) {
			this._focusables.get(`discover.open:${id}`)?.focus();
		}
	}

	private async loadDetails(id: string): Promise<void> {
		try {
			const details = await this._plugins.getDetails(id, this.request());
			if (this._selected === id) {
				this._details = details;
				this._detailsError = details ? '' : localize('claudeDiscoverGone', "This plugin is no longer in your marketplaces.");
			}
		} catch (error) {
			if (this._selected === id) {
				this._detailsError = errorMessage(error);
			}
		}
		if (this._selected === id) {
			this.renderView();
		}
	}

	/** The catalog entry, which knows about installs made since the details were read. */
	private plugin(id: string): ClaudePluginEntry | undefined {
		return this._catalog?.plugins.find(plugin => plugin.id === id) ?? (this._details?.plugin.id === id ? this._details.plugin : undefined);
	}

	private renderDetails(container: HTMLElement, id: string): void {
		const bar = append(container, $('.claude-customize-bar'));
		this.button(bar, 'discover.back', 'claude-btn.claude-customize-refresh', localize('claudeDiscoverBack', "Back"), () => this.closeDetails(), this._viewStore, Codicon.arrowLeft);
		const plugin = this.plugin(id);
		if (!plugin) {
			this.note(container, this._detailsError || localize('claudeDiscoverLoadingDetails', "Reading the plugin..."), !!this._detailsError);
			return;
		}
		const details = append(container, $('.claude-discover-details'));
		details.dataset.plugin = plugin.id;
		const head = append(details, $('.claude-settings-card.claude-discover-head'));
		this.paintPluginIcon(append(head, $('.claude-customize-icon.claude-plugin-icon')), plugin);
		void this.loadIcons([plugin]);
		const text = append(head, $('.claude-discover-head-text'));
		append(text, $('h2.claude-discover-title')).textContent = plugin.displayName ?? plugin.name;
		append(text, $('.claude-discover-meta')).textContent = [plugin.author, plugin.marketplace, plugin.version, plugin.category].filter((part): part is string => !!part).join(' · ');
		if (plugin.description) {
			append(text, $('p.claude-discover-description')).textContent = plugin.description;
		}
		const actions = append(head, $('.claude-discover-actions'));
		const homepage = plugin.homepage;
		if (homepage && /^https?:\/\//i.test(homepage)) {
			this.button(actions, 'discover.homepage', 'claude-btn.is-ghost.is-small', localize('claudeDiscoverHomepage', "Homepage"), () => void this._opener.open(URI.parse(homepage), { openExternal: true }), this._viewStore);
		}
		this.renderTry(actions, plugin);
		this.renderActions(actions, plugin, this._viewStore, false);

		const loaded = this._details?.plugin.id === id ? this._details : undefined;
		this.sectionHead(details, localize('claudeDiscoverWhatItAdds', "What It Adds"));
		const contents = loaded?.contents ?? plugin.contents;
		if (!contents) {
			this.note(details, this._detailsError || localize('claudeDiscoverLoadingDetails', "Reading the plugin..."), !!this._detailsError);
		} else {
			this.renderContents(details, contents);
		}
		if (loaded?.readme) {
			this.sectionHead(details, localize('claudeDiscoverReadme', "README"));
			const readme = append(details, $('.claude-settings-card.claude-discover-readme'));
			const rendered = this._viewStore.add(this._markdown.render(new MarkdownString(loaded.readme, { isTrusted: false, supportThemeIcons: false })));
			readme.appendChild(rendered.element);
		}
	}

	/**
	 * Try in a New Session, for a plugin that is not installed. Secondary, so
	 * Install stays the one filled button (DL-09). Restricted Mode shows it
	 * disabled with the reason on hover: there a session loads no plugin.
	 */
	private renderTry(parent: HTMLElement, plugin: ClaudePluginEntry): void {
		if (plugin.installed) {
			return;
		}
		const trusted = this._trust.isWorkspaceTrusted();
		const busy = this._busy.has(`try:${plugin.id}`);
		const label = busy ? localize('claudeDiscoverTrying', "Getting the Plugin...") : localize('claudeDiscoverTry', "Try in a New Session");
		const button = this.button(parent, `discover.try:${plugin.id}`, 'claude-btn.is-secondary.is-small.claude-discover-try', label, () => void this.tryPlugin(plugin), this._viewStore);
		button.disabled = !trusted || busy || this._busy.has(plugin.id);
		if (!trusted) {
			this._viewStore.add(this._hover.setupDelayedHover(button, { content: localize('claudeDiscoverTryUntrusted', "Trust this workspace first. In Restricted Mode a session loads no plugins."), additionalClasses: ['claude-root'] }));
		}
	}

	private renderContents(parent: HTMLElement, contents: ClaudePluginContents): void {
		const card = append(parent, $('.claude-settings-card.claude-discover-contents'));
		const row = (title: string, detail: string, code: boolean) => {
			const element = append(card, $('.claude-settings-row'));
			const text = append(element, $('.claude-settings-row-text'));
			append(text, $('.claude-settings-row-title')).textContent = title;
			const description = append(text, $('.claude-settings-row-description'));
			description.classList.toggle('claude-discover-code', code);
			description.textContent = detail;
			return element;
		};
		const names = (kind: ClaudePluginKind, list: readonly string[]) => {
			if (list.length) {
				row(claudeCustomizeKindLabel(kind), list.join(', '), false).dataset.kind = kind;
			}
		};
		names('skills', contents.skills);
		names('subagents', contents.subagents);
		names('commands', contents.commands);
		for (const hook of contents.hooks) {
			row(hookLabel(hook), hook.command, true).dataset.kind = 'hooks';
		}
		for (const server of contents.mcpServers) {
			row(localize('claudeDiscoverServer', "MCP Server: {0}", server.name), serverCommand(server), true).dataset.kind = 'mcp';
		}
		if (contents.allowedTools.length) {
			row(localize('claudeDiscoverAllowedTools', "Allowed Tools"), contents.allowedTools.join(', '), true).dataset.kind = 'tools';
		}
		if (!card.firstChild) {
			row(localize('claudeDiscoverNothing', "Nothing Klawly Can List"), localize('claudeDiscoverNothingDetail', "The plugin's files declare no skills, subagents, commands, hooks or MCP servers."), false);
		}
		if (!contents.complete) {
			const note = append(card, $('.claude-settings-row.is-note'));
			append(note, $('.claude-settings-row-description')).textContent = localize('claudeDiscoverIncomplete', "Klawly could not read all of this plugin's files, so this list may be short.");
		}
	}

	//#endregion

	//#region Commands

	/** The local folder `claude plugin` runs in, so project and local scopes land in this project. */
	private projectCwd(): string | undefined {
		const folder = this._workspace.getWorkspace().folders[0];
		return folder?.uri.scheme === Schemas.file ? folder.uri.fsPath : undefined;
	}

	/** What the plugin adds, for the install and try dialogs. Undefined when it cannot be read. */
	private async readContents(plugin: ClaudePluginEntry): Promise<ClaudePluginContents | undefined> {
		const contents = this._details?.plugin.id === plugin.id ? this._details.contents : plugin.contents;
		if (contents) {
			return contents;
		}
		try {
			return (await this._plugins.getDetails(plugin.id, this.request()))?.contents;
		} catch {
			// The dialog says the plugin could not be read.
			return undefined;
		}
	}

	private async install(plugin: ClaudePluginEntry): Promise<void> {
		const contents = await this.readContents(plugin);
		const cwd = this.projectCwd();
		const buttons: IPromptButton<ClaudePluginScope | undefined>[] = [{ label: localize('claudeDiscoverInstallUser', "Install for You"), run: () => 'user' }];
		// A project install writes into the folder, so only a trusted folder gets one.
		if (cwd && this._trust.isWorkspaceTrusted()) {
			buttons.push({ label: localize('claudeDiscoverInstallProject', "Install in This Project"), run: () => 'project' });
			// `--scope local`: this project only, kept out of the shared settings file.
			buttons.push({ label: localize('claudeDiscoverInstallLocal', "Install for You in This Project"), run: () => 'local' });
		}
		const { result } = await this._dialogs.prompt<ClaudePluginScope | undefined>({
			type: 'info',
			message: localize('claudeDiscoverInstallConfirm', "Install {0}?", plugin.name),
			detail: installDetail(plugin, contents),
			buttons,
			cancelButton: { run: () => undefined },
		});
		const scope = await result;
		if (!scope) {
			return;
		}
		const marketplace = this._catalog?.marketplaces.find(entry => entry.name === plugin.marketplace);
		// A marketplace the project declares is added first, at the scope it is declared in.
		if (marketplace && !marketplace.added && !marketplace.builtIn && marketplace.declaredIn && !await this.addKnownMarketplace(marketplace)) {
			return;
		}
		// A marketplace only on Klawly's built-in list is added by the same command.
		const command: ClaudePluginCommand = marketplace && !marketplace.added && marketplace.builtIn
			? { action: 'install', plugin: plugin.name, scope, marketplaceSource: marketplace.source, cwd: scope === 'user' ? undefined : cwd }
			: { action: 'install', plugin: plugin.id, scope, cwd: scope === 'user' ? undefined : cwd };
		await this.runCommand(plugin.id, command, localize('claudeDiscoverInstalledNote', "{0} is installed. Sessions you start from now on load it; restart a running session to use it there.", plugin.name));
	}

	/**
	 * Try in a New Session: names every hook and MCP server first, as Install
	 * does, then opens a new chat whose queries load the plugin's folder without
	 * installing it (the SDK's local plugins). Claude Code's own plugins stay as
	 * they are.
	 */
	private async tryPlugin(plugin: ClaudePluginEntry): Promise<void> {
		if (!this._trust.isWorkspaceTrusted()) {
			return;
		}
		const contents = await this.readContents(plugin);
		const { confirmed } = await this._dialogs.confirm({
			type: 'info',
			message: localize('claudeDiscoverTryConfirm', "Try {0} in a new session?", plugin.name),
			detail: installDetail(plugin, contents),
			primaryButton: localize({ key: 'claudeDiscoverTryButton', comment: ['&& denotes a mnemonic'] }, "&&Try in a New Session"),
		});
		if (!confirmed) {
			return;
		}
		const key = `try:${plugin.id}`;
		this._busy.add(key);
		this.redraw();
		try {
			const folder = await this._plugins.preparePluginTrial(plugin.id, this.request());
			if (!folder) {
				this._notifications.error(localize('claudeDiscoverTryFailed', "Klawly could not get the files of {0}, so it cannot try it. Install it to use it.", plugin.name));
				return;
			}
			this._agent.createSession({ plugins: [folder] });
			this._host.openChat();
		} catch (error) {
			this._notifications.error(errorMessage(error));
		} finally {
			this._busy.delete(key);
			this.redraw();
		}
	}

	private async updatePlugin(plugin: ClaudePluginEntry): Promise<void> {
		const scope = plugin.installed?.scope;
		await this.runCommand(plugin.id, {
			action: 'update',
			plugin: plugin.id,
			scope: scope === 'user' || scope === 'project' || scope === 'local' ? scope : undefined,
			cwd: scope === 'user' ? undefined : this.projectCwd(),
		}, localize('claudeDiscoverUpdatedNote', "{0} is updated. Restart a running session to use the new version there.", plugin.name));
	}

	private async uninstall(plugin: ClaudePluginEntry): Promise<void> {
		const scope = plugin.installed?.scope;
		if (scope !== 'user' && scope !== 'project' && scope !== 'local') {
			return;
		}
		const { confirmed } = await this._dialogs.confirm({
			type: 'warning',
			message: localize('claudeDiscoverRemoveConfirm', "Remove {0}?", plugin.name),
			detail: localize('claudeDiscoverRemoveDetail', "Claude Code removes the plugin and the skills, subagents, commands, hooks and MCP servers it adds. Running sessions keep them until they restart."),
			primaryButton: localize({ key: 'claudeDiscoverRemoveButton', comment: ['&& denotes a mnemonic'] }, "&&Remove"),
		});
		if (!confirmed) {
			return;
		}
		await this.runCommand(plugin.id, { action: 'uninstall', plugin: plugin.id, scope, cwd: scope === 'user' ? undefined : this.projectCwd() }, localize('claudeDiscoverRemovedNote', "{0} is removed.", plugin.name));
	}

	private async addMarketplace(): Promise<void> {
		const source = (await this._quickInput.input({
			title: localize('claudeDiscoverAddMarketplaceTitle', "Add Marketplace"),
			prompt: localize('claudeDiscoverAddMarketplacePrompt', "A GitHub owner/repo, a Git URL, or a folder with .claude-plugin/marketplace.json. Claude Code adds it."),
			placeHolder: 'owner/repo',
			validateInput: async value => value.trim().startsWith('-') ? localize('claudeDiscoverAddMarketplaceInvalid', "A marketplace source cannot start with a dash.") : undefined,
		}))?.trim();
		if (!source) {
			return;
		}
		await this.runCommand(`marketplace:${source}`, { action: 'addMarketplace', source, cwd: this.projectCwd() }, localize('claudeDiscoverMarketplaceAddedSource', "Claude Code added the marketplace {0}.", source));
	}

	/**
	 * Adds a listed marketplace Claude Code does not have yet, at the scope the project declares it in.
	 * Claude Code cannot write the organization's managed settings, so a managed one is added for the user (issue 523).
	 */
	private addKnownMarketplace(marketplace: ClaudeMarketplaceInfo): Promise<boolean> {
		const scope = marketplace.declaredIn === 'project' || marketplace.declaredIn === 'local' ? marketplace.declaredIn : undefined;
		const cwd = scope ? this.projectCwd() : undefined;
		return this.runCommand(`marketplace:${marketplace.name}`, { action: 'addMarketplace', source: marketplace.source, scope: cwd ? scope : undefined, cwd }, localize('claudeDiscoverMarketplaceAdded', "Claude Code now has the {0} marketplace.", marketplace.name));
	}

	private async removeMarketplace(marketplace: ClaudeMarketplaceInfo): Promise<void> {
		const { confirmed } = await this._dialogs.confirm({
			type: 'warning',
			message: localize('claudeDiscoverRemoveMarketplaceConfirm', "Remove the {0} marketplace?", marketplace.name),
			detail: localize('claudeDiscoverRemoveMarketplaceDetail', "Claude Code stops listing its plugins. Claude Code decides what happens to plugins you installed from it."),
			primaryButton: localize({ key: 'claudeDiscoverRemoveButton', comment: ['&& denotes a mnemonic'] }, "&&Remove"),
		});
		if (!confirmed) {
			return;
		}
		await this.runCommand(`marketplace:${marketplace.name}`, { action: 'removeMarketplace', name: marketplace.name }, localize('claudeDiscoverMarketplaceRemoved', "Claude Code removed the {0} marketplace.", marketplace.name));
	}

	/**
	 * Runs one `claude plugin` command. When the marketplace declares a command
	 * that runs at install, it is shown first and runs only after a yes.
	 */
	private async runCommand(key: string, command: ClaudePluginCommand, done: string): Promise<boolean> {
		this._busy.add(key);
		this.redraw();
		try {
			let result = await this._plugins.run(command);
			if (result.outcome === 'confirm' && result.shownCommand && (command.action === 'install' || command.action === 'update')) {
				const { confirmed } = await this._dialogs.confirm({
					type: 'warning',
					message: localize('claudeDiscoverShownCommand', "The marketplace runs this command to install the plugin"),
					detail: result.shownCommand.archiveUrl
						? localize('claudeDiscoverShownCommandArchive', "{0}\n\nIt runs from {1}.", result.shownCommand.command, result.shownCommand.archiveUrl)
						: result.shownCommand.command,
					primaryButton: localize({ key: 'claudeDiscoverRunAndInstall', comment: ['&& denotes a mnemonic'] }, "&&Run and Install"),
				});
				if (!confirmed) {
					return false;
				}
				result = await this._plugins.run({ ...command, acceptCommand: result.shownCommand.sha256 });
			}
			if (result.outcome !== 'done') {
				this._notifications.error(redactSecrets(result.message));
				return false;
			}
			this._notifications.info(done);
			if (command.action === 'install' || command.action === 'update' || command.action === 'uninstall') {
				// Klawly ran the command, so it tells each chat whose Claude Code query runs; no CLI event is needed.
				this._agent.notePluginChange(command.plugin.replace(/@.*$/, ''), command.action === 'uninstall');
			}
			this._host.changed();
			await this.load(true);
			return true;
		} catch (error) {
			this._notifications.error(errorMessage(error));
			return false;
		} finally {
			this._busy.delete(key);
			this.redraw();
		}
	}

	//#endregion
}
