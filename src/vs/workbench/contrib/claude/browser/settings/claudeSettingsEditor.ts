/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, clearNode, Dimension, DisposableResizeObserver, EventType, getActiveElement, getWindow, isHTMLElement } from '../../../../../base/browser/dom.js';
import { StandardKeyboardEvent } from '../../../../../base/browser/keyboardEvent.js';
import { AnchorAlignment, AnchorPosition } from '../../../../../base/browser/ui/contextview/contextview.js';
import { DomScrollableElement } from '../../../../../base/browser/ui/scrollbar/scrollableElement.js';
import { IntervalTimer } from '../../../../../base/common/async.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { KeyCode, KeyMod } from '../../../../../base/common/keyCodes.js';
import { fromNow } from '../../../../../base/common/date.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../../base/common/network.js';
import { OS } from '../../../../../base/common/platform.js';
import { joinPath } from '../../../../../base/common/resources.js';
import { ScrollbarVisibility } from '../../../../../base/common/scrollable.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { URI } from '../../../../../base/common/uri.js';
import Severity from '../../../../../base/common/severity.js';
import { localize } from '../../../../../nls.js';
import { ClaudeModelInfo, ClaudeRuntimeState, IClaudeRuntimeService } from '../../../../../platform/claude/common/claude.js';
import { ClaudeAccountEntry } from '../../../../../platform/claude/common/claudeAccounts.js';
import { ClaudeAccountOverview, ClaudeMcpServerState, ClaudeUsageRefresh, ClaudeUsageWindow } from '../../../../../platform/claude/common/claudeAccount.js';
import { CLAUDE_AUTOMATION_DEFAULT_MAX_TURNS, claudeAutomationKey, ClaudeAutomationRunState, ClaudeAutomationScope, ClaudeAutomationTriggerType } from '../../../../../platform/claude/common/claudeAutomation.js';
import { AgentMode } from '../../../../../platform/claude/common/claudeContext.js';
import { CLAUDE_CONFIGURABLE_EFFORT_LEVELS, CLAUDE_INSTRUCTIONS_AGENTS_MD_SETTING, CLAUDE_MODELS_CUSTOM_SETTING, CLAUDE_MODELS_DEFAULT_SETTING, CLAUDE_MODELS_EFFORT_SETTING, CLAUDE_MODELS_ENABLED_SETTING, readClaudeModelId } from '../../../../../platform/claude/common/claudeConfiguration.js';
import { addClaudeHook, CLAUDE_HOOK_EVENTS, CLAUDE_HOOK_SCOPES, CLAUDE_SETTINGS_FILES, ClaudeHookEntry, ClaudeHookScope, claudeHookTakesMatcher, isClaudeHookCommand, readClaudeHooks, removeClaudeHook } from '../../../../../platform/claude/common/claudeHooks.js';
import { hasKey } from '../../../../../base/common/types.js';
import { addClaudePermissionRule, ClaudePermissionEffect, ClaudePermissionRule, isClaudePermissionRule, readClaudePermissionRules, removeClaudePermissionRule } from '../../../../../platform/claude/common/claudePermissionRules.js';
import { addClaudeNetworkRule, ClaudeNetworkEffect, ClaudeNetworkRule, isClaudeNetworkDomain, readClaudeNetworkRules, removeClaudeNetworkRule } from '../../../../../platform/claude/common/claudeNetworkRules.js';
import { ClaudeSandboxStatus } from '../../../../../platform/claude/common/claudeSecuritySettings.js';
import { CLAUDE_USE_CLAUDE_CODE_SETUP_SETTING, CLAUDE_USER_LAYER_FILES, CLAUDE_USER_LAYER_FOLDER, claudeUserLayerLabel } from '../../../../../platform/claude/common/claudeUserLayer.js';
import { CLAUDE_MANAGED_MEMORY_FILE, CLAUDE_MANAGED_SETTINGS_FILE, claudeManagedDirectory } from '../../../../../platform/claude/common/claudeManagedFiles.js';
import { ClaudeMcpAddRequest, ClaudeMcpScope, claudeMcpServerConfig, ClaudeMcpTransport, isClaudeMcpServerName } from '../../../../../platform/claude/common/claudeMcpConfig.js';
import { enabledClaudeModelsSetting, isClaudeModelEnabled, pickableClaudeModels, readClaudeModelIdList } from '../../../../../platform/claude/common/claudeModels.js';
import { ClaudeInstalledPlugin, IClaudePluginService } from '../../../../../platform/claude/common/claudePlugins.js';
import { IClipboardService } from '../../../../../platform/clipboard/common/clipboardService.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { ConfigurationTarget, IConfigurationService, isConfigured } from '../../../../../platform/configuration/common/configuration.js';
import { IContextViewService } from '../../../../../platform/contextview/browser/contextView.js';
import { IDialogService, IFileDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { IEditorOptions } from '../../../../../platform/editor/common/editor.js';
import { FileOperationError, FileOperationResult, IFileService, IWriteFileOptions } from '../../../../../platform/files/common/files.js';
import { IHoverService } from '../../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../../platform/telemetry/common/telemetry.js';
import { ProgressBar } from '../../../../../base/browser/ui/progressbar/progressbar.js';
import { defaultProgressBarStyles } from '../../../../../platform/theme/browser/defaultStyles.js';
import { IUpdateService } from '../../../../../platform/update/common/update.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { CLAUDE_REVIEW_CONFIG_FILE_DEFAULT, CLAUDE_REVIEW_CONFIG_FILE_SETTING, readClaudeReviewConfigFile } from '../../../../../platform/claude/common/claudeReviewConfig.js';
import { CLAUDE_REVIEW_STAT_PERIODS, CLAUDE_REVIEW_STATS_STORAGE_KEY, ClaudeReviewStatCounts, ClaudeReviewStatPeriod, claudeReviewStatsCsv, summarizeClaudeReviewStats } from '../../../../../platform/claude/common/claudeReviewStats.js';
import { deserializeReviewStats } from '../../../../services/claude/common/claudeReviewPersist.js';
import { CLAUDE_REVIEW_LEARN_AFTER_SETTING, claudeReviewCategoryLabel, listLearnedClaudeReviewRules, readClaudeLearnAfter, removeLearnedClaudeReviewRule } from '../../../../../platform/claude/common/claudeReviewLearning.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { EditorPane } from '../../../../browser/parts/editor/editorPane.js';
import { IEditorOpenContext } from '../../../../common/editor.js';
import { EditorInput } from '../../../../common/editor/editorInput.js';
import { redactSecrets } from '../../../../services/claude/common/claudeAgentLog.js';
import { ClaudeAutomationView, IClaudeAutomationService } from '../../../../services/claude/common/claudeAutomationService.js';
import { IClaudeExtensionAgentService } from '../../../../services/claude/common/claudeExtensionAgentService.js';
import { IKlawlyAccountService, KLAWLY_GITHUB_SIGN_IN_COMMAND_ID, KLAWLY_GITHUB_SIGN_OUT_COMMAND_ID } from '../../../../services/claude/common/klawlyAccount.js';
import { IEditorGroup } from '../../../../services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IHostService } from '../../../../services/host/browser/host.js';
import { IProductService } from '../../../../../platform/product/common/productService.js';
import { IPathService } from '../../../../services/path/common/pathService.js';
import { CLAUDE_AUTOMATION_PULL_REQUEST_CHOICES, CLAUDE_AUTOMATION_TRIGGER_TYPES, ClaudeAutomationDraft, claudeAutomationDraft, claudeAutomationIdFor, claudeAutomationOfDraft, claudeAutomationPullRequestChoiceLabel, ClaudeAutomationPullRequestChoice, claudeAutomationRunStateLabel, claudeAutomationTriggerDescription, claudeAutomationTriggerIcon, claudeAutomationTriggerLabel, claudeAutomationTriggerSummary, emptyClaudeAutomationDraft, isClaudeAutomationDraftError } from '../../common/claudeAutomationDraft.js';
import { CLAUDE_REVIEW_SUMMARY_SETTING, readClaudeReviewSummaryMode } from '../../../../../platform/claude/common/claudeReviewLoop.js';
import { CLAUDE_REVIEW_DEPTH_SETTING, readClaudeReviewDepthSetting } from '../../../../../platform/claude/common/claudeReviewDepth.js';
import { ClaudeAutomationTemplateId, claudeAutomationTemplateDraft, claudeAutomationTemplates } from '../../common/claudeAutomationTemplates.js';
import { claudeEffortLabel, claudeModelName } from '../../common/claudeModelControls.js';
import { claudePrivacyAccount } from '../../common/claudePrivacy.js';
import { claudeAccountActions, claudeShownAccount } from '../../common/claudeAccountActions.js';
import { claudeAccountsUsageRows, ClaudeKnownUsageByAccount, readClaudeKnownUsage, withClaudeKnownUsage } from '../../common/claudeAccountsUsage.js';
import { claudeAccountSummary, CLAUDE_CUSTOMIZE_KINDS, ClaudeCopySource, ClaudeCustomizeItem, ClaudeCustomizeKind, claudeCustomizeItems, claudeCustomizeKindLabel, ClaudeCustomizeSource, claudeMcpKey, ClaudeMemoryFile, claudePlanLabel, claudeSandboxStatusBadge, claudeSandboxStatusText, claudeSettingsPages, ClaudeSettingsControl, ClaudeSettingsOption, ClaudeSettingsPage, ClaudeSettingsPageId, ClaudeSettingsRow, ClaudeSettingsSection, claudeUsageWindowNote, claudeUsageWindowTitle, claudeWhereLabel, claudeSettingsSearchHint, searchClaudeSettings } from '../../common/claudeSettingsPages.js';
import { ClaudeUpdateRow, claudeUpdateRow, claudeVersionCopyText, claudeVersionRow } from '../../common/claudeVersionUpdates.js';
import { claudeUsageState, claudeUsageUpdatedLabel } from '../../common/claudeUsageRow.js';
import { CLAUDE_FOCUS_AGENT_COMMAND_ID, CLAUDE_LOG_OUT_COMMAND_ID, CLAUDE_SWITCH_ACCOUNT_COMMAND_ID } from '../../common/claudeViews.js';
import { ClaudePopoverMenu } from '../widgets/claudePopoverMenu.js';
import { ClaudeCustomizeDiscover } from './claudeCustomizeDiscover.js';
import { ClaudeCodeImporter, ClaudeImportEntry } from './claudeCodeImporter.js';
import { ClaudeCustomizeFiles } from './claudeCustomizeFiles.js';
import { IFilesConfigurationService } from '../../../../services/filesConfiguration/common/filesConfigurationService.js';
import { ClaudeCreateDraft, ClaudeCreateKind, ClaudeCreateScope, claudeCreateAddLabel, claudeCreateNeedsDescription, claudeCreatePathLabel, CLAUDE_SUBAGENT_INHERIT_MODEL, emptyClaudeCreateDraft, isClaudeCreateKind, isClaudeCreateName } from '../../common/claudeCustomizeCreate.js';
import { ClaudeSettingsEditorInput, IClaudeSettingsEditorOptions } from './claudeSettingsEditorInput.js';
import { CLAUDE_MCP_LOG_CHANNEL_ID, ClaudeMcpControlAction } from '../../../../../platform/claude/common/claudeMcpControl.js';
import { IOutputService } from '../../../../services/output/common/output.js';

/** Where the plan limits last seen for each account are kept (issue 1182). */
const CLAUDE_ACCOUNTS_USAGE_STORAGE_KEY = 'klawly.claude.accountsUsage';

/** Below this width the nav folds to a rail of page icons (ide-28). */
const NARROW_WIDTH = 720;
/** Below this card width a row's control moves under its text. */
const STACK_WIDTH = 360;
/** Where a Claude subscriber changes their plan. */
const CLAUDE_PLAN_URL = 'https://claude.ai/settings/billing';
/** How often Plan & Usage asks for the plan limits while it shows and the window has focus (issue 704). */
const PLAN_POLL_MS = 60_000;

/** The memory files Claude Code reads in each workspace folder, and their scope. */
const PROJECT_MEMORY: readonly [string, ClaudeMemoryFile['scope']][] = [['CLAUDE.md', 'project'], ['.claude/CLAUDE.md', 'project'], ['CLAUDE.local.md', 'local'], ['AGENTS.md', 'agents']];

const CUSTOMIZE_ICONS: Record<ClaudeCustomizeKind, ThemeIcon> = {
	mcp: Codicon.server,
	skills: Codicon.lightbulb,
	subagents: Codicon.robot,
	commands: Codicon.terminal,
	hooks: Codicon.zap,
	network: Codicon.globe,
	permissions: Codicon.shield,
	memory: Codicon.book,
	rules: Codicon.checklist,
};

const AUTOMATION_STATE_CLASSES: Record<ClaudeAutomationRunState, string> = {
	running: 'is-running',
	needsYou: 'is-warning',
	complete: 'is-success',
	failed: 'is-error',
	stopped: 'is-idle',
};

/** The automation form's key while it adds one. */
const NEW_AUTOMATION = 'new';

/** The add forms Customize shows. */
type ClaudeCustomizeForm = 'mcp' | 'hooks' | 'network' | 'permissions' | ClaudeCreateKind;

interface McpDraft {
	name: string;
	scope: ClaudeMcpScope;
	transport: ClaudeMcpTransport;
	target: string;
}

interface HookDraft {
	event: string;
	matcher: string;
	command: string;
	scope: ClaudeHookScope;
}

interface NetworkDraft {
	domain: string;
	effect: ClaudeNetworkEffect;
	scope: ClaudeHookScope;
}

interface PermissionDraft {
	rule: string;
	effect: ClaudePermissionEffect;
	scope: ClaudeHookScope;
}

function emptyPermissionDraft(): PermissionDraft {
	return { rule: '', effect: 'deny', scope: 'project' };
}

function emptyMcpDraft(): McpDraft {
	return { name: '', scope: 'user', transport: 'stdio', target: '' };
}

function emptyHookDraft(): HookDraft {
	return { event: CLAUDE_HOOK_EVENTS[0], matcher: '', command: '', scope: 'project' };
}

function emptyNetworkDraft(): NetworkDraft {
	return { domain: '', effect: 'allow', scope: 'project' };
}

function errorMessage(error: unknown): string {
	return redactSecrets(error instanceof Error ? error.message : String(error));
}

/**
 * The Klawly settings as an editor: a nav of pages on the left (an account
 * block, a search box and the pages), and cards of setting rows on the right.
 * Every control reads and writes a `claude.*` setting in the user settings, so
 * the classic settings editor and settings.json always agree with it.
 */
export class ClaudeSettingsEditor extends EditorPane {

	static readonly ID = ClaudeSettingsEditorInput.EDITOR_ID;

	private readonly _pages: readonly ClaudeSettingsPage[] = claudeSettingsPages();
	private readonly _renderStore = this._register(new DisposableStore());
	private readonly _navStore = this._register(new DisposableStore());
	private readonly _accountStore = this._register(new DisposableStore());
	private readonly _modelRowStore = this._register(new DisposableStore());
	private readonly _customizeStore = this._register(new DisposableStore());
	private readonly _automationFormStore = this._register(new DisposableStore());
	private readonly _automationItemsStore = this._register(new DisposableStore());
	private readonly _menu: ClaudePopoverMenu;
	/** Rendered controls by a stable key, so focus returns to the same control after a re-render. */
	private readonly _focusables = new Map<string, HTMLElement>();
	private readonly _navButtons = new Map<ClaudeSettingsPageId, HTMLButtonElement>();

	private _root!: HTMLElement;
	private _nav!: HTMLElement;
	private _account!: HTMLElement;
	private _profileBlock!: HTMLElement;
	private _pageList!: HTMLElement;
	private _search!: HTMLInputElement;
	private _searchSlot!: HTMLElement;
	private _navSearchSlot!: HTMLElement;
	private _content!: HTMLElement;
	private _scrollable!: DomScrollableElement;
	private _modelRows: HTMLElement | undefined;
	private _customizeList: HTMLElement | undefined;
	private _automationCount: HTMLElement | undefined;
	private _automationAdd: HTMLButtonElement | undefined;
	private _automationFormSlot: HTMLElement | undefined;
	private _automationItemsSlot: HTMLElement | undefined;
	/** The automation the form edits, by key, or `NEW_AUTOMATION`; undefined while it is closed. */
	private _automationForm: string | undefined;
	private _automationDraft = emptyClaudeAutomationDraft('workspace');
	/** The template a new automation's form started from (issue 506). */
	private _automationTemplate: ClaudeAutomationTemplateId = 'blank';
	private _automationError = '';
	/** The memory as read when the form opened: Save writes it only when changed. */
	private _automationMemory: string | undefined;
	private _automationBusy = false;

	private _page: ClaudeSettingsPageId = 'general';
	private _query = '';
	private _modelFilter = '';
	private _models: readonly ClaudeModelInfo[] | undefined;
	private _runtimeState: ClaudeRuntimeState | undefined;
	private _overview: ClaudeAccountOverview | undefined;
	/** The ask for the plan limits that is running, and how many have started, so an old answer cannot replace a newer one (issue 942). */
	private _usageLoading = false;
	private _usageAsks = 0;
	private _memory: readonly ClaudeMemoryFile[] = [];
	/** Installed Claude Code plugins, so Customize rows say which plugin they come from. */
	private _installedPlugins: readonly ClaudeInstalledPlugin[] = [];
	private readonly _memoryFiles = new Map<string, URI>();
	private _customizeKind: ClaudeCustomizeKind | undefined;
	/** Customize's tab on show: what Claude Code loaded, or plugins to install. */
	private _customizeTab: 'installed' | 'discover' = 'installed';
	private _discover: ClaudeCustomizeDiscover | undefined;
	private _customizeQuery = '';
	private _hooks: readonly ClaudeHookEntry[] = [];
	/** Each hook scope's settings file, whether or not it exists yet. */
	private readonly _hookFiles = new Map<ClaudeHookScope, URI>();
	/** The domains the same settings files allow or deny. */
	private _networkRules: readonly ClaudeNetworkRule[] = [];
	/** What Claude Code's own `~/.claude/settings.json` holds, listed while Klawly reads it (issue 455). */
	private _claudeCodeHooks: readonly ClaudeHookEntry[] = [];
	private _claudeCodeNetworkRules: readonly ClaudeNetworkRule[] = [];
	private _permissionRules: readonly ClaudePermissionRule[] = [];
	private _claudeCodePermissionRules: readonly ClaudePermissionRule[] = [];
	/** Whether Claude Code's sandbox can start on this machine; undefined when the runtime cannot tell. */
	private _sandboxStatus: ClaudeSandboxStatus | undefined;
	/** Servers added here; each shows until a session reports it. */
	private _addedMcp: readonly ClaudeMcpAddRequest[] = [];
	private readonly _removedMcp = new Set<string>();
	/** The Add Server, Add Hook or Add Domain form on show. */
	private _form: ClaudeCustomizeForm | undefined;
	private _mcpDraft = emptyMcpDraft();
	private _hookDraft = emptyHookDraft();
	private _networkDraft = emptyNetworkDraft();
	private _permissionDraft = emptyPermissionDraft();
	/** The Add Skill, Add Subagent, Add Command and Add Rule forms' fields (issue 500). */
	private _createDraft: ClaudeCreateDraft = emptyClaudeCreateDraft('project');
	private readonly _createFiles: ClaudeCustomizeFiles;
	private _formError = '';
	private _formBusy = false;
	private _narrow = false;
	private _updateRow: ClaudeUpdateRow | undefined;

	private readonly _reviewStorage: IStorageService;
	/** The signed-in accounts and their last-seen plan limits, for the all-accounts view on Plan & Usage (issue 1182). */
	private _accountList: readonly ClaudeAccountEntry[] = [];
	private _knownUsage: ClaudeKnownUsageByAccount = {};
	private _statsPeriod: ClaudeReviewStatPeriod = '30d';

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IConfigurationService private readonly _configuration: IConfigurationService,
		@IClaudeRuntimeService private readonly _runtime: IClaudeRuntimeService,
		@ICommandService private readonly _commands: ICommandService,
		@IContextViewService contextView: IContextViewService,
		@IHoverService private readonly _hover: IHoverService,
		@INotificationService private readonly _notifications: INotificationService,
		@IOutputService private readonly _output: IOutputService,
		@IOpenerService private readonly _opener: IOpenerService,
		@IEditorService private readonly _editors: IEditorService,
		@IFileService private readonly _files: IFileService,
		@IPathService private readonly _paths: IPathService,
		@IWorkspaceContextService private readonly _workspace: IWorkspaceContextService,
		@IDialogService private readonly _dialogs: IDialogService,
		@IFileDialogService private readonly _fileDialogs: IFileDialogService,
		@IInstantiationService private readonly _instantiation: IInstantiationService,
		@IClaudePluginService private readonly _plugins: IClaudePluginService,
		@IClaudeAutomationService private readonly _automations: IClaudeAutomationService,
		@IKlawlyAccountService private readonly _profile: IKlawlyAccountService,
		@IHostService private readonly _host: IHostService,
		@IProductService private readonly _product: IProductService,
		@IUpdateService private readonly _updates: IUpdateService,
		@IClipboardService private readonly _clipboard: IClipboardService,
		@IFilesConfigurationService private readonly _filesConfiguration: IFilesConfigurationService,
		@IClaudeExtensionAgentService private readonly _extensionAgents: IClaudeExtensionAgentService,
	) {
		super(ClaudeSettingsEditor.ID, group, telemetryService, themeService, storageService);
		this._reviewStorage = storageService;
		this._menu = this._register(new ClaudePopoverMenu(contextView, _hover));
		this._createFiles = _instantiation.createInstance(ClaudeCustomizeFiles);
	}

	/** The page on show, or undefined while search results show. */
	get page(): ClaudeSettingsPageId | undefined {
		return this._query ? undefined : this._page;
	}

	get narrow(): boolean {
		return this._narrow;
	}

	/** The height the page shows and the height it scrolls through. */
	get scrollSize(): { height: number; scrollHeight: number } {
		const { height, scrollHeight } = this._scrollable.getScrollDimensions();
		return { height, scrollHeight };
	}

	/** The observer constructor behind the page's scroll size; a test returns a fake it fires as the browser would. */
	protected resizeObserverCtor(): typeof ResizeObserver | undefined {
		return undefined;
	}

	protected createEditor(parent: HTMLElement): void {
		this._root = append(parent, $('.claude-root.claude-settings'));
		this._nav = append(this._root, $('nav.claude-settings-nav'));
		this._nav.setAttribute('aria-label', localize('claudeSettingsNav', "Settings Pages"));
		// Issue 446, DL-69: who you are (the GitHub profile) first, the Claude sign-in a smaller row under it.
		const accounts = append(this._nav, $('.claude-settings-accounts'));
		this._profileBlock = append(accounts, $('.claude-settings-profile'));
		this._account = append(accounts, $('.claude-settings-account'));
		this._navSearchSlot = append(this._nav, $('.claude-settings-search-slot'));
		this._search = append(this._navSearchSlot, $<HTMLInputElement>('input.claude-field.claude-settings-search'));
		this._search.type = 'search';
		this._search.placeholder = localize('claudeSettingsSearch', "Search settings");
		this._search.setAttribute('aria-label', localize('claudeSettingsSearchLabel', "Search Settings"));
		this._register(addDisposableListener(this._search, EventType.INPUT, () => this.search(this._search.value)));
		this._register(addDisposableListener(this._search, EventType.KEY_DOWN, event => {
			if (event.key === 'Escape' && this._search.value) {
				event.preventDefault();
				event.stopPropagation();
				this.search('');
			}
		}));
		this._pageList = append(this._nav, $('.claude-settings-pages'));
		this.renderNav();

		const main = append(this._root, $('.claude-settings-main'));
		this._searchSlot = append(main, $('.claude-settings-search-slot.is-top'));
		const body = $('.claude-settings-body');
		this._content = append(body, $('.claude-settings-content'));
		this._scrollable = this._register(new DomScrollableElement(body, {
			horizontal: ScrollbarVisibility.Hidden,
			vertical: ScrollbarVisibility.Auto,
			consumeMouseWheelIfScrollbarIsNeeded: true,
		}));
		append(main, this._scrollable.getDomNode());
		// Rows fill in after a render (sandbox status, usage, models) and sections expand: rescan whenever the page changes size (issue 533).
		const resizes = this._register(new DisposableResizeObserver('claudeSettingsScroll', () => this._scrollable.scanDomNode(), getWindow(parent), { resizeObserverCtor: this.resizeObserverCtor() }));
		this._register(resizes.observe(this._content));

		this._register(addDisposableListener(this._root, EventType.KEY_DOWN, event => {
			const keyboard = new StandardKeyboardEvent(event);
			if (keyboard.equals(KeyMod.CtrlCmd | KeyCode.KeyF)) {
				keyboard.preventDefault();
				keyboard.stopPropagation();
				this._search.focus();
				this._search.select();
			}
		}));
		this._register(this._configuration.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(CLAUDE_USE_CLAUDE_CODE_SETUP_SETTING)) {
				// Customize lists ~/.claude only while Klawly reads it (issue 455).
				void Promise.all([this.findMemory(), this.findHooks()]).then(() => this.render());
			} else if (event.affectsConfiguration('claude')) {
				this.render();
			}
		}));
		this._register(this._runtime.onDidChangeRuntimeState(state => {
			// A log out or a new sign-in changes who the account is (issue 536).
			// Issue 942: so does a switch between two signed-in accounts, which leaves `authenticated` as it was. The old account's overview goes at once and the new one's is asked for.
			this._runtimeState = state;
			this._overview = this._overview && { live: this._overview.live, mcpServers: this._overview.mcpServers, commands: this._overview.commands, agents: this._overview.agents };
			this.renderAccount();
			this.render();
			void this.refreshOverview('now');
		}));
		this._register(this._automations.onDidChange(() => this.renderAutomationItems()));
		this._register(this._updates.onStateChange(state => {
			// Issue 833: the update row follows the service; progress ticks that read the same do not redraw the page.
			const row = claudeUpdateRow(state);
			const previous = this._updateRow;
			this._updateRow = row;
			if (!previous || previous.status !== row.status || previous.button !== row.button || previous.action !== row.action || previous.progress !== row.progress) {
				this.render();
			}
		}));
		this._register(this._profile.onDidChangeAccount(() => {
			this.renderAccount();
			this.render();
		}));
		this._register(this._runtime.onDidEmitEvent(event => {
			// A session that just listed its catalog can answer for the account and its MCP servers.
			if (event.type === 'session.catalog') {
				void this.refreshOverview();
			}
			// A session reports its plan limits after each turn (issue 704).
			if (event.type === 'session.usageLimits') {
				this._overview = { ...this._overview, live: this._overview?.live ?? true, usage: event.windows, usageCheckedAt: Date.now(), usageFailed: false };
				if (this.page === 'plan') {
					this.render();
				}
			}
		}));
		// Issue 704: Plan & Usage stays current while it shows. It asks again when the
		// window gets focus back and every minute while it has focus; the runtime
		// reuses what it read in the last minute, so this never piles up calls.
		this._register(this._host.onDidChangeFocus(focused => {
			if (focused && this.showsPlan()) {
				void this.refreshUsage();
			}
		}));
		const poll = this._register(new IntervalTimer());
		poll.cancelAndSet(() => {
			if (this.showsPlan() && this._host.hasFocus) {
				void this.refreshUsage();
			}
		}, PLAN_POLL_MS);
	}

	private showsPlan(): boolean {
		return this.isVisible() && this.page === 'plan';
	}

	override async setInput(input: EditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		if (token.isCancellationRequested) {
			return;
		}
		this.applyOptions(options);
		this.render();
		void this.refreshRuntime();
	}

	override setOptions(options: IEditorOptions | undefined): void {
		super.setOptions(options);
		this.applyOptions(options);
		this.render();
	}

	override clearInput(): void {
		this._menu.close();
		super.clearInput();
	}

	override layout(dimension: Dimension): void {
		const narrow = dimension.width < NARROW_WIDTH;
		if (narrow !== this._narrow) {
			this._narrow = narrow;
			this._root.classList.toggle('is-narrow', narrow);
			// The rail has no room for the search box: it moves above the content.
			append(narrow ? this._searchSlot : this._navSearchSlot, this._search);
			this.renderNav();
		}
		// The nav (248) and the content padding (96), or the rail and its smaller padding when narrow.
		const cardWidth = Math.min(776, dimension.width - (narrow ? 64 : 344));
		this._root.classList.toggle('is-stacked', cardWidth < STACK_WIDTH);
		const top = narrow ? this._searchSlot.offsetHeight : 0;
		this._scrollable.getDomNode().style.height = `${Math.max(0, dimension.height - top)}px`;
		this._scrollable.scanDomNode();
	}

	override focus(): void {
		super.focus();
		this._search.focus();
	}

	/** Shows a page and leaves search. */
	showPage(page: ClaudeSettingsPageId): void {
		this._page = page;
		this._search.value = '';
		this._query = '';
		this.render();
		this._scrollable.setScrollPosition({ scrollTop: 0 });
		if (page === 'plan' || page === 'customize') {
			void this.refreshOverview(page === 'plan' ? 'stale' : undefined);
		}
	}

	/** Filters every page by `query`. An empty query shows the current page again. */
	search(query: string): void {
		if (this._search.value !== query) {
			this._search.value = query;
		}
		this._query = query.trim();
		this.render();
		this._scrollable.setScrollPosition({ scrollTop: 0 });
	}

	/** Asks Claude Code for its models and state again. The Models page's refresh button runs it. */
	async refreshRuntime(): Promise<void> {
		const [state, models] = await Promise.all([
			this._runtime.getRuntimeState().catch(() => undefined),
			this._runtime.listModels().catch(error => {
				this._notifications.error(redactSecrets(error instanceof Error ? error.message : String(error)));
				return [];
			}),
		]);
		this._runtimeState = state ?? this._runtimeState;
		this._models = models;
		this.renderAccount();
		this.render();
		await this.refreshOverview();
	}

	/**
	 * Asks Claude Code for the account, plan limits, MCP servers and catalog, and looks for memory files.
	 * On Plan & Usage the plan limits are asked for again once they are a minute old, `refreshUsage` aside.
	 */
	async refreshOverview(refreshUsage: ClaudeUsageRefresh | undefined = this.page === 'plan' ? 'stale' : undefined): Promise<void> {
		const asked = ++this._usageAsks;
		this._usageLoading = refreshUsage !== undefined;
		if (this._usageLoading && this.showsPlan()) {
			this.render();
		}
		const [overview, sandbox] = await Promise.all([
			this._runtime.getAccountOverview?.(refreshUsage).catch(() => undefined),
			this._runtime.getSandboxStatus?.().catch(() => undefined),
			this.findMemory(),
			this.findHooks(),
			this.findPlugins(),
			this._createFiles.refresh(this.useClaudeCodeSetup()),
		]);
		if (asked !== this._usageAsks) {
			// A newer ask (a switch of account) is the one that answers.
			return;
		}
		this._usageLoading = false;
		this._overview = overview ?? { ...this._overview, live: this._overview?.live ?? false, usageFailed: true };
		await this.rememberAccountsUsage(overview);
		if (asked !== this._usageAsks) {
			return;
		}
		this._sandboxStatus = sandbox ?? this._sandboxStatus;
		this.renderAccount();
		this.render();
	}

	/** Lists the accounts and keeps the limits just read under the account in use, so the all-accounts view can compare them (issue 1182). */
	private async rememberAccountsUsage(overview: ClaudeAccountOverview | undefined): Promise<void> {
		this._accountList = await this._runtime.listAccounts?.().catch(() => undefined) ?? this._accountList;
		this._knownUsage = readClaudeKnownUsage(this._reviewStorage.get(CLAUDE_ACCOUNTS_USAGE_STORAGE_KEY, StorageScope.PROFILE));
		const active = this._accountList.find(account => account.active);
		if (active && overview?.usage?.length) {
			this._knownUsage = withClaudeKnownUsage(this._knownUsage, active.id, overview.usage, overview.usageCheckedAt ?? Date.now());
		}
		// The other signed-in accounts are read live with their own config dir, so the all-accounts card is current for each (issue 1385).
		const others = this._accountList.filter(account => account.signedIn && !account.active && !account.mismatch);
		const live = await Promise.all(others.map(async account => ({ account, overview: await this._runtime.getAccountOverview?.('stale', account.id).catch(() => undefined) })));
		for (const { account, overview: other } of live) {
			if (other?.usage?.length) {
				this._knownUsage = withClaudeKnownUsage(this._knownUsage, account.id, other.usage, other.usageCheckedAt ?? Date.now());
			}
		}
		this._reviewStorage.store(CLAUDE_ACCOUNTS_USAGE_STORAGE_KEY, JSON.stringify(this._knownUsage), StorageScope.PROFILE, StorageTarget.MACHINE);
	}

	/** Asks Claude Code only for plan limits a minute old or older, and shows how old they are (issue 704). */
	private async refreshUsage(): Promise<void> {
		const asked = this._usageAsks;
		const overview = await this._runtime.getAccountOverview?.('stale').catch(() => undefined);
		if (asked !== this._usageAsks) {
			return;
		}
		this._overview = overview ?? this._overview;
		if (this.page === 'plan') {
			this.render();
		}
	}

	private async findPlugins(): Promise<void> {
		this._installedPlugins = await this._plugins.getInstalled(this.projectCwd()).catch(() => undefined) ?? this._installedPlugins;
	}

	private async findMemory(): Promise<void> {
		const folders = this._workspace.getWorkspace().folders;
		const candidates: { uri: URI; label: string; scope: ClaudeMemoryFile['scope']; name?: string }[] = [];
		for (const folder of folders) {
			for (const [path, scope] of PROJECT_MEMORY) {
				// AGENTS.md is listed while sessions read it (issue 499).
				if (scope === 'agents' && this._configuration.getValue(CLAUDE_INSTRUCTIONS_AGENTS_MD_SETTING) === false) {
					continue;
				}
				candidates.push({ uri: joinPath(folder.uri, ...path.split('/')), label: folders.length > 1 ? `${folder.name}/${path}` : path, scope });
			}
		}
		const home = await this._paths.userHome().catch(() => undefined);
		if (home) {
			// Issue 455, DL-82: your rules for every project are Klawly's; Claude Code's own file is listed, never written.
			candidates.push({ uri: joinPath(home, this._product.dataFolderName, CLAUDE_USER_LAYER_FOLDER, CLAUDE_USER_LAYER_FILES.rules), label: claudeUserLayerLabel(this._product.dataFolderName, CLAUDE_USER_LAYER_FILES.rules), scope: 'user' });
			if (this.useClaudeCodeSetup()) {
				candidates.push({ uri: joinPath(home, '.claude', 'CLAUDE.md'), label: '~/.claude/CLAUDE.md', scope: 'claudeCode' });
			}
		}
		// Issue 523: the organization's managed CLAUDE.md and managed settings, the team rules Claude Code applies first.
		const managed = URI.file(claudeManagedDirectory(OS));
		candidates.push({ uri: joinPath(managed, CLAUDE_MANAGED_MEMORY_FILE), label: joinPath(managed, CLAUDE_MANAGED_MEMORY_FILE).fsPath, scope: 'managed', name: localize('claudeMemoryManaged', "Organization Memory") });
		candidates.push({ uri: joinPath(managed, CLAUDE_MANAGED_SETTINGS_FILE), label: joinPath(managed, CLAUDE_MANAGED_SETTINGS_FILE).fsPath, scope: 'managed', name: localize('claudeSettingsManagedFile', "Organization Settings") });
		const found = await Promise.all(candidates.map(candidate => this._files.exists(candidate.uri).catch(() => false)));
		this._memoryFiles.clear();
		const memory: ClaudeMemoryFile[] = [];
		candidates.forEach((candidate, index) => {
			// Your rules are listed before the file exists, so there is always a place to write them.
			if (found[index] || candidate.scope === 'user') {
				const id = candidate.uri.toString();
				this._memoryFiles.set(id, candidate.uri);
				memory.push({ id, label: candidate.label, scope: candidate.scope, name: candidate.name, ...(found[index] ? {} : { missing: true }) });
			}
		});
		this._memory = memory;
	}

	/**
	 * Reads the hooks and network domains of the project and local Claude Code
	 * settings files and of Klawly's user layer, `~/.klawly/claude/settings.json`
	 * (issue 455). Claude Code's own `~/.claude/settings.json` is read for the
	 * list only, while Klawly uses it.
	 */
	private async findHooks(): Promise<void> {
		const folder = this._workspace.getWorkspace().folders[0];
		const home = await this._paths.userHome().catch(() => undefined);
		this._hookFiles.clear();
		for (const scope of CLAUDE_HOOK_SCOPES) {
			if (scope === 'user') {
				if (home) {
					this._hookFiles.set(scope, joinPath(home, this._product.dataFolderName, CLAUDE_USER_LAYER_FOLDER, CLAUDE_USER_LAYER_FILES.settings));
				}
			} else if (folder) {
				this._hookFiles.set(scope, joinPath(folder.uri, ...CLAUDE_SETTINGS_FILES[scope]));
			}
		}
		const read = async (scope: ClaudeHookScope, resource: URI) => {
			try {
				const text = (await this._files.readFile(resource)).value.toString();
				return { hooks: readClaudeHooks(text, scope), network: readClaudeNetworkRules(text, scope), permissions: readClaudePermissionRules(text, scope) };
			} catch {
				return { hooks: [], network: [], permissions: [] };
			}
		};
		const [files, claudeCode] = await Promise.all([
			Promise.all([...this._hookFiles].map(([scope, resource]) => read(scope, resource))),
			home && this.useClaudeCodeSetup() ? read('user', joinPath(home, ...CLAUDE_SETTINGS_FILES.user)) : undefined,
		]);
		this._hooks = files.flatMap(file => file.hooks);
		this._networkRules = files.flatMap(file => file.network);
		this._permissionRules = files.flatMap(file => file.permissions);
		this._claudeCodeHooks = claudeCode?.hooks ?? [];
		this._claudeCodeNetworkRules = claudeCode?.network ?? [];
		this._claudeCodePermissionRules = claudeCode?.permissions ?? [];
	}

	private useClaudeCodeSetup(): boolean {
		return this._configuration.getValue(CLAUDE_USE_CLAUDE_CODE_SETUP_SETTING) !== false;
	}

	/** Where a hook scope's settings file is, as people write it. */
	private hookFileLabel(scope: ClaudeHookScope): string {
		switch (scope) {
			case 'project': return '.claude/settings.json';
			case 'local': return '.claude/settings.local.json';
			case 'user': return claudeUserLayerLabel(this._product.dataFolderName, CLAUDE_USER_LAYER_FILES.settings);
		}
	}

	private applyOptions(options: IEditorOptions | undefined): void {
		const settingsOptions = options as IClaudeSettingsEditorOptions | undefined;
		if (settingsOptions?.page && this._pages.some(page => page.id === settingsOptions.page)) {
			this._page = settingsOptions.page;
			this._query = '';
			this._search.value = '';
		}
		if (settingsOptions?.form && this._page === 'customize') {
			this._customizeKind = undefined;
			this._customizeQuery = '';
			this._form = settingsOptions.form;
			this._formError = '';
		}
		if (settingsOptions?.automationTemplate && this._page === 'agents') {
			this._automationForm = NEW_AUTOMATION;
			this._automationTemplate = settingsOptions.automationTemplate;
			this._automationMemory = '';
			this._automationDraft = claudeAutomationTemplateDraft(this._automationTemplate, this.automationScopes()[0], false, readClaudeReviewSummaryMode(this._configuration.getValue(CLAUDE_REVIEW_SUMMARY_SETTING)) !== 'off', readClaudeReviewDepthSetting(this._configuration.getValue(CLAUDE_REVIEW_DEPTH_SETTING)));
			this._automationDraft.memoryText = this._automationMemory;
			this._automationError = '';
		}
		if (settingsOptions?.query !== undefined) {
			this._search.value = settingsOptions.query;
			this._query = settingsOptions.query.trim();
		}
	}

	//#region Nav

	private renderNav(): void {
		this._navStore.clear();
		this._navButtons.clear();
		const list = this._pageList;
		clearNode(list);
		for (const page of this._pages) {
			if (page.groupStart) {
				append(list, $('.claude-settings-nav-divider'));
			}
			const item = append(list, $('div'));
			const button = append(item, $<HTMLButtonElement>('button.claude-settings-nav-item'));
			button.type = 'button';
			button.dataset.page = page.id;
			append(button, $(ThemeIcon.asCSSSelector(page.icon)));
			append(button, $('span.label')).textContent = page.title;
			if (this._narrow) {
				button.setAttribute('aria-label', page.title);
				this._navStore.add(this._hover.setupDelayedHover(button, { content: page.title, additionalClasses: ['claude-root'] }));
			}
			this._navStore.add(addDisposableListener(button, EventType.CLICK, () => this.showPage(page.id)));
			this._navStore.add(addDisposableListener(button, EventType.KEY_DOWN, event => this.onNavKey(event, page.id)));
			this._navButtons.set(page.id, button);
		}
		append(list, $('.claude-settings-nav-divider'));
		const editorSettings = append(list, $<HTMLButtonElement>('button.claude-settings-nav-item.is-link'));
		editorSettings.type = 'button';
		append(editorSettings, $(ThemeIcon.asCSSSelector(Codicon.settings)));
		const editorLabel = localize('claudeSettingsAllSettings', "Editor Settings");
		append(editorSettings, $('span.label')).textContent = editorLabel;
		append(editorSettings, $(`span.external${ThemeIcon.asCSSSelector(Codicon.linkExternal)}`));
		editorSettings.setAttribute('aria-label', localize('claudeSettingsAllSettingsLabel', "Open Editor Settings"));
		if (this._narrow) {
			this._navStore.add(this._hover.setupDelayedHover(editorSettings, { content: editorLabel, additionalClasses: ['claude-root'] }));
		}
		this._navStore.add(addDisposableListener(editorSettings, EventType.CLICK, () => void this._commands.executeCommand('workbench.action.openSettings')));
		this.updateNav();
	}

	private updateNav(): void {
		for (const [id, button] of this._navButtons) {
			const current = !this._query && id === this._page;
			button.classList.toggle('is-selected', current);
			if (current) {
				button.setAttribute('aria-current', 'page');
			} else {
				button.removeAttribute('aria-current');
			}
		}
	}

	private onNavKey(event: KeyboardEvent, page: ClaudeSettingsPageId): void {
		const ids = this._pages.map(candidate => candidate.id);
		const index = ids.indexOf(page);
		const next = event.key === 'ArrowDown' ? ids[index + 1] : event.key === 'ArrowUp' ? ids[index - 1] : undefined;
		if (next) {
			event.preventDefault();
			this._navButtons.get(next)?.focus();
		}
	}

	private renderAccount(): void {
		clearNode(this._account);
		this._accountStore.clear();
		this.renderProfile();
		const summary = claudeAccountSummary(this._runtimeState);
		const account = claudeShownAccount(this._runtimeState, this._overview?.account);
		const name = account?.email ?? localize('claudeSettingsAccountName', "Claude Code");
		const plan = account?.plan ? localize('claudeSettingsPlanName', "{0} Plan", claudePlanLabel(account.plan)) : summary.label;
		const avatar = append(this._account, $('.claude-settings-avatar'));
		append(avatar, $(ThemeIcon.asCSSSelector(Codicon.account)));
		const text = append(this._account, $('.claude-settings-account-text'));
		append(text, $('.name')).textContent = name;
		append(text, $('.plan')).textContent = plan;
		this._account.setAttribute('aria-label', localize('claudeSettingsAccountLabel', "{0}, {1}", name, plan));
		if (claudeAccountActions(this._runtimeState)?.enabled) {
			this.renderAccountMenu();
		}
	}

	/**
	 * Issue 446, DL-69: the GitHub account that is the Klawly profile, with Sign Out, or Sign In
	 * while signed out. Signed out, everything else on these pages still works.
	 */
	private renderProfile(): void {
		clearNode(this._profileBlock);
		const account = this._profile.account;
		const avatar = append(this._profileBlock, $('.claude-settings-avatar'));
		if (account?.avatarUrl) {
			const image = append(avatar, $<HTMLImageElement>('img'));
			image.alt = '';
			image.draggable = false;
			image.referrerPolicy = 'no-referrer';
			image.src = account.avatarUrl;
		} else {
			append(avatar, $(ThemeIcon.asCSSSelector(Codicon.github)));
		}
		const text = append(this._profileBlock, $('.claude-settings-profile-text'));
		const name = account ? localize('claudeSettingsProfileName', "@{0}", account.login) : localize('claudeSettingsProfileSignedOut', "Not Signed In");
		const detail = localize('claudeSettingsProfileProvider', "GitHub");
		append(text, $('.name')).textContent = name;
		append(text, $('.plan')).textContent = detail;
		this._profileBlock.setAttribute('aria-label', localize('claudeSettingsProfileLabel', "{0}, {1}", name, detail));
		if (account) {
			this.renderProfileMenu();
			return;
		}
		const signIn = append(this._profileBlock, $<HTMLButtonElement>('button.claude-btn.is-small.claude-settings-profile-sign-in'));
		signIn.type = 'button';
		signIn.textContent = localize('claudeSettingsProfileSignIn', "Sign In");
		signIn.setAttribute('aria-label', localize('claudeSettingsProfileSignInLabel', "Sign In with GitHub"));
		this._accountStore.add(addDisposableListener(signIn, EventType.CLICK, () => void this._commands.executeCommand(KLAWLY_GITHUB_SIGN_IN_COMMAND_ID)));
	}

	private renderProfileMenu(): void {
		const label = localize('claudeSettingsProfileActions', "Profile Actions");
		const button = append(this._profileBlock, $<HTMLButtonElement>('button.claude-btn.is-icon.is-medium.claude-settings-head-button.claude-settings-profile-menu'));
		button.type = 'button';
		button.setAttribute('aria-label', label);
		button.setAttribute('aria-haspopup', 'menu');
		append(button, $(ThemeIcon.asCSSSelector(Codicon.ellipsis)));
		this._accountStore.add(this._hover.setupDelayedHover(button, { content: label, additionalClasses: ['claude-root'] }));
		this._accountStore.add(addDisposableListener(button, EventType.CLICK, () => {
			if (this._menu.isOpen) {
				this._menu.close();
				return;
			}
			this._menu.show({
				anchor: button,
				label,
				className: 'claude-settings-menu',
				position: AnchorPosition.BELOW,
				alignment: AnchorAlignment.RIGHT,
				entries: [
					{ id: 'signOutOfGitHub', label: localize('claudeSettingsProfileSignOut', "Sign Out of GitHub"), icon: Codicon.signOut, run: () => void this._commands.executeCommand(KLAWLY_GITHUB_SIGN_OUT_COMMAND_ID) },
				],
			});
		}));
	}

	/** Issue 536: the account block's menu, with Switch Account and Log Out. */
	private renderAccountMenu(): void {
		const label = localize('claudeSettingsAccountActions', "Account Actions");
		const button = append(this._account, $<HTMLButtonElement>('button.claude-btn.is-icon.is-medium.claude-settings-head-button.claude-settings-account-menu'));
		button.type = 'button';
		button.setAttribute('aria-label', label);
		button.setAttribute('aria-haspopup', 'menu');
		append(button, $(ThemeIcon.asCSSSelector(Codicon.ellipsis)));
		this._accountStore.add(this._hover.setupDelayedHover(button, { content: label, additionalClasses: ['claude-root'] }));
		this._accountStore.add(addDisposableListener(button, EventType.CLICK, () => {
			if (this._menu.isOpen) {
				this._menu.close();
				return;
			}
			this._menu.show({
				anchor: button,
				label,
				className: 'claude-settings-menu',
				position: AnchorPosition.BELOW,
				alignment: AnchorAlignment.RIGHT,
				entries: [
					{ id: 'switchAccount', label: localize('claudeSettingsSwitchAccount', "Switch Account..."), icon: Codicon.arrowSwap, run: () => void this._commands.executeCommand(CLAUDE_SWITCH_ACCOUNT_COMMAND_ID) },
					{ id: 'logOut', label: localize('claudeSettingsLogOut', "Log Out"), icon: Codicon.signOut, run: () => void this._commands.executeCommand(CLAUDE_LOG_OUT_COMMAND_ID) },
				],
			});
		}));
	}

	//#endregion

	//#region Content

	private render(): void {
		if (!this._content) {
			return;
		}
		const active = getActiveElement();
		const focusKey = isHTMLElement(active) && this._content.contains(active) ? active.dataset.focusKey : undefined;
		this._renderStore.clear();
		this._modelRowStore.clear();
		this._customizeStore.clear();
		this._automationFormStore.clear();
		this._automationItemsStore.clear();
		this._focusables.clear();
		this._modelRows = undefined;
		this._customizeList = undefined;
		this._automationCount = undefined;
		this._automationAdd = undefined;
		this._automationFormSlot = undefined;
		this._automationItemsSlot = undefined;
		clearNode(this._content);
		if (this._query) {
			this.renderSearch();
		} else {
			this.renderPage(this._pages.find(page => page.id === this._page) ?? this._pages[0]);
		}
		this.updateNav();
		if (focusKey) {
			this._focusables.get(focusKey)?.focus();
		}
		this._scrollable.scanDomNode();
	}

	private renderPage(page: ClaudeSettingsPage): void {
		const header = append(this._content, $('header.claude-settings-header'));
		append(header, $('h2')).textContent = page.title;
		if (page.description) {
			append(header, $('p')).textContent = page.description;
		}
		for (const section of page.sections) {
			this.renderSection(section, section.title, section.rows);
		}
	}

	private renderSearch(): void {
		const matches = searchClaudeSettings(this._pages, this._query);
		const header = append(this._content, $('header.claude-settings-header'));
		append(header, $('h2')).textContent = localize('claudeSettingsResults', "Search Results");
		if (matches.length === 0) {
			const empty = append(this._content, $('.claude-settings-empty'));
			append(empty, $('p')).textContent = localize('claudeSettingsNoMatch', "No Klawly setting matches \"{0}\".", this._query);
			const hint = claudeSettingsSearchHint(this._query);
			if (hint) {
				append(empty, $('p.claude-settings-hint')).textContent = hint.message;
				const open = append(empty, $<HTMLButtonElement>('button.claude-btn'));
				open.type = 'button';
				open.textContent = hint.label;
				open.addEventListener(EventType.CLICK, () => void this._commands.executeCommand(hint.command));
			}
			const all = append(empty, $<HTMLButtonElement>('button.claude-btn'));
			all.type = 'button';
			all.textContent = localize('claudeSettingsSearchAll', "Search All Settings");
			all.addEventListener(EventType.CLICK, () => void this._commands.executeCommand('workbench.action.openSettings', this._query));
			return;
		}
		append(header, $('p')).textContent = matches.length === 1
			? localize('claudeSettingsOneResult', "1 setting")
			: localize('claudeSettingsResultCount', "{0} settings", matches.length);
		for (const page of this._pages) {
			const rows = matches.filter(match => match.page === page);
			if (rows.length > 0) {
				this.renderSection(undefined, page.title, rows.map(match => match.row), page.id);
			}
		}
	}

	private renderSection(section: ClaudeSettingsSection | undefined, label: string | undefined, rows: readonly ClaudeSettingsRow[], resultPage?: ClaudeSettingsPageId): void {
		const element = append(this._content, $('section.claude-settings-section'));
		if (section) {
			element.dataset.section = section.id;
		}
		const block = !resultPage && rows.length === 1 ? rows[0].control.kind : undefined;
		if (block === 'usage' || block === 'customize') {
			// These pages draw their own sections.
			element.classList.add('is-block');
			if (block === 'usage') {
				this.renderPlan(element);
			} else {
				this.renderCustomize(element);
			}
			return;
		}
		if (!resultPage && rows.some(row => row.control.kind === 'automations')) {
			this.renderAutomations(element, label ?? '', rows);
			return;
		}
		if (label) {
			const title = append(element, $('h3.claude-settings-section-label'));
			title.textContent = label;
		}
		const card = append(element, $('.claude-settings-card'));
		for (const row of rows) {
			if (row.shownWhen && !this._configuration.getValue(row.shownWhen)) {
				// DL-12: a row that cannot apply while its parent setting is off is not shown.
				continue;
			}
			if (resultPage && (row.control.kind === 'modelList' || row.control.kind === 'usage' || row.control.kind === 'customize' || row.control.kind === 'automations')) {
				// Blocks drawn from the runtime show on their own page; the result links there.
				this.renderRow(card, row, { kind: 'command', label: localize('claudeSettingsShow', "Show"), command: '' }, () => this.showPage(resultPage));
			} else if (row.control.kind === 'modelList') {
				this.renderModelList(card);
			} else {
				this.renderRow(card, row, row.control);
			}
		}
	}

	/** A quiet label above a card, with an optional button at its end. */
	private sectionHead(parent: HTMLElement, label: string, count?: number): HTMLElement {
		const head = append(parent, $('.claude-settings-section-head'));
		const title = append(head, $('h3.claude-settings-section-label'));
		title.textContent = label;
		if (count !== undefined) {
			append(title, $('span.count')).textContent = String(count);
		}
		return head;
	}

	private headButton(head: HTMLElement, focusKey: string, icon: ThemeIcon, label: string, run: () => void, store: DisposableStore): HTMLButtonElement {
		const button = append(head, $<HTMLButtonElement>('button.claude-btn.is-ghost.is-medium.claude-settings-head-button'));
		button.type = 'button';
		button.dataset.focusKey = focusKey;
		this._focusables.set(focusKey, button);
		append(button, $(ThemeIcon.asCSSSelector(icon)));
		append(button, $('span')).textContent = label;
		store.add(addDisposableListener(button, EventType.CLICK, run));
		return button;
	}

	private renderRow(card: HTMLElement, row: ClaudeSettingsRow, control: ClaudeSettingsControl, run?: () => void): HTMLElement {
		const element = append(card, $('.claude-settings-row'));
		element.dataset.row = row.id;
		// Issue 1578: a list or a stats block is a wide block, not a compact control; it goes under its text at any width.
		element.classList.toggle('is-block', control.kind === 'learnedRules' || control.kind === 'reviewStats' || control.kind === 'extensionAgents');
		const text = append(element, $('.claude-settings-row-text'));
		const title = append(text, $('.claude-settings-row-title'));
		const description = append(text, $('.claude-settings-row-description'));
		if (control.kind === 'profile') {
			// Issue 446, DL-69: the GitHub profile heads the section; signing out of it leaves Claude signed in.
			const account = this._profile.account;
			title.textContent = account ? localize('claudeSettingsProfileRowSignedIn', "GitHub: @{0}", account.login) : row.title;
			description.textContent = account
				? localize('claudeSettingsProfileRowSignedInDesc', "Your Klawly profile. Signing out leaves Claude signed in")
				: localize('claudeSettingsProfileRowSignedOutDesc', "Sign in so Klawly knows who you are. Everything works without it");
			control = account
				? { kind: 'command', label: localize('claudeSettingsProfileRowSignOut', "Sign Out"), command: KLAWLY_GITHUB_SIGN_OUT_COMMAND_ID }
				: { kind: 'command', label: localize('claudeSettingsProfileRowSignIn', "Sign In with GitHub"), command: KLAWLY_GITHUB_SIGN_IN_COMMAND_ID };
		} else if (control.kind === 'account') {
			// DL-69: Claude is a service account, a smaller row under the profile.
			element.classList.add('is-nested');
			const summary = claudeAccountSummary(this._runtimeState);
			title.textContent = row.title;
			description.textContent = summary.detail;
			if (summary.action) {
				control = { kind: 'command', label: summary.action.label, command: summary.action.command };
			}
		} else if (control.kind === 'version') {
			// Issue 833, DL-87: the version testers know, the commit and date smaller, Copy for bug reports.
			const version = claudeVersionRow(this._product);
			title.textContent = version.title;
			description.textContent = version.detail;
			control = { kind: 'command', label: localize('claudeSettingsVersionCopy', "Copy"), command: '' };
			run = () => {
				void this._clipboard.writeText(claudeVersionCopyText(this._product));
				this._notifications.status(localize('claudeSettingsVersionCopied', "Version details copied"), { hideAfter: 3000 });
			};
		} else if (control.kind === 'updates') {
			// Issue 833, DL-87: the live IUpdateService state in words, with the one button that moves it on.
			const update = claudeUpdateRow(this._updates.state);
			this._updateRow = update;
			title.textContent = row.title;
			description.textContent = update.status;
			description.setAttribute('aria-live', 'polite');
			description.setAttribute('aria-busy', String(update.busy));
			control = { kind: 'command', label: update.button, command: '' };
			run = () => this.runUpdateAction(update);
			element.dataset.updateState = this._updates.state.type;
			if (update.progress) {
				// Issue 1580, DL-87: Squirrel.Mac reports no byte counts, so the bar is indeterminate.
				const bar = this._renderStore.add(new ProgressBar(append(element, $('.claude-settings-update-progress')), { ...defaultProgressBarStyles }));
				bar.infinite();
			}
		} else if (control.kind === 'sandboxStatus') {
			title.textContent = row.title;
			description.textContent = claudeSandboxStatusText(this._sandboxStatus);
		} else if (control.kind === 'privacyAccount') {
			// Issue 522, DL-56: the account decides the data terms; its one button opens that account's own settings or terms.
			const account = claudePrivacyAccount(this._runtimeState, this._overview);
			title.textContent = account.label;
			description.textContent = account.detail;
			const link = account.link;
			if (link) {
				control = { kind: 'command', label: link.label, command: '' };
				run = () => void this._opener.open(URI.parse(link.url), { openExternal: true });
			}
		} else {
			title.textContent = row.title;
			description.textContent = row.description;
		}
		title.id = `claude-settings-${row.id}-title`;
		description.id = `claude-settings-${row.id}-description`;
		if (row.key) {
			const key = row.key;
			this._renderStore.add(this._hover.setupDelayedHover(title, { content: key, additionalClasses: ['claude-root'] }));
		}
		const slot = append(element, $('.claude-settings-row-control'));
		const target = this.renderControl(slot, row, control, run);
		if (target) {
			target.setAttribute('aria-labelledby', title.id);
			target.setAttribute('aria-describedby', description.id);
		}
		if (row.key && this._configuration.inspect(row.key).policyValue !== undefined) {
			this.renderManaged(element, text, target);
		}
		return element;
	}

	/** Issue 833: each button hands the work to the update service; Klawly adds no update logic. */
	private runUpdateAction(row: ClaudeUpdateRow): void {
		switch (row.action) {
			case 'check': void this._updates.checkForUpdates(true); break;
			case 'download': void this._updates.downloadUpdate(true); break;
			case 'install': void this._updates.applyUpdate(); break;
			case 'restart': void this._updates.quitAndInstall(); break;
		}
	}

	/** DL-26: an organization's policy sets this row. Say so, as the classic Settings editor does, and lock the control. */
	private renderManaged(element: HTMLElement, text: HTMLElement, target: HTMLElement | undefined): void {
		element.classList.add('is-managed');
		const badge = append(text, $('.claude-settings-row-managed'));
		append(badge, $(ThemeIcon.asCSSSelector(Codicon.briefcase)));
		append(badge, $('span')).textContent = localize('claudeSettingsManaged', "Managed by your organization");
		target?.toggleAttribute('disabled', true);
	}

	private renderControl(slot: HTMLElement, row: ClaudeSettingsRow, control: ClaudeSettingsControl, run?: () => void): HTMLElement | undefined {
		const key = row.key;
		switch (control.kind) {
			case 'toggle':
				return key ? this.renderToggle(slot, row.id, this._configuration.getValue(key) === true, value => this.write(key, value)) : undefined;
			case 'select': {
				if (!key) {
					return undefined;
				}
				const current = String(this._configuration.getValue(key) ?? '');
				return this.renderSelect(slot, row.id, row.title, control.options, current, value => this.write(key, value));
			}
			case 'model': {
				if (!key) {
					return undefined;
				}
				const current = readClaudeModelId(this._configuration.getValue(key)) ?? '';
				return this.renderSelect(slot, row.id, row.title, this.modelOptions(control.emptyLabel, current), current, value => this.write(key, value || undefined));
			}
			case 'number':
				return key ? this.renderNumber(slot, row.id, key, control) : undefined;
			case 'lines':
				return key ? this.renderLines(slot, row.id, key, control.placeholder) : undefined;
			case 'text':
				return key ? this.renderText(slot, row.id, key, control.placeholder, control.short) : undefined;
			case 'command': {
				const button = append(slot, $<HTMLButtonElement>('button.claude-btn.claude-settings-button'));
				button.type = 'button';
				button.textContent = control.label;
				button.dataset.focusKey = row.id;
				this._focusables.set(row.id, button);
				button.addEventListener(EventType.CLICK, () => run ? run() : void this._commands.executeCommand(control.command, ...(control.args ?? [])));
				if (row.id === 'updates') {
					button.disabled = !this._updateRow?.action;
				}
				return button;
			}
			case 'sandboxStatus': {
				// A state, not a control: the same badge as the MCP server rows.
				const status = claudeSandboxStatusBadge(this._sandboxStatus);
				if (status) {
					append(slot, $(`span.claude-badge.${status.className}`)).textContent = status.label;
				}
				return undefined;
			}
			case 'learnedRules':
				this.renderLearnedRules(slot);
				return undefined;
			case 'extensionAgents':
				this.renderExtensionAgents(slot);
				return undefined;
			case 'reviewStats':
				this.renderReviewStats(slot);
				return undefined;
			default:
				return undefined;
		}
	}

	/** Issue 937: review statistics of this workspace, read from the on-device event log. Bars are tone, not color alone (DL-07). */
	private renderReviewStats(slot: HTMLElement): void {
		const box = append(slot, $('div.claude-settings-stats'));
		const read = () => deserializeReviewStats(this._reviewStorage.get(CLAUDE_REVIEW_STATS_STORAGE_KEY, StorageScope.WORKSPACE, '[]'));
		const render = () => {
			clearNode(box);
			const events = read();
			const summary = summarizeClaudeReviewStats(events, this._statsPeriod, Date.now());
			const bar = append(box, $('div.claude-settings-stats-bar'));
			for (const period of CLAUDE_REVIEW_STAT_PERIODS) {
				const button = append(bar, $<HTMLButtonElement>('button.claude-btn.claude-settings-button'));
				button.type = 'button';
				button.textContent = period === '7d' ? localize('claudeSettingsStats7', "7 Days") : period === '30d' ? localize('claudeSettingsStats30', "30 Days") : localize('claudeSettingsStats90', "90 Days");
				button.setAttribute('aria-pressed', String(period === this._statsPeriod));
				button.classList.toggle('is-selected', period === this._statsPeriod);
				button.addEventListener(EventType.CLICK, () => {
					this._statsPeriod = period;
					render();
				});
			}
			const exportButton = append(bar, $<HTMLButtonElement>('button.claude-btn.claude-settings-button'));
			exportButton.type = 'button';
			exportButton.textContent = localize('claudeSettingsStatsExport', "Export CSV");
			exportButton.disabled = events.length === 0;
			exportButton.addEventListener(EventType.CLICK, async () => {
				try {
					const target = await this._fileDialogs.showSaveDialog({ title: localize('claudeSettingsStatsExportTitle', "Export Review Statistics"), defaultUri: joinPath(await this._fileDialogs.defaultFilePath(), 'klawly-review-statistics.csv'), filters: [{ name: 'CSV', extensions: ['csv'] }] });
					if (target) {
						await this._files.writeFile(target, VSBuffer.fromString(claudeReviewStatsCsv(read())));
					}
				} catch (error) {
					this._notifications.error(localize('claudeSettingsStatsExportFailed', "Couldn't export the statistics: {0}", redactSecrets(error instanceof Error ? error.message : String(error))));
				}
			});
			const clear = append(bar, $<HTMLButtonElement>('button.claude-btn.claude-settings-button'));
			clear.type = 'button';
			clear.textContent = localize('claudeSettingsStatsClear', "Clear Statistics");
			clear.disabled = events.length === 0;
			clear.addEventListener(EventType.CLICK, () => {
				this._reviewStorage.remove(CLAUDE_REVIEW_STATS_STORAGE_KEY, StorageScope.WORKSPACE);
				render();
			});
			if (summary.total.raised + summary.total.fixed + summary.total.dismissed + summary.total.ignored === 0) {
				append(box, $('span.claude-settings-learned-empty')).textContent = localize('claudeSettingsStatsEmpty', "No review activity in this period. Numbers are kept on this machine for 90 days and are never sent anywhere.");
				return;
			}
			append(box, $('div.claude-settings-learned-text')).textContent = localize('claudeSettingsStatsTotals', "{0} raised, {1} fixed, {2} dismissed, {3} ignored. {4}% addressed.", summary.total.raised, summary.total.fixed, summary.total.dismissed, summary.total.ignored, Math.round(summary.addressedRate * 100));
			const table = (title: string, rows: readonly { label: string; counts: ClaudeReviewStatCounts }[]) => {
				append(box, $('div.claude-settings-stats-title')).textContent = title;
				const max = Math.max(1, ...rows.map(row => row.counts.raised));
				for (const row of rows) {
					const line = append(box, $('div.claude-settings-stats-row'));
					append(line, $('span.claude-settings-stats-label')).textContent = row.label;
					const track = append(line, $('span.claude-settings-stats-track'));
					append(track, $('span.claude-settings-stats-fill')).style.width = `${Math.round(row.counts.raised / max * 100)}%`;
					append(line, $('span.claude-settings-stats-counts')).textContent = localize('claudeSettingsStatsCounts', "{0} raised, {1} fixed, {2} dismissed", row.counts.raised, row.counts.fixed, row.counts.dismissed);
				}
			};
			table(localize('claudeSettingsStatsBySeverity', "By Severity"), summary.bySeverity.map(item => ({ label: item.severity, counts: item.counts })));
			table(localize('claudeSettingsStatsByCategory', "By Category"), summary.byCategory.map(item => ({ label: claudeReviewCategoryLabel(item.category), counts: item.counts })));
			if (summary.mostDismissed.length) {
				append(box, $('div.claude-settings-stats-title')).textContent = localize('claudeSettingsStatsMostDismissed', "Most Dismissed");
				append(box, $('div.claude-settings-learned-text')).textContent = summary.mostDismissed.map(item => `${claudeReviewCategoryLabel(item.category)} (${item.dismissed})`).join(', ');
			}
			if (summary.topFiles.length) {
				append(box, $('div.claude-settings-stats-title')).textContent = localize('claudeSettingsStatsTopFiles', "Files With the Most Findings");
				for (const item of summary.topFiles) {
					append(box, $('div.claude-settings-learned-text')).textContent = `${item.file} (${item.raised})`;
				}
			}
		};
		render();
	}

	/** Issue 1068: the learned review rules of the first workspace folder, each with a Remove button; empty says how rules get here. */
	private renderLearnedRules(slot: HTMLElement): void {
		const list = append(slot, $('div.claude-settings-learned'));
		const folder = this._workspace.getWorkspace().folders[0];
		const empty = (text: string) => {
			clearNode(list);
			append(list, $('span.claude-settings-learned-empty')).textContent = text;
		};
		if (!folder) {
			empty(localize('claudeSettingsLearnedNoFolder', "Open a folder to see its learned rules."));
			return;
		}
		const file = readClaudeReviewConfigFile(this._configuration.getValue(CLAUDE_REVIEW_CONFIG_FILE_SETTING)) || CLAUDE_REVIEW_CONFIG_FILE_DEFAULT;
		const resource = joinPath(folder.uri, ...file.split('/'));
		const load = async () => {
			let text = '';
			try {
				text = (await this._files.readFile(resource)).value.toString();
			} catch {
				// No rules file yet: nothing has been learned.
			}
			const rules = listLearnedClaudeReviewRules(text);
			if (!rules.length) {
				empty(localize('claudeSettingsLearnedEmpty', "Nothing learned yet. After you dismiss the same finding {0} times in this project (see Learn After above), Klawly offers a rule here.", readClaudeLearnAfter(this._configuration.getValue(CLAUDE_REVIEW_LEARN_AFTER_SETTING))));
				return;
			}
			clearNode(list);
			const header = append(list, $('div.claude-settings-learned-item'));
			append(header, $('span.claude-settings-learned-text')).textContent = localize('claudeSettingsLearnedFile', "Saved in {0}", file);
			const openFile = append(header, $<HTMLButtonElement>('button.claude-btn.claude-settings-button'));
			openFile.type = 'button';
			openFile.textContent = localize('claudeSettingsLearnedOpenFile', "Open File");
			openFile.addEventListener(EventType.CLICK, () => void this._editors.openEditor({ resource }));
			for (const rule of rules) {
				const item = append(list, $('div.claude-settings-learned-item'));
				append(item, $('span.claude-settings-learned-text')).textContent = rule.text;
				const remove = append(item, $<HTMLButtonElement>('button.claude-btn.claude-settings-button'));
				remove.type = 'button';
				remove.textContent = localize('claudeSettingsLearnedRemove', "Remove");
				remove.title = localize('claudeSettingsLearnedRemoveHint', "Remove this rule from {0}; the finding can be flagged again", file);
				remove.setAttribute('aria-label', localize('claudeSettingsLearnedRemoveLabel', "Remove Rule: {0}", rule.text));
				remove.addEventListener(EventType.CLICK, async () => {
					try {
						const current = (await this._files.readFile(resource)).value.toString();
						const next = removeLearnedClaudeReviewRule(current, rule.id);
						if (next !== undefined) {
							await this._files.writeFile(resource, VSBuffer.fromString(next));
							this._notifications.prompt(Severity.Info, localize('claudeSettingsLearnedRemoved', "Removed the rule from {0}. Klawly can flag that finding again.", file), [{
								label: localize('claudeSettingsLearnedUndo', "Undo"),
								run: async () => {
									try {
										await this._files.writeFile(resource, VSBuffer.fromString(current));
									} catch (error) {
										this._notifications.error(localize('claudeSettingsLearnedUndoFailed', "Couldn't restore the rule: {0}", redactSecrets(error instanceof Error ? error.message : String(error))));
									}
									await load();
								}
							}]);
						}
					} catch (error) {
						this._notifications.error(localize('claudeSettingsLearnedRemoveFailed', "Couldn't remove the rule: {0}", redactSecrets(error instanceof Error ? error.message : String(error))));
					}
					await load();
				});
			}
		};
		void load();
	}

	/** Issue 860: extensions that were asked to start Klawly agents, each with its answer and a Revoke button; empty says how they get here. */
	private renderExtensionAgents(slot: HTMLElement): void {
		const list = append(slot, $('div.claude-settings-learned'));
		const draw = () => {
			clearNode(list);
			const grants = this._extensionAgents.getGrants();
			if (!grants.length) {
				append(list, $('span.claude-settings-learned-empty')).textContent = localize('claudeSettingsExtensionAgentsEmpty', "No extension has asked to start an agent yet.");
				return;
			}
			for (const grant of grants) {
				const item = append(list, $('div.claude-settings-learned-item'));
				append(item, $('span.claude-settings-learned-text')).textContent = grant.allowed
					? localize('claudeSettingsExtensionAgentAllowed', "{0}: Allowed", grant.extensionId)
					: localize('claudeSettingsExtensionAgentDenied', "{0}: Denied", grant.extensionId);
				const revoke = append(item, $<HTMLButtonElement>('button.claude-btn.claude-settings-button'));
				revoke.type = 'button';
				revoke.textContent = localize('claudeSettingsExtensionAgentRevoke', "Revoke");
				revoke.title = localize('claudeSettingsExtensionAgentRevokeHint', "Forget this answer; {0} is asked again on its next call", grant.extensionId);
				revoke.setAttribute('aria-label', localize('claudeSettingsExtensionAgentRevokeLabel', "Revoke Answer: {0}", grant.extensionId));
				this._renderStore.add(addDisposableListener(revoke, EventType.CLICK, () => this._extensionAgents.revokeGrant(grant.extensionId)));
			}
		};
		this._renderStore.add(this._extensionAgents.onDidChangeGrants(draw));
		draw();
	}

	private renderToggle(slot: HTMLElement, focusKey: string, on: boolean, change: (value: boolean) => void): HTMLButtonElement {
		const button = append(slot, $<HTMLButtonElement>('button.claude-switch.claude-settings-switch'));
		button.type = 'button';
		button.setAttribute('role', 'switch');
		button.setAttribute('aria-checked', String(on));
		button.classList.toggle('is-on', on);
		button.dataset.focusKey = focusKey;
		this._focusables.set(focusKey, button);
		button.addEventListener(EventType.CLICK, () => change(!on));
		return button;
	}

	private renderSelect(slot: HTMLElement, focusKey: string, title: string, options: readonly ClaudeSettingsOption[], current: string, pick: (value: string) => void): HTMLButtonElement {
		const button = append(slot, $<HTMLButtonElement>('button.claude-field.is-select.claude-settings-select'));
		button.type = 'button';
		button.setAttribute('aria-haspopup', 'menu');
		button.dataset.focusKey = focusKey;
		button.dataset.value = current;
		this._focusables.set(focusKey, button);
		const selected = options.find(option => option.value === current);
		append(button, $('span.label')).textContent = selected?.label ?? current;
		append(button, $(ThemeIcon.asCSSSelector(Codicon.chevronDown)));
		button.addEventListener(EventType.CLICK, () => {
			if (this._menu.isOpen) {
				this._menu.close();
				return;
			}
			this._menu.show({
				anchor: button,
				label: title,
				className: 'claude-settings-menu',
				position: AnchorPosition.BELOW,
				alignment: AnchorAlignment.RIGHT,
				entries: options.map(option => ({
					id: option.value || '(empty)',
					label: option.label,
					description: option.description,
					role: 'menuitemradio' as const,
					checked: option.value === current,
					run: () => pick(option.value),
				})),
			});
		});
		return button;
	}

	private renderNumber(slot: HTMLElement, focusKey: string, key: string, control: Extract<ClaudeSettingsControl, { kind: 'number' }>): HTMLInputElement {
		const input = append(slot, $<HTMLInputElement>('input.claude-field.claude-settings-input.is-number'));
		input.type = 'number';
		if (control.min !== undefined) {
			input.min = String(control.min);
		}
		if (control.max !== undefined) {
			input.max = String(control.max);
		}
		const current = this._configuration.getValue(key);
		input.value = typeof current === 'number' ? String(current) : '';
		input.dataset.focusKey = focusKey;
		this._focusables.set(focusKey, input);
		if (control.unit) {
			append(slot, $('span.claude-settings-unit')).textContent = control.unit;
		}
		input.addEventListener(EventType.CHANGE, () => {
			const value = Number(input.value);
			if (input.value.trim() === '' || !Number.isFinite(value)) {
				input.value = typeof current === 'number' ? String(current) : '';
				return;
			}
			let clamped = Math.round(value);
			if (control.min !== undefined) {
				clamped = Math.max(control.min, clamped);
			}
			if (control.max !== undefined) {
				clamped = Math.min(control.max, clamped);
			}
			input.value = String(clamped);
			this.write(key, clamped);
		});
		return input;
	}

	/** A list setting as one entry per line (issue 671). Blank lines drop out; an empty box clears the setting. */
	private renderLines(slot: HTMLElement, focusKey: string, key: string, placeholder: string | undefined): HTMLTextAreaElement {
		const area = append(slot, $<HTMLTextAreaElement>('textarea.claude-field.claude-settings-input.is-lines'));
		area.rows = 3;
		area.placeholder = placeholder ?? '';
		const current = this._configuration.getValue<unknown>(key);
		area.value = Array.isArray(current) ? current.filter((entry): entry is string => typeof entry === 'string').join('\n') : '';
		area.dataset.focusKey = focusKey;
		this._focusables.set(focusKey, area);
		area.addEventListener(EventType.CHANGE, () => {
			const entries = area.value.split('\n').map(line => line.trim()).filter(line => line.length > 0);
			this.write(key, entries.length ? entries : undefined);
		});
		return area;
	}

	private renderText(slot: HTMLElement, focusKey: string, key: string, placeholder: string | undefined, short: boolean | undefined): HTMLInputElement {
		const input = append(slot, $<HTMLInputElement>('input.claude-field.claude-settings-input'));
		input.classList.toggle('is-short', !!short);
		input.type = 'text';
		input.placeholder = placeholder ?? '';
		// Only a value someone set: the schema default stays the faint placeholder, so a clean profile shows an empty field (#178).
		const inspected = this._configuration.inspect<unknown>(key);
		const current = isConfigured(inspected) || inspected.policyValue !== undefined || inspected.memoryValue !== undefined ? inspected.value : undefined;
		input.value = typeof current === 'string' ? current : '';
		input.dataset.focusKey = focusKey;
		this._focusables.set(focusKey, input);
		input.addEventListener(EventType.CHANGE, () => this.write(key, input.value.trim() || undefined));
		return input;
	}

	//#endregion

	//#region Plan & Usage

	private renderPlan(element: HTMLElement): void {
		const summary = claudeAccountSummary(this._runtimeState);
		const account = claudeShownAccount(this._runtimeState, this._overview?.account);

		const plan = append(element, $('.claude-settings-plan'));
		plan.dataset.row = 'plan';
		const text = append(plan, $('.claude-settings-plan-text'));
		append(text, $('.claude-settings-plan-label')).textContent = localize('claudeSettingsCurrentPlan', "Current Plan");
		append(text, $('.claude-settings-plan-name')).textContent = account?.plan ? claudePlanLabel(account.plan) : summary.label;
		const who = account?.email && account.organization
			? localize('claudeSettingsPlanWho', "{0} \u00b7 {1}", account.email, account.organization)
			: account?.email ?? account?.organization;
		append(text, $('.claude-settings-plan-detail')).textContent = who ?? summary.detail;
		const firstParty = !account?.provider || account.provider === 'firstParty';
		if (summary.action) {
			const { label, command } = summary.action;
			const button = append(plan, $<HTMLButtonElement>('button.claude-btn.claude-settings-button'));
			button.type = 'button';
			button.textContent = label;
			this._renderStore.add(addDisposableListener(button, EventType.CLICK, () => void this._commands.executeCommand(command)));
		} else if (account?.plan && firstParty) {
			const button = append(plan, $<HTMLButtonElement>('button.claude-btn.is-secondary.claude-settings-button'));
			button.type = 'button';
			button.dataset.focusKey = 'plan.manage';
			this._focusables.set('plan.manage', button);
			append(button, $('span')).textContent = localize('claudeSettingsManagePlan', "Manage Plan");
			append(button, $(ThemeIcon.asCSSSelector(Codicon.linkExternal)));
			this._renderStore.add(addDisposableListener(button, EventType.CLICK, () => void this._opener.open(URI.parse(CLAUDE_PLAN_URL), { openExternal: true })));
		}

		const limits = append(element, $('.claude-settings-subsection'));
		limits.dataset.section = 'limits';
		const head = this.sectionHead(limits, localize('claudeSettingsLimits', "Usage Limits"));
		const checkedAt = this._overview?.usageCheckedAt;
		if (checkedAt !== undefined) {
			const updated = append(head, $('span.claude-settings-head-note'));
			updated.dataset.row = 'usageUpdated';
			updated.textContent = claudeUsageUpdatedLabel(checkedAt, Date.now());
		}
		this.headButton(head, 'plan.refresh', Codicon.refresh, localize('claudeSettingsRefresh', "Refresh"), () => void this.refreshOverview('now'), this._renderStore);
		const card = append(limits, $('.claude-settings-card'));
		const usage = this._overview?.usage;
		const usageState = claudeUsageState(this._overview, this._usageLoading);
		if (usage && usageState === 'windows') {
			for (const window of usage) {
				this.renderMeter(card, window);
			}
		} else {
			const note = append(card, $('.claude-settings-row.is-note'));
			note.dataset.row = 'limits';
			note.dataset.state = usageState;
			append(note, $('.claude-settings-row-description')).textContent = usageState === 'none'
				? localize('claudeSettingsNoLimits', "This sign-in has no plan limits to show. API keys and cloud providers bill per request.")
				: usageState === 'loading'
					? localize('claudeSettingsLimitsLoading', "Loading your limits...")
					: usageState === 'failed'
						? localize('claudeSettingsLimitsFailed', "Couldn't load your limits. Check your connection, then try again.")
						: localize('claudeSettingsLimitsLater', "Claude Code has not reported your limits yet. Sign in, then refresh.");
			if (usageState === 'failed') {
				const retry = append(note, $<HTMLButtonElement>('button.claude-btn.is-secondary.claude-settings-button'));
				retry.type = 'button';
				retry.dataset.focusKey = 'plan.retryLimits';
				this._focusables.set('plan.retryLimits', retry);
				retry.textContent = localize('claudeSettingsLimitsRetry', "Try Again");
				this._renderStore.add(addDisposableListener(retry, EventType.CLICK, () => void this.refreshOverview('now')));
			}
		}

		this.renderAccountsUsage(element);

		const runtime = append(element, $('.claude-settings-subsection'));
		runtime.dataset.section = 'runtime';
		this.sectionHead(runtime, localize('claudeSettingsClaudeCode', "Claude Code"));
		const info = append(runtime, $('.claude-settings-card'));
		const row = (id: string, title: string, description: string, value: string) => {
			const item = append(info, $('.claude-settings-row'));
			item.dataset.row = id;
			const itemText = append(item, $('.claude-settings-row-text'));
			append(itemText, $('.claude-settings-row-title')).textContent = title;
			append(itemText, $('.claude-settings-row-description')).textContent = description;
			const control = append(item, $('.claude-settings-row-control'));
			append(control, $('span.claude-settings-value')).textContent = value;
			return { text: itemText, control };
		};
		this.renderSignInActions(row('signIn', localize('claudeSettingsSignIn', "Sign-In"), localize('claudeSettingsSignInDesc', "How Claude Code is signed in"), summary.label));
		row('version', localize('claudeSettingsVersion', "Claude Code Version"), localize('claudeSettingsVersionDesc', "The Claude Code that runs your agents"), this._runtimeState?.version ?? localize('claudeSettingsUnknown', "Unknown"));
	}

	/**
	 * Issue 536: Switch Account and Log Out after the sign-in method, or, for a
	 * sign-in Claude Code's log out does not reach, a faint line saying why (as DL-26).
	 */
	private renderSignInActions({ text, control }: { readonly text: HTMLElement; readonly control: HTMLElement }): void {
		const actions = claudeAccountActions(this._runtimeState);
		if (!actions) {
			return;
		}
		if (!actions.enabled) {
			const note = append(text, $('.claude-settings-row-managed'));
			append(note, $(ThemeIcon.asCSSSelector(this._runtimeState?.authMode === 'enterprise' ? Codicon.briefcase : Codicon.info)));
			append(note, $('span')).textContent = actions.reason ?? '';
			return;
		}
		const buttons: readonly [string, string, string][] = [
			['plan.switchAccount', localize('claudeSettingsSwitchAccount', "Switch Account..."), CLAUDE_SWITCH_ACCOUNT_COMMAND_ID],
			['plan.logOut', localize('claudeSettingsLogOut', "Log Out"), CLAUDE_LOG_OUT_COMMAND_ID],
		];
		for (const [focusKey, label, command] of buttons) {
			const button = append(control, $<HTMLButtonElement>('button.claude-btn.is-secondary.claude-settings-button'));
			button.type = 'button';
			button.textContent = label;
			button.dataset.focusKey = focusKey;
			this._focusables.set(focusKey, button);
			this._renderStore.add(addDisposableListener(button, EventType.CLICK, () => void this._commands.executeCommand(command)));
		}
	}

	/**
	 * Every signed-in account's last-seen limits side by side, the one that resets first marked
	 * (issue 1182). Only the account in use can be read live, so the others show when they were last seen.
	 */
	private renderAccountsUsage(element: HTMLElement): void {
		const now = Date.now();
		const rows = claudeAccountsUsageRows(this._accountList, this._knownUsage, now);
		if (!rows.length) {
			return;
		}
		const section = append(element, $('.claude-settings-subsection'));
		section.dataset.section = 'accountsUsage';
		this.sectionHead(section, localize('claudeSettingsAllAccounts', "All Accounts"));
		const card = append(section, $('.claude-settings-card'));
		for (const row of rows) {
			const item = append(card, $('.claude-settings-row'));
			item.dataset.row = `accountUsage:${row.accountId}`;
			const text = append(item, $('.claude-settings-row-text'));
			append(text, $('.claude-settings-row-title')).textContent = row.label;
			const parts = row.windows.map(window => localize('claudeSettingsAccountWindow', "{0} {1}%", claudeUsageWindowTitle(window), Math.round(window.percent)));
			append(text, $('.claude-settings-row-description')).textContent = parts.length
				? parts.join(' · ')
				: localize('claudeSettingsAccountNeverRead', "Not read yet. Switch to this account to see its limits.");
			const control = append(item, $('.claude-settings-row-control'));
			const note = row.resetsFirst
				? localize('claudeSettingsResetsFirst', "Resets first, {0}", fromNow(row.resetsAt!, true))
				: row.checkedAt !== undefined && !row.active
					? localize('claudeSettingsLastSeen', "Seen {0}", fromNow(row.checkedAt, true))
					: '';
			append(control, $('span.claude-settings-value')).textContent = note;
		}
	}

	private renderMeter(card: HTMLElement, window: ClaudeUsageWindow): void {
		const meter = append(card, $('.claude-settings-meter'));
		meter.dataset.row = window.kind === 'model' ? `usage:${window.label ?? 'model'}` : `usage:${window.kind}`;
		const percent = Math.round(window.percent);
		const title = claudeUsageWindowTitle(window);
		const head = append(meter, $('.claude-settings-meter-head'));
		append(head, $('span.title')).textContent = title;
		append(head, $('span.value')).textContent = localize('claudeSettingsUsed', "{0}% used", percent);
		const bar = append(meter, $('.claude-settings-meter-bar'));
		bar.setAttribute('role', 'meter');
		bar.setAttribute('aria-label', title);
		bar.setAttribute('aria-valuemin', '0');
		bar.setAttribute('aria-valuemax', '100');
		bar.setAttribute('aria-valuenow', String(percent));
		bar.classList.toggle('is-high', percent >= 80 && percent < 100);
		bar.classList.toggle('is-full', percent >= 100);
		append(bar, $('.fill')).style.width = `${Math.min(100, Math.max(0, window.percent))}%`;
		const note = claudeUsageWindowNote(window);
		append(meter, $('.claude-settings-meter-note')).textContent = window.resetsAt !== undefined && window.resetsAt > Date.now()
			? localize('claudeSettingsMeterReset', "{0}. Resets {1}", note, fromNow(window.resetsAt, true))
			: note;
	}

	//#endregion

	//#region Customize

	private renderCustomize(element: HTMLElement): void {
		const tabs = append(element, $('.claude-customize-tabs'));
		tabs.setAttribute('role', 'tablist');
		tabs.setAttribute('aria-label', localize('claudeCustomizeTabs', "Customize"));
		const tab = (id: 'installed' | 'discover', label: string) => {
			const button = append(tabs, $<HTMLButtonElement>('button.claude-customize-tab'));
			button.type = 'button';
			button.setAttribute('role', 'tab');
			button.dataset.tab = id;
			button.dataset.focusKey = `customize.tab:${id}`;
			this._focusables.set(button.dataset.focusKey, button);
			const selected = this._customizeTab === id;
			button.classList.toggle('is-selected', selected);
			button.setAttribute('aria-selected', String(selected));
			button.textContent = label;
			this._renderStore.add(addDisposableListener(button, EventType.CLICK, () => {
				this._customizeTab = id;
				this.render();
			}));
		};
		tab('installed', localize('claudeCustomizeInstalled', "Installed"));
		tab('discover', localize('claudeCustomizeDiscover', "Discover"));
		if (this._customizeTab === 'discover') {
			this.discover().render(element, this._focusables);
			return;
		}

		const bar = append(element, $('.claude-customize-bar'));
		const search = append(bar, $<HTMLInputElement>('input.claude-field.claude-customize-search'));
		search.type = 'search';
		search.placeholder = localize('claudeCustomizeFilter', "Filter MCP servers, skills, subagents, commands and hooks");
		search.setAttribute('aria-label', localize('claudeCustomizeFilterLabel', "Filter Customizations"));
		search.value = this._customizeQuery;
		search.dataset.focusKey = 'customize.search';
		this._focusables.set('customize.search', search);
		this._renderStore.add(addDisposableListener(search, EventType.INPUT, () => {
			this._customizeQuery = search.value;
			this.renderCustomizeList();
		}));
		// DL-15: Refresh is an icon button with its name in a hover, beside the field (issue 581).
		const refresh = append(bar, $<HTMLButtonElement>('button.claude-btn.is-icon.claude-customize-refresh'));
		refresh.type = 'button';
		refresh.dataset.focusKey = 'customize.refresh';
		this._focusables.set('customize.refresh', refresh);
		append(refresh, $(ThemeIcon.asCSSSelector(Codicon.refresh)));
		const refreshLabel = localize('claudeSettingsRefresh', "Refresh");
		refresh.setAttribute('aria-label', refreshLabel);
		this._renderStore.add(this._hover.setupDelayedHover(refresh, { content: refreshLabel, additionalClasses: ['claude-root'] }));
		this._renderStore.add(addDisposableListener(refresh, EventType.CLICK, () => void this.refreshOverview()));

		const chips = append(element, $('.claude-customize-chips'));
		chips.setAttribute('role', 'group');
		chips.setAttribute('aria-label', localize('claudeCustomizeKinds', "Show"));
		const chip = (kind: ClaudeCustomizeKind | undefined, label: string) => {
			const button = append(chips, $<HTMLButtonElement>('button.claude-chip.is-toggle.claude-customize-chip'));
			button.type = 'button';
			const key = `customize.chip:${kind ?? 'all'}`;
			button.dataset.focusKey = key;
			button.dataset.kind = kind ?? 'all';
			this._focusables.set(key, button);
			const selected = this._customizeKind === kind;
			button.classList.toggle('is-selected', selected);
			button.setAttribute('aria-pressed', String(selected));
			button.textContent = label;
			this._renderStore.add(addDisposableListener(button, EventType.CLICK, () => {
				this._customizeKind = kind;
				this.render();
			}));
		};
		chip(undefined, localize('claudeCustomizeAll', "All"));
		for (const kind of CLAUDE_CUSTOMIZE_KINDS) {
			chip(kind, claudeCustomizeKindLabel(kind));
		}

		this._customizeList = append(element, $('.claude-customize-list'));
		this.renderCustomizeList();
	}

	private renderCustomizeList(): void {
		const list = this._customizeList;
		if (!list) {
			return;
		}
		const active = getActiveElement();
		const focusKey = isHTMLElement(active) && list.contains(active) ? active.dataset.focusKey : undefined;
		this._customizeStore.clear();
		clearNode(list);
		const kinds = this._customizeKind ? [this._customizeKind] : CLAUDE_CUSTOMIZE_KINDS;
		const reported = this._overview?.commands !== undefined || this._overview?.mcpServers !== undefined || this._overview?.agents !== undefined;
		const source = this.customizeSource();
		let shown = 0;
		for (const kind of kinds) {
			const items = claudeCustomizeItems(source, kind, this._customizeQuery);
			const canCreate = kind === 'memory' && !this._customizeQuery && !this._memory.some(file => file.scope === 'project') && this._workspace.getWorkspace().folders.length > 0;
			const canAdd = !this._customizeQuery && this.canAdd(kind);
			const formOpen = canAdd && this._form === kind;
			// With every kind on show, empty kinds stay out of the way, unless they can be added to.
			if (items.length === 0 && kinds.length > 1 && !canCreate && !canAdd) {
				continue;
			}
			const group = append(list, $('.claude-customize-group'));
			group.dataset.kind = kind;
			const head = this.sectionHead(group, claudeCustomizeKindLabel(kind), items.length);
			if (canCreate) {
				this.headButton(head, 'customize.createMemory', Codicon.add, localize('claudeCustomizeCreateMemory', "Create CLAUDE.md"), () => void this.createProjectMemory(), this._customizeStore).classList.replace('is-ghost', 'is-secondary');
			}
			if (canAdd && (kind === 'mcp' || kind === 'hooks' || kind === 'network' || kind === 'permissions')) {
				const label = kind === 'mcp' ? localize('claudeCustomizeAddServer', "Add Server") : kind === 'hooks' ? localize('claudeCustomizeAddHook', "Add Hook") : kind === 'permissions' ? localize('claudeCustomizeAddPermission', "Add Rule") : localize('claudeCustomizeAddDomain', "Add Domain");
				const add = this.headButton(head, `customize.add:${kind}`, Codicon.add, label, () => this.toggleForm(kind), this._customizeStore);
				add.classList.replace('is-ghost', 'is-secondary');
				add.setAttribute('aria-expanded', String(formOpen));
			}
			if (canAdd && isClaudeCreateKind(kind)) {
				const add = this.headButton(head, `customize.add:${kind}`, Codicon.add, claudeCreateAddLabel(kind), () => this.toggleForm(kind), this._customizeStore);
				add.classList.replace('is-ghost', 'is-secondary');
				add.setAttribute('aria-expanded', String(formOpen));
			}
			if (formOpen) {
				if (kind === 'mcp') {
					this.renderMcpForm(group);
				} else if (kind === 'hooks') {
					this.renderHookForm(group);
				} else if (isClaudeCreateKind(kind)) {
					this.renderCreateForm(group, kind);
				} else if (kind === 'permissions') {
					this.renderPermissionForm(group);
				} else {
					this.renderNetworkForm(group);
				}
			}
			if (items.length === 0) {
				if (formOpen) {
					continue;
				}
				const empty = append(group, $('.claude-settings-card'));
				const note = append(empty, $('.claude-settings-row.is-note'));
				append(note, $('.claude-settings-row-description')).textContent = this.emptyText(kind, reported);
				continue;
			}
			const card = append(group, $('.claude-settings-card.claude-customize-card'));
			for (const item of items) {
				this.renderCustomizeItem(card, item);
				shown++;
			}
		}
		if (kinds.length > 1 && shown === 0 && !list.firstChild) {
			const empty = append(list, $('.claude-settings-card'));
			const note = append(empty, $('.claude-settings-row.is-note'));
			append(note, $('.claude-settings-row-description')).textContent = this._customizeQuery
				? localize('claudeCustomizeNoMatch', "Nothing matches \"{0}\".", this._customizeQuery.trim())
				: this.emptyText(undefined, reported);
		}
		if (focusKey) {
			this._focusables.get(focusKey)?.focus();
		}
		this._scrollable.scanDomNode();
	}

	/** Customize's Discover tab, made the first time it shows (desktop only: it needs the shared process). */
	private discover(): ClaudeCustomizeDiscover {
		if (!this._discover) {
			this._discover = this._register(this._instantiation.createInstance(ClaudeCustomizeDiscover, {
				layout: () => this._scrollable.scanDomNode(),
				changed: () => void this.refreshOverview(),
				openChat: () => void this._commands.executeCommand(CLAUDE_FOCUS_AGENT_COMMAND_ID),
			}));
		}
		return this._discover;
	}

	private customizeSource(): ClaudeCustomizeSource {
		return { overview: this._overview, memory: this._memory, hooks: this._hooks, networkRules: this._networkRules, claudeCodeHooks: this._claudeCodeHooks, claudeCodeNetworkRules: this._claudeCodeNetworkRules, permissionRules: this._permissionRules, claudeCodePermissionRules: this._claudeCodePermissionRules, addedMcp: this._addedMcp, removedMcp: this._removedMcp, plugins: this._installedPlugins, rules: this._createFiles.rules, created: this._createFiles.created };
	}

	private canAdd(kind: ClaudeCustomizeKind): boolean {
		switch (kind) {
			case 'mcp': return !!this._runtime.addMcpServer;
			case 'hooks':
			case 'network':
			case 'permissions': return this._hookFiles.size > 0;
			case 'skills':
			case 'subagents':
			case 'commands':
			case 'rules': return this._createFiles.scopes.length > 0;
			default: return false;
		}
	}

	/** The local folder `claude mcp` runs in, so project and local scopes land in this project. */
	private projectCwd(): string | undefined {
		const folder = this._workspace.getWorkspace().folders[0];
		return folder?.uri.scheme === Schemas.file ? folder.uri.fsPath : undefined;
	}

	private mcpScopes(): readonly ClaudeMcpScope[] {
		// Never `local`: Claude Code keeps those in ~/.claude.json, which Klawly does not write (issue 455).
		return this.projectCwd() ? ['user', 'project'] : ['user'];
	}

	private hookScopes(): ClaudeHookScope[] {
		return CLAUDE_HOOK_SCOPES.filter(scope => this._hookFiles.has(scope));
	}

	private toggleForm(kind: ClaudeCustomizeForm): void {
		this._form = this._form === kind ? undefined : kind;
		this._formError = '';
		this.renderCustomizeList();
		this._focusables.get(this._form ? `customize.${kind}.first` : `customize.add:${kind}`)?.focus();
	}

	private closeForm(): void {
		const kind = this._form;
		if (!kind) {
			return;
		}
		this._form = undefined;
		this._formError = '';
		this.renderCustomizeList();
		this._focusables.get(`customize.add:${kind}`)?.focus();
	}

	/** One labelled row of an add form; returns the slot its control goes in. */
	private formRow(card: HTMLElement, id: string, title: string, description: string): HTMLElement {
		const row = append(card, $('.claude-settings-row'));
		row.dataset.row = id;
		const text = append(row, $('.claude-settings-row-text'));
		append(text, $('.claude-settings-row-title')).textContent = title;
		append(text, $('.claude-settings-row-description')).textContent = description;
		return append(row, $('.claude-settings-row-control'));
	}

	private formInput(slot: HTMLElement, focusKey: string, label: string, placeholder: string, value: string, change: (value: string) => void, submit: () => void): HTMLInputElement {
		const input = append(slot, $<HTMLInputElement>('input.claude-field.claude-settings-input'));
		input.type = 'text';
		input.spellcheck = false;
		input.placeholder = placeholder;
		input.value = value;
		input.setAttribute('aria-label', label);
		input.dataset.focusKey = focusKey;
		this._focusables.set(focusKey, input);
		this._customizeStore.add(addDisposableListener(input, EventType.INPUT, () => change(input.value)));
		this._customizeStore.add(addDisposableListener(input, EventType.KEY_DOWN, event => {
			if (event.key === 'Enter') {
				event.preventDefault();
				submit();
			} else if (event.key === 'Escape') {
				event.preventDefault();
				event.stopPropagation();
				this.closeForm();
			}
		}));
		return input;
	}

	private formSelect(slot: HTMLElement, focusKey: string, title: string, options: readonly ClaudeSettingsOption[], current: string, pick: (value: string) => void): void {
		this.renderSelect(slot, focusKey, title, options, current, value => {
			pick(value);
			this.renderCustomizeList();
			this._focusables.get(focusKey)?.focus();
		});
	}

	/** The error or note line and the Cancel and Add buttons under a form. */
	private formFoot(card: HTMLElement, kind: ClaudeCustomizeForm, label: string, submit: () => void): HTMLElement {
		const foot = append(card, $('.claude-customize-form-foot'));
		const note = append(foot, $('.claude-customize-form-note'));
		note.classList.toggle('is-error', !!this._formError);
		note.setAttribute('aria-live', 'polite');
		note.textContent = this._formError || localize('claudeCustomizeNextSession', "Sessions started after this pick it up.");
		const cancel = append(foot, $<HTMLButtonElement>('button.claude-btn.is-ghost'));
		cancel.type = 'button';
		cancel.textContent = localize('claudeCustomizeCancel', "Cancel");
		cancel.dataset.focusKey = `customize.${kind}.cancel`;
		this._focusables.set(cancel.dataset.focusKey, cancel);
		this._customizeStore.add(addDisposableListener(cancel, EventType.CLICK, () => this.closeForm()));
		const add = append(foot, $<HTMLButtonElement>('button.claude-btn.is-primary'));
		add.type = 'button';
		add.textContent = label;
		add.disabled = this._formBusy;
		add.dataset.focusKey = `customize.${kind}.submit`;
		this._focusables.set(add.dataset.focusKey, add);
		this._customizeStore.add(addDisposableListener(add, EventType.CLICK, submit));
		return foot;
	}

	private renderMcpForm(group: HTMLElement): void {
		const draft = this._mcpDraft;
		const scopes = this.mcpScopes();
		if (!scopes.includes(draft.scope)) {
			draft.scope = scopes[0];
		}
		const card = append(group, $('.claude-settings-card.claude-customize-form'));
		card.dataset.form = 'mcp';
		const submit = () => void this.addMcpServer();
		this.formInput(this.formRow(card, 'mcpName', localize('claudeMcpFormName', "Name"), localize('claudeMcpFormNameDesc', "How Claude Code names it and its tools")),
			'customize.mcp.first', localize('claudeMcpFormName', "Name"), 'github', draft.name, value => draft.name = value, submit);
		this.formSelect(this.formRow(card, 'mcpScope', localize('claudeMcpFormScope', "Scope"), localize('claudeMcpFormScopeDesc', "Who the server is for")), 'customize.mcp.scope', localize('claudeMcpFormScope', "Scope"), scopes.map(scope => ({
			value: scope,
			label: claudeWhereLabel(scope),
			description: scope === 'project' ? '.mcp.json' : claudeUserLayerLabel(this._product.dataFolderName, CLAUDE_USER_LAYER_FILES.mcp),
		})), draft.scope, value => draft.scope = value as ClaudeMcpScope);
		this.formSelect(this.formRow(card, 'mcpTransport', localize('claudeMcpFormTransport', "Transport"), localize('claudeMcpFormTransportDesc', "How Claude Code reaches the server")), 'customize.mcp.transport', localize('claudeMcpFormTransport', "Transport"), [
			{ value: 'stdio', label: localize('claudeMcpStdio', "Command"), description: localize('claudeMcpStdioDesc', "Claude Code starts it and talks over stdio") },
			{ value: 'http', label: localize('claudeMcpHttp', "HTTP"), description: localize('claudeMcpHttpDesc', "A server at a URL") },
			{ value: 'sse', label: localize('claudeMcpSse', "SSE"), description: localize('claudeMcpSseDesc', "A server at a URL, with server-sent events") },
		], draft.transport, value => draft.transport = value as ClaudeMcpTransport);
		const stdio = draft.transport === 'stdio';
		const targetLabel = stdio ? localize('claudeMcpFormCommand', "Command") : localize('claudeMcpFormUrl', "URL");
		this.formInput(this.formRow(card, 'mcpTarget', targetLabel, stdio ? localize('claudeMcpFormCommandDesc', "What starts the server") : localize('claudeMcpFormUrlDesc', "Where the server listens")),
			'customize.mcp.target', targetLabel, stdio ? 'npx -y @scope/server' : 'https://example.com/mcp', draft.target, value => draft.target = value, submit);
		this.formFoot(card, 'mcp', localize('claudeCustomizeAddServer', "Add Server"), submit);
	}

	private renderHookForm(group: HTMLElement): void {
		const draft = this._hookDraft;
		const scopes = this.hookScopes();
		if (!scopes.includes(draft.scope)) {
			draft.scope = scopes[0];
		}
		const card = append(group, $('.claude-settings-card.claude-customize-form'));
		card.dataset.form = 'hooks';
		const submit = () => void this.addHook();
		this.formSelect(this.formRow(card, 'hookEvent', localize('claudeHookFormEvent', "Event"), localize('claudeHookFormEventDesc', "When the command runs")), 'customize.hooks.first', localize('claudeHookFormEvent', "Event"),
			CLAUDE_HOOK_EVENTS.map(event => ({ value: event, label: event, description: hookEventDescription(event) })), draft.event, value => draft.event = value);
		if (claudeHookTakesMatcher(draft.event)) {
			this.formInput(this.formRow(card, 'hookMatcher', localize('claudeHookFormMatcher', "Tools"), localize('claudeHookFormMatcherDesc', "Tool names, such as Bash or Edit|Write. Empty matches all")),
				'customize.hooks.matcher', localize('claudeHookFormMatcher', "Tools"), 'Bash', draft.matcher, value => draft.matcher = value, submit);
		}
		this.formInput(this.formRow(card, 'hookCommand', localize('claudeHookFormCommand', "Command"), localize('claudeHookFormCommandDesc', "The shell command Claude Code runs")),
			'customize.hooks.command', localize('claudeHookFormCommand', "Command"), 'npm run lint', draft.command, value => draft.command = value, submit);
		this.formSelect(this.formRow(card, 'hookScope', localize('claudeHookFormScope', "Saved In"), localize('claudeHookFormScopeDesc', "Which Claude Code settings file holds it")), 'customize.hooks.scope', localize('claudeHookFormScope', "Saved In"), scopes.map(scope => ({
			value: scope,
			label: claudeWhereLabel(scope),
			description: this.hookFileLabel(scope),
		})), draft.scope, value => draft.scope = value as ClaudeHookScope);
		this.formFoot(card, 'hooks', localize('claudeCustomizeAddHook', "Add Hook"), submit);
	}

	private renderPermissionForm(group: HTMLElement): void {
		const draft = this._permissionDraft;
		const scopes = this.hookScopes();
		if (!scopes.includes(draft.scope)) {
			draft.scope = scopes[0];
		}
		const card = append(group, $('.claude-settings-card.claude-customize-form'));
		card.dataset.form = 'permissions';
		const submit = () => void this.addPermissionRule();
		this.formInput(this.formRow(card, 'permissionRule', localize('claudePermissionFormRule', "Rule"), localize('claudePermissionFormRuleDesc', "A tool, or a tool with what it covers, as Claude Code writes it: Bash(npm run test:*), Read(./.env), mcp__github")),
			'customize.permissions.first', localize('claudePermissionFormRule', "Rule"), 'Bash(npm run test:*)', draft.rule, value => draft.rule = value, submit);
		this.formSelect(this.formRow(card, 'permissionEffect', localize('claudePermissionFormEffect', "Effect"), localize('claudePermissionFormEffectDesc', "A deny rule wins over an allow rule from any file")), 'customize.permissions.effect', localize('claudePermissionFormEffect', "Effect"), [
			{ value: 'deny', label: localize('claudePermissionDeny', "Deny"), description: localize('claudePermissionDenyDesc', "Claude Code never does it, and never asks") },
			{ value: 'allow', label: localize('claudePermissionAllow', "Allow"), description: localize('claudePermissionAllowDesc', "Claude Code does it without asking") },
		], draft.effect, value => draft.effect = value as ClaudePermissionEffect);
		this.formSelect(this.formRow(card, 'permissionScope', localize('claudeHookFormScope', "Saved In"), localize('claudeHookFormScopeDesc', "Which Claude Code settings file holds it")), 'customize.permissions.scope', localize('claudeHookFormScope', "Saved In"), scopes.map(scope => ({
			value: scope,
			label: claudeWhereLabel(scope),
			description: this.hookFileLabel(scope),
		})), draft.scope, value => draft.scope = value as ClaudeHookScope);
		this.formFoot(card, 'permissions', localize('claudeCustomizeAddPermission', "Add Rule"), submit);
	}

	private renderNetworkForm(group: HTMLElement): void {
		const draft = this._networkDraft;
		const scopes = this.hookScopes();
		if (!scopes.includes(draft.scope)) {
			draft.scope = scopes[0];
		}
		const card = append(group, $('.claude-settings-card.claude-customize-form'));
		card.dataset.form = 'network';
		const submit = () => void this.addNetworkRule();
		this.formInput(this.formRow(card, 'networkDomain', localize('claudeNetworkFormDomain', "Domain"), localize('claudeNetworkFormDomainDesc', "A host name. Start it with *. to cover its subdomains")),
			'customize.network.first', localize('claudeNetworkFormDomain', "Domain"), 'github.com', draft.domain, value => draft.domain = value, submit);
		this.formSelect(this.formRow(card, 'networkEffect', localize('claudeNetworkFormEffect', "Rule"), localize('claudeNetworkFormEffectDesc', "Written as a WebFetch permission rule and in the sandbox network list")), 'customize.network.effect', localize('claudeNetworkFormEffect', "Rule"), [
			{ value: 'allow', label: localize('claudeNetworkAllow', "Allow"), description: localize('claudeNetworkAllowDesc', "Claude Code reaches it without asking") },
			{ value: 'deny', label: localize('claudeNetworkDeny', "Deny"), description: localize('claudeNetworkDenyDesc', "Claude Code never reaches it") },
		], draft.effect, value => draft.effect = value as ClaudeNetworkEffect);
		this.formSelect(this.formRow(card, 'networkScope', localize('claudeHookFormScope', "Saved In"), localize('claudeHookFormScopeDesc', "Which Claude Code settings file holds it")), 'customize.network.scope', localize('claudeHookFormScope', "Saved In"), scopes.map(scope => ({
			value: scope,
			label: claudeWhereLabel(scope),
			description: this.hookFileLabel(scope),
		})), draft.scope, value => draft.scope = value as ClaudeHookScope);
		this.formFoot(card, 'network', localize('claudeCustomizeAddDomain', "Add Domain"), submit);
	}

	/** Add Skill, Add Subagent, Add Command or Add Rule: the fields of Claude Code's file format for the kind (issue 500). */
	private renderCreateForm(group: HTMLElement, kind: ClaudeCreateKind): void {
		const draft = this._createDraft;
		const scopes = this._createFiles.scopes;
		if (!scopes.includes(draft.scope)) {
			draft.scope = scopes[0];
		}
		const card = append(group, $('.claude-settings-card.claude-customize-form'));
		card.dataset.form = kind;
		const submit = () => void this.createCustomization(kind);
		const placeholder = kind === 'skills' ? 'release-notes' : kind === 'subagents' ? 'code-reviewer' : kind === 'commands' ? 'fix-issue' : 'api-style';
		this.formInput(this.formRow(card, 'createName', localize('claudeCreateFormName', "Name"), localize('claudeCreateFormNameDesc', "Lowercase letters, digits and dashes. Saved in {0}", claudeCreatePathLabel(kind, draft.scope, undefined, this._product.dataFolderName))),
			`customize.${kind}.first`, localize('claudeCreateFormName', "Name"), placeholder, draft.name, value => draft.name = value, submit);
		if (kind !== 'rules') {
			const description = kind === 'skills' ? localize('claudeCreateFormSkillDesc', "What it does and when Claude should use it. Claude Code picks skills by this line")
				: kind === 'subagents' ? localize('claudeCreateFormSubagentDesc', "When Claude should hand work to it. Claude Code picks subagents by this line")
					: localize('claudeCreateFormCommandDesc', "What the / menu shows next to it. Optional");
			this.formInput(this.formRow(card, 'createDescription', localize('claudeCreateFormDescription', "Description"), description),
				`customize.${kind}.description`, localize('claudeCreateFormDescription', "Description"), '', draft.description, value => draft.description = value, submit);
		}
		if (kind === 'subagents') {
			this.formSelect(this.formRow(card, 'createModel', localize('claudeCreateFormModel', "Model"), localize('claudeCreateFormModelDesc', "The Claude model it runs on")), `customize.${kind}.model`, localize('claudeCreateFormModel', "Model"), [
				{ value: CLAUDE_SUBAGENT_INHERIT_MODEL, label: localize('claudeCreateModelInherit', "Same as the Chat"), description: localize('claudeCreateModelInheritDesc', "The model of the conversation that starts it") },
				...(this._models ?? []).map(model => ({ value: model.id, label: model.displayName, description: model.description })),
			], draft.model, value => draft.model = value);
			this.formInput(this.formRow(card, 'createTools', localize('claudeCreateFormTools', "Tools"), localize('claudeCreateFormToolsDesc', "Tool names, comma separated, such as Read, Grep, Bash. Empty gives it every tool")),
				`customize.${kind}.tools`, localize('claudeCreateFormTools', "Tools"), 'Read, Grep, Glob', draft.tools, value => draft.tools = value, submit);
		}
		if (kind === 'rules') {
			this.formInput(this.formRow(card, 'createPaths', localize('claudeCreateFormPaths', "Paths"), localize('claudeCreateFormPathsDesc', "Globs, comma separated. Claude Code loads the rule when it works on a matching file. Empty loads it in every session")),
				`customize.${kind}.paths`, localize('claudeCreateFormPaths', "Paths"), 'src/**/*.ts', draft.paths, value => draft.paths = value, submit);
		}
		// DL-12: Saved In only when there is a choice; with no folder open the file goes in ~/.klawly/claude.
		if (scopes.length > 1) {
			this.formSelect(this.formRow(card, 'createScope', localize('claudeHookFormScope', "Saved In"), localize('claudeCreateFormScopeDesc', "The project's .claude folder, or yours in every project")), `customize.${kind}.scope`, localize('claudeHookFormScope', "Saved In"), scopes.map(scope => ({
				value: scope,
				label: claudeWhereLabel(scope),
				description: claudeCreatePathLabel(kind, scope, undefined, this._product.dataFolderName),
			})), draft.scope, value => draft.scope = value as ClaudeCreateScope);
		}
		const foot = this.formFoot(card, kind, claudeCreateAddLabel(kind), submit);
		// Create with Claude sits before Cancel: a chat that asks what to write, then writes the same file.
		const withClaude = $<HTMLButtonElement>('button.claude-btn.is-ghost');
		withClaude.type = 'button';
		withClaude.textContent = localize('claudeCreateWithClaude', "Create with Claude");
		withClaude.dataset.focusKey = `customize.${kind}.withClaude`;
		this._focusables.set(withClaude.dataset.focusKey, withClaude);
		this._customizeStore.add(this._hover.setupDelayedHover(withClaude, { content: localize('claudeCreateWithClaudeHover', "Start a chat in which Claude asks what it should do, then writes the file"), additionalClasses: ['claude-root'] }));
		this._customizeStore.add(addDisposableListener(withClaude, EventType.CLICK, () => this.createWithClaude(kind)));
		foot.insertBefore(withClaude, foot.children[1] ?? null);
	}

	/** Writes the new file in Claude Code's format, then opens it to fill in. */
	private async createCustomization(kind: ClaudeCreateKind): Promise<void> {
		const draft = this._createDraft;
		if (this._formBusy) {
			return;
		}
		draft.name = draft.name.trim();
		if (!isClaudeCreateName(draft.name)) {
			return this.formFailed(localize('claudeCreateBadName', "Name it with lowercase letters, digits and dashes, starting with a letter or digit."), `customize.${kind}.first`);
		}
		if (claudeCreateNeedsDescription(kind) && !draft.description.trim()) {
			return this.formFailed(localize('claudeCreateNoDescription', "Describe when Claude should use it. Claude Code picks it by this line."), `customize.${kind}.description`);
		}
		this._formBusy = true;
		this._formError = '';
		this.renderCustomizeList();
		try {
			const resource = await this._createFiles.create(kind, draft);
			await this._createFiles.refresh(this.useClaudeCodeSetup());
			this._createDraft = emptyClaudeCreateDraft(draft.scope);
			this._formBusy = false;
			this.closeForm();
			await this._editors.openEditor({ resource });
		} catch (error) {
			this._formBusy = false;
			this.formFailed(errorMessage(error), `customize.${kind}.submit`);
		}
	}

	/** Starts a new chat with Klawly's prompt for the kind and what the form holds so far. */
	private createWithClaude(kind: ClaudeCreateKind): void {
		this._createFiles.startChat(kind, this._createDraft);
		this._createDraft = emptyClaudeCreateDraft(this._createDraft.scope);
		this.closeForm();
		void this._commands.executeCommand(CLAUDE_FOCUS_AGENT_COMMAND_ID);
	}

	private formFailed(message: string, focusKey: string): void {
		this._formError = message;
		this.renderCustomizeList();
		this._focusables.get(focusKey)?.focus();
	}

	private async addMcpServer(): Promise<void> {
		const add = this._runtime.addMcpServer;
		if (this._formBusy || !add) {
			return;
		}
		const draft = this._mcpDraft;
		const name = draft.name.trim();
		const config = claudeMcpServerConfig(draft.transport, draft.target.trim());
		if (!isClaudeMcpServerName(name)) {
			return this.formFailed(localize('claudeMcpBadName', "Name the server with letters, digits, dots, dashes or underscores, starting with a letter or digit."), 'customize.mcp.first');
		}
		if (!config) {
			return this.formFailed(draft.transport === 'stdio' ? localize('claudeMcpBadCommand', "Enter the command that starts the server.") : localize('claudeMcpBadUrl', "Enter an http or https URL."), 'customize.mcp.target');
		}
		const request: ClaudeMcpAddRequest = { name, scope: this.mcpScopes().includes(draft.scope) ? draft.scope : 'user', config, cwd: this.projectCwd() };
		this._formBusy = true;
		this._formError = '';
		this.renderCustomizeList();
		try {
			await this._runtime.addMcpServer?.(request);
			this._addedMcp = [...this._addedMcp.filter(added => added.name !== name), request];
			this._removedMcp.delete(claudeMcpKey(request.scope, name));
			this._mcpDraft = emptyMcpDraft();
			this._formBusy = false;
			this.closeForm();
		} catch (error) {
			this._formBusy = false;
			this.formFailed(errorMessage(error), 'customize.mcp.submit');
		}
	}

	private async controlMcpServer(item: ClaudeCustomizeItem, action: ClaudeMcpControlAction): Promise<void> {
		try {
			this._overview = await this._runtime.controlMcpServer!(item.name, action);
			this.render();
		} catch (error) {
			this._notifications.error(localize('claudeMcpControlFailed', "Couldn't change {0}: {1}", item.name, redactSecrets(error instanceof Error ? error.message : String(error))));
		}
	}

	/** Fills the Claude MCP Logs channel with the server's newest log and shows it (issue 512). */
	private async showMcpLog(item: ClaudeCustomizeItem): Promise<void> {
		const cwd = this._workspace.getWorkspace().folders.find(folder => folder.uri.scheme === Schemas.file)?.uri.fsPath ?? '';
		const log = await this._runtime.readMcpServerLog!(item.name, cwd).catch(() => ({ lines: [] as readonly string[], file: undefined }));
		if (!log.lines.length) {
			this._notifications.info(localize('claudeMcpNoLog', "Claude Code hasn't written a log for {0} yet. Logs appear once a session starts the server.", item.name));
			return;
		}
		const channel = this._output.getChannel(CLAUDE_MCP_LOG_CHANNEL_ID);
		channel?.replace([localize('claudeMcpLogHeader', "{0}: {1}", item.name, log.file ?? ''), ...log.lines, ''].join('\n'));
		await this._output.showChannel(CLAUDE_MCP_LOG_CHANNEL_ID, true);
	}

	private async removeMcpServer(item: ClaudeCustomizeItem): Promise<void> {
		const remove = this._runtime.removeMcpServer;
		const scope = item.mcpScope;
		if (!remove || !scope) {
			return;
		}
		const { confirmed } = await this._dialogs.confirm({
			message: localize('claudeMcpRemoveConfirm', "Remove the {0} MCP server?", item.name),
			detail: localize('claudeMcpRemoveDetail', "Klawly removes it from {0}. Sessions started after this no longer load it.", scope === 'user' ? claudeUserLayerLabel(this._product.dataFolderName, CLAUDE_USER_LAYER_FILES.mcp) : '.mcp.json'),
			primaryButton: localize('claudeCustomizeRemove', "Remove"),
		});
		if (!confirmed) {
			return;
		}
		try {
			await this._runtime.removeMcpServer?.({ name: item.id, scope, cwd: this.projectCwd() });
			this._addedMcp = this._addedMcp.filter(added => !(added.name === item.id && added.scope === scope));
			this._removedMcp.add(claudeMcpKey(scope, item.id));
		} catch (error) {
			this._notifications.error(errorMessage(error));
		}
		this.renderCustomizeList();
	}

	/** A settings file's text and what a write needs to refuse a file changed since. Empty when the file is not there. */
	private async readSettingsFile(resource: URI): Promise<{ text: string; write?: IWriteFileOptions }> {
		try {
			const content = await this._files.readFile(resource);
			return { text: content.value.toString(), write: { etag: content.etag, mtime: content.mtime } };
		} catch (error) {
			if (error instanceof FileOperationError && error.fileOperationResult === FileOperationResult.FILE_NOT_FOUND) {
				return { text: '' };
			}
			throw error;
		}
	}

	private async addHook(): Promise<void> {
		const draft = this._hookDraft;
		const resource = this._hookFiles.get(draft.scope);
		if (this._formBusy || !resource) {
			return;
		}
		if (!isClaudeHookCommand(draft.command)) {
			return this.formFailed(localize('claudeHookBadCommand', "Enter the one-line command the hook runs."), 'customize.hooks.command');
		}
		this._formBusy = true;
		this._formError = '';
		this.renderCustomizeList();
		let failure: string | undefined;
		try {
			const { text, write } = await this.readSettingsFile(resource);
			const next = addClaudeHook(text, draft.event, claudeHookTakesMatcher(draft.event) ? draft.matcher : undefined, draft.command);
			if (next === undefined) {
				failure = localize('claudeHookBadFile', "{0} is not valid JSON, or its hooks are not shaped the way Claude Code reads them, so nothing was written. Fix the file first.", this.hookFileLabel(draft.scope));
			} else {
				await this._files.writeFile(resource, VSBuffer.fromString(next), write);
			}
		} catch (error) {
			failure = errorMessage(error);
		}
		this._formBusy = false;
		await this.findHooks();
		if (failure) {
			return this.formFailed(failure, 'customize.hooks.submit');
		}
		this._hookDraft = { ...emptyHookDraft(), event: draft.event, scope: draft.scope };
		this.closeForm();
	}

	private async removeHook(hook: ClaudeHookEntry): Promise<void> {
		const resource = this._hookFiles.get(hook.scope);
		if (!resource) {
			return;
		}
		const { confirmed } = await this._dialogs.confirm({
			message: localize('claudeHookRemoveConfirm', "Remove the {0} hook?", hook.event),
			detail: localize('claudeHookRemoveDetail', "It runs {0}. Klawly removes it from {1}.", hook.command, this.hookFileLabel(hook.scope)),
			primaryButton: localize('claudeCustomizeRemove', "Remove"),
		});
		if (!confirmed) {
			return;
		}
		try {
			const { text, write } = await this.readSettingsFile(resource);
			const next = removeClaudeHook(text, hook);
			if (next === undefined) {
				this._notifications.warn(localize('claudeHookChanged', "{0} changed since the list was read, so nothing was removed. The list now shows the file as it is.", this.hookFileLabel(hook.scope)));
			} else {
				await this._files.writeFile(resource, VSBuffer.fromString(next), write);
			}
		} catch (error) {
			this._notifications.error(errorMessage(error));
		}
		await this.findHooks();
		this.renderCustomizeList();
	}

	/** Allows or denies a domain in a Claude Code settings file, as a WebFetch rule and in the sandbox network list. */
	private async addNetworkRule(): Promise<void> {
		const draft = this._networkDraft;
		const resource = this._hookFiles.get(draft.scope);
		if (this._formBusy || !resource) {
			return;
		}
		if (!isClaudeNetworkDomain(draft.domain)) {
			return this.formFailed(localize('claudeNetworkBadDomain', "Enter a host name such as github.com or *.github.com, without https:// or a path."), 'customize.network.first');
		}
		this._formBusy = true;
		this._formError = '';
		this.renderCustomizeList();
		let failure: string | undefined;
		try {
			const { text, write } = await this.readSettingsFile(resource);
			const next = addClaudeNetworkRule(text, draft.domain, draft.effect);
			if (next === undefined) {
				failure = localize('claudeNetworkBadFile', "{0} is not valid JSON, or its permissions or sandbox settings are not shaped the way Claude Code reads them, so nothing was written. Fix the file first.", this.hookFileLabel(draft.scope));
			} else if (next !== text) {
				await this._files.writeFile(resource, VSBuffer.fromString(next), write);
			}
		} catch (error) {
			failure = errorMessage(error);
		}
		this._formBusy = false;
		await this.findHooks();
		if (failure) {
			return this.formFailed(failure, 'customize.network.submit');
		}
		this._networkDraft = { ...emptyNetworkDraft(), effect: draft.effect, scope: draft.scope };
		this.closeForm();
	}

	/** Allows or denies a permission rule in a Claude Code settings file. Only its `permissions.allow` or `permissions.deny` list changes. */
	private async addPermissionRule(): Promise<void> {
		const draft = this._permissionDraft;
		const resource = this._hookFiles.get(draft.scope);
		if (this._formBusy || !resource) {
			return;
		}
		if (!isClaudePermissionRule(draft.rule)) {
			return this.formFailed(localize('claudePermissionBadRule', "Enter a tool name such as Bash, or a tool with what it covers in brackets, such as Bash(npm run test:*). The brackets must match."), 'customize.permissions.first');
		}
		this._formBusy = true;
		this._formError = '';
		this.renderCustomizeList();
		let failure: string | undefined;
		try {
			const { text, write } = await this.readSettingsFile(resource);
			// A rule any other file denies is never allowed from here, so a deny rule keeps its force.
			const denied = new Set([...this._permissionRules, ...this._claudeCodePermissionRules].filter(rule => rule.effect === 'deny').map(rule => rule.rule));
			const next = addClaudePermissionRule(text, draft.rule, draft.effect, denied);
			if (hasKey(next, { failure: true })) {
				failure = next.failure === 'denied'
					? localize('claudePermissionDeniedAlready', "A deny rule already covers {0}, and a deny rule wins over an allow rule, so nothing was written. Remove the deny rule first if you mean to allow it.", draft.rule.trim())
					: next.failure === 'invalid'
						? localize('claudePermissionBadRuleWrite', "That is not a rule Claude Code reads, so nothing was written. Domain rules are in Network Domains.")
						: localize('claudePermissionBadFile', "{0} is not valid JSON, or its permissions are not shaped the way Claude Code reads them, so nothing was written. Fix the file first.", this.hookFileLabel(draft.scope));
			} else if (next.text !== text) {
				await this._files.writeFile(resource, VSBuffer.fromString(next.text), write);
			}
		} catch (error) {
			failure = errorMessage(error);
		}
		this._formBusy = false;
		await this.findHooks();
		if (failure) {
			return this.formFailed(failure, 'customize.permissions.submit');
		}
		this._permissionDraft = { ...emptyPermissionDraft(), effect: draft.effect, scope: draft.scope };
		this.closeForm();
	}

	private async removePermissionRule(rule: ClaudePermissionRule): Promise<void> {
		const resource = this._hookFiles.get(rule.scope);
		if (!resource) {
			return;
		}
		const { confirmed } = await this._dialogs.confirm({
			message: rule.effect === 'allow' ? localize('claudePermissionRemoveAllowConfirm', "Stop allowing {0}?", rule.rule) : localize('claudePermissionRemoveDenyConfirm', "Stop denying {0}?", rule.rule),
			detail: rule.effect === 'allow'
				? localize('claudePermissionRemoveAllowDetail', "Klawly removes it from permissions.allow in {0}. Claude Code asks before it does this again.", this.hookFileLabel(rule.scope))
				: localize('claudePermissionRemoveDenyDetail', "Klawly removes it from permissions.deny in {0}. Claude Code may do this again, and asks first unless another rule allows it.", this.hookFileLabel(rule.scope)),
			primaryButton: localize('claudeCustomizeRemove', "Remove"),
		});
		if (!confirmed) {
			return;
		}
		try {
			const { text, write } = await this.readSettingsFile(resource);
			const next = removeClaudePermissionRule(text, rule);
			if (next === undefined) {
				this._notifications.warn(localize('claudeHookChanged', "{0} changed since the list was read, so nothing was removed. The list now shows the file as it is.", this.hookFileLabel(rule.scope)));
			} else {
				await this._files.writeFile(resource, VSBuffer.fromString(next), write);
			}
		} catch (error) {
			this._notifications.error(errorMessage(error));
		}
		await this.findHooks();
		this.renderCustomizeList();
	}

	private async removeNetworkRule(rule: ClaudeNetworkRule): Promise<void> {
		const resource = this._hookFiles.get(rule.scope);
		if (!resource) {
			return;
		}
		const { confirmed } = await this._dialogs.confirm({
			message: rule.effect === 'allow' ? localize('claudeNetworkRemoveAllowConfirm', "Stop allowing {0}?", rule.domain) : localize('claudeNetworkRemoveDenyConfirm', "Stop denying {0}?", rule.domain),
			detail: localize('claudeNetworkRemoveDetail', "Klawly removes its WebFetch rule and its sandbox network entry from {0}.", this.hookFileLabel(rule.scope)),
			primaryButton: localize('claudeCustomizeRemove', "Remove"),
		});
		if (!confirmed) {
			return;
		}
		try {
			const { text, write } = await this.readSettingsFile(resource);
			const next = removeClaudeNetworkRule(text, rule);
			if (next === undefined) {
				this._notifications.warn(localize('claudeHookChanged', "{0} changed since the list was read, so nothing was removed. The list now shows the file as it is.", this.hookFileLabel(rule.scope)));
			} else {
				await this._files.writeFile(resource, VSBuffer.fromString(next), write);
			}
		} catch (error) {
			this._notifications.error(errorMessage(error));
		}
		await this.findHooks();
		this.renderCustomizeList();
	}

	/** A quiet icon button at the end of a Customize row. */
	private itemAction(row: HTMLElement, focusKey: string, icon: ThemeIcon, label: string, run: () => void, store = this._customizeStore): void {
		const button = append(row, $<HTMLButtonElement>('button.claude-icon-btn.claude-customize-action'));
		button.type = 'button';
		button.setAttribute('aria-label', label);
		button.dataset.focusKey = focusKey;
		this._focusables.set(focusKey, button);
		append(button, $(ThemeIcon.asCSSSelector(icon)));
		store.add(this._hover.setupDelayedHover(button, { content: label, additionalClasses: ['claude-root'] }));
		store.add(addDisposableListener(button, EventType.CLICK, run));
	}

	private emptyText(kind: ClaudeCustomizeKind | undefined, reported: boolean): string {
		if (this._customizeQuery.trim()) {
			return localize('claudeCustomizeNoMatch', "Nothing matches \"{0}\".", this._customizeQuery.trim());
		}
		if (kind === 'hooks') {
			return localize('claudeCustomizeNoHooks', "No hooks in your Claude Code settings. A hook runs a command when Claude Code reaches an event, such as before a tool runs.");
		}
		if (kind === 'network') {
			return localize('claudeCustomizeNoNetwork', "No domains allowed or denied in your Claude Code settings. Claude Code asks before it fetches from a new domain.");
		}
		if (kind === 'permissions') {
			return localize('claudeCustomizeNoPermissions', "No allow or deny rules in your Claude Code settings. Claude Code asks before it does anything a rule does not cover.");
		}
		if (kind === 'rules') {
			return localize('claudeCustomizeNoRules', "No rules in .claude/rules here or in {0}. A rule is a Markdown file of instructions Claude Code loads in every session, or only for the files its paths match.", claudeUserLayerLabel(this._product.dataFolderName, 'rules'));
		}
		if (kind === 'memory') {
			return localize('claudeCustomizeNoMemory', "No CLAUDE.md here or in {0}. Claude Code reads them at the start of every session.", claudeUserLayerLabel(this._product.dataFolderName));
		}
		if (!reported) {
			return localize('claudeCustomizeNotYet', "Claude Code lists these once an agent has started in this window. Start one, then refresh.");
		}
		switch (kind) {
			case 'mcp': return localize('claudeCustomizeNoMcp', "Claude Code loaded no MCP servers.");
			case 'skills': return localize('claudeCustomizeNoSkills', "Claude Code loaded no skills.");
			case 'subagents': return localize('claudeCustomizeNoSubagents', "Claude Code offers no subagents.");
			default: return localize('claudeCustomizeNoCommands', "Claude Code listed no commands.");
		}
	}

	private renderCustomizeItem(card: HTMLElement, item: ClaudeCustomizeItem): void {
		const file = item.kind === 'memory' ? this._memoryFiles.get(item.id) : this._createFiles.resource(item.file);
		const row = append(card, file ? $<HTMLButtonElement>('button.claude-customize-item.is-link') : $('.claude-customize-item'));
		row.dataset.item = `${item.kind}:${item.id}`;
		const icon = append(row, $('.claude-customize-icon'));
		append(icon, $(ThemeIcon.asCSSSelector(CUSTOMIZE_ICONS[item.kind])));
		const text = append(row, $('.claude-customize-text'));
		append(text, $('.name')).textContent = item.name;
		append(text, $('.detail')).textContent = item.detail;
		if (item.managed) {
			// DL-26: the same faint briefcase line a policy-set Settings row carries.
			const badge = append(text, $('.claude-settings-row-managed'));
			append(badge, $(ThemeIcon.asCSSSelector(Codicon.briefcase)));
			append(badge, $('span')).textContent = localize('claudeSettingsManaged', "Managed by your organization");
		}
		if (item.state) {
			const badge = append(row, $(`span.claude-badge.${mcpStateClass(item.state)}`));
			badge.textContent = mcpStateLabel(item.state);
		}
		if (item.pending) {
			const badge = append(row, $('span.claude-badge.is-idle'));
			badge.textContent = localize('claudeMcpNextSession', "Next Session");
			this._customizeStore.add(this._hover.setupDelayedHover(badge, { content: localize('claudeMcpNextSessionHover', "Saved. Sessions started from now on load it."), additionalClasses: ['claude-root'] }));
		}
		const hook = item.hook;
		const hookFile = hook && this._hookFiles.get(hook.scope);
		if (hook && hookFile) {
			this.itemAction(row, `customize.open:${item.id}`, Codicon.goToFile, localize('claudeCustomizeOpenFile', "Open {0}", this.hookFileLabel(hook.scope)), () => void this._editors.openEditor({ resource: hookFile }));
			this.itemAction(row, `customize.remove:hooks:${item.id}`, Codicon.trash, localize('claudeHookRemove', "Remove Hook"), () => void this.removeHook(hook));
		}
		const rule = item.networkRule;
		const ruleFile = rule && this._hookFiles.get(rule.scope);
		if (rule && ruleFile) {
			this.itemAction(row, `customize.open:${item.id}`, Codicon.goToFile, localize('claudeCustomizeOpenFile', "Open {0}", this.hookFileLabel(rule.scope)), () => void this._editors.openEditor({ resource: ruleFile }));
			this.itemAction(row, `customize.remove:network:${item.id}`, Codicon.trash, localize('claudeNetworkRemove', "Remove Domain"), () => void this.removeNetworkRule(rule));
		}
		const permission = item.permissionRule;
		const permissionFile = permission && this._hookFiles.get(permission.scope);
		if (permission && permissionFile) {
			this.itemAction(row, `customize.open:${item.id}`, Codicon.goToFile, localize('claudeCustomizeOpenFile', "Open {0}", this.hookFileLabel(permission.scope)), () => void this._editors.openEditor({ resource: permissionFile }));
			this.itemAction(row, `customize.remove:permissions:${item.id}`, Codicon.trash, localize('claudePermissionRemove', "Remove Rule"), () => void this.removePermissionRule(permission));
		}
		// Issue 512: a server the session loaded can reconnect and turn off or on while it runs, and shows its log.
		if (item.kind === 'mcp' && item.state && !item.pending) {
			if (this._overview?.live && this._runtime.controlMcpServer) {
				if (item.state !== 'disabled') {
					this.itemAction(row, `customize.reconnect:mcp:${item.id}`, Codicon.refresh, localize('claudeMcpReconnect', "Reconnect"), () => void this.controlMcpServer(item, 'reconnect'));
					this.itemAction(row, `customize.disable:mcp:${item.id}`, Codicon.circleSlash, localize('claudeMcpDisable', "Turn Off for This Session"), () => void this.controlMcpServer(item, 'disable'));
				} else {
					this.itemAction(row, `customize.enable:mcp:${item.id}`, Codicon.play, localize('claudeMcpEnable', "Turn On"), () => void this.controlMcpServer(item, 'enable'));
				}
			}
			if (this._runtime.readMcpServerLog) {
				this.itemAction(row, `customize.logs:mcp:${item.id}`, Codicon.output, localize('claudeMcpShowLogs', "Show Logs"), () => void this.showMcpLog(item));
			}
		}
		// A project server lives in the workspace `.mcp.json`, Claude Code's own shape, so editing it is editing that file (issue 1005).
		const projectFolder = item.kind === 'mcp' && item.mcpScope === 'project' && !item.pending ? this.projectCwd() : undefined;
		if (projectFolder) {
			const mcpFile = joinPath(this._workspace.getWorkspace().folders[0].uri, CLAUDE_USER_LAYER_FILES.mcp);
			this.itemAction(row, `customize.edit:mcp:${item.id}`, Codicon.goToFile, localize('claudeMcpEditFile', "Edit in .mcp.json"), () => void this._editors.openEditor({ resource: mcpFile }));
		}
		if (item.kind === 'mcp' && item.mcpScope && this._runtime.removeMcpServer) {
			this.itemAction(row, `customize.remove:mcp:${item.id}`, Codicon.trash, localize('claudeMcpRemove', "Remove Server"), () => void this.removeMcpServer(item));
		}
		if (file) {
			(row as HTMLButtonElement).type = 'button';
			append(row, $(`span.claude-customize-open${ThemeIcon.asCSSSelector(Codicon.goToFile)}`));
			this._customizeStore.add(this._hover.setupDelayedHover(row, { content: localize('claudeCustomizeOpenFile', "Open {0}", item.kind === 'memory' ? item.detail : item.name), additionalClasses: ['claude-root'] }));
			const missing = item.kind === 'memory' && this._memory.some(memory => memory.id === item.id && memory.missing);
			this._customizeStore.add(addDisposableListener(row, EventType.CLICK, () => void (missing ? this.createMemory(file) : this.openCustomizeFile(file, !!item.copyFrom))));
		}
		const copyFrom = item.copyFrom;
		if (copyFrom) {
			this.itemAction(row, `customize.copy:${item.kind}:${item.id}`, Codicon.copy, localize('claudeCustomizeCopyToKlawly', "Copy to Klawly"), () => void this.copyToKlawly(copyFrom, item));
		}
	}

	/** Opens a file. Claude Code's own files open read only, so editing one here never changes what Claude Code reads (issue 807). */
	private async openCustomizeFile(resource: URI, readOnly: boolean): Promise<void> {
		if (readOnly) {
			this._filesConfiguration.updateReadonly(resource, true);
		}
		await this._editors.openEditor({ resource });
	}

	/**
	 * Copies a from-Claude-Code row into Klawly's user layer. The source in `~/.claude` is only read, and a target that
	 * exists is never overwritten (issue 807).
	 */
	private async copyToKlawly(copyFrom: ClaudeCopySource, item: ClaudeCustomizeItem): Promise<void> {
		const folderLabel = claudeUserLayerLabel(this._product.dataFolderName);
		try {
			if (copyFrom.type === 'file') {
				const entry: ClaudeImportEntry = { kind: item.kind === 'memory' ? 'memory' : 'rules', path: copyFrom.path, name: item.name, exists: false };
				const result = await this._instantiation.createInstance(ClaudeCodeImporter).copy([entry]);
				this._notifications.info(ClaudeCodeImporter.summary(result, folderLabel));
				await Promise.all([this.findMemory(), this._createFiles.refresh(this.useClaudeCodeSetup())]);
				this.renderCustomizeList();
				return;
			}
			const resource = this._hookFiles.get('user');
			if (!resource) {
				return;
			}
			const { text, write } = await this.readSettingsFile(resource);
			let next: string | undefined;
			switch (copyFrom.type) {
				case 'hook': next = addClaudeHook(text, copyFrom.hook.event, copyFrom.hook.matcher || undefined, copyFrom.hook.command); break;
				case 'network': next = addClaudeNetworkRule(text, copyFrom.rule.domain, copyFrom.rule.effect); break;
				case 'permission': {
					const added = addClaudePermissionRule(text, copyFrom.rule.rule, copyFrom.rule.effect, new Set());
					next = hasKey(added, { failure: true }) ? undefined : added.text;
					break;
				}
			}
			if (next === undefined) {
				this._notifications.warn(localize('claudeCopyBadFile', "{0} is not valid JSON, or its settings are not shaped the way Claude Code reads them, so nothing was written. Fix the file first.", this.hookFileLabel('user')));
				return;
			}
			if (next === text) {
				this._notifications.info(localize('claudeCopyAlreadyThere', "{0} already has it.", this.hookFileLabel('user')));
				return;
			}
			await this._files.writeFile(resource, VSBuffer.fromString(next), write);
			this._notifications.info(localize('claudeCopyDone', "Copied to {0}. Claude Code's files were not changed.", this.hookFileLabel('user')));
			await this.findHooks();
			this.renderCustomizeList();
		} catch (error) {
			this._notifications.error(errorMessage(error));
		}
	}

	private async createProjectMemory(): Promise<void> {
		const folder = this._workspace.getWorkspace().folders[0];
		if (folder) {
			await this.createMemory(joinPath(folder.uri, 'CLAUDE.md'));
		}
	}

	/** Creates an empty memory file, unless it is there already, and opens it. */
	private async createMemory(resource: URI): Promise<void> {
		try {
			if (!await this._files.exists(resource)) {
				await this._files.createFile(resource, VSBuffer.fromString(''));
			}
			await this._editors.openEditor({ resource });
		} catch (error) {
			this._notifications.error(redactSecrets(error instanceof Error ? error.message : String(error)));
		}
		await this.refreshOverview();
	}

	//#endregion

	//#region Automations

	/**
	 * The Automations section of the Agents page: its switch, the editor form
	 * and the list. The form and the list redraw on their own, so typing in the
	 * form survives a run changing state.
	 */
	private renderAutomations(element: HTMLElement, label: string, rows: readonly ClaudeSettingsRow[]): void {
		element.classList.add('claude-automations');
		const head = append(element, $('.claude-settings-section-head'));
		const title = append(head, $('h3.claude-settings-section-label'));
		title.textContent = label;
		// The count follows the list, which redraws without the section.
		this._automationCount = append(title, $('span.count'));
		this._automationAdd = this.headButton(head, 'automations.new', Codicon.add, localize('claudeAutomationNew', "New Automation"), () => this.toggleAutomationForm(NEW_AUTOMATION), this._renderStore);
		this._automationAdd.classList.replace('is-ghost', 'is-secondary');
		const card = append(element, $('.claude-settings-card'));
		for (const row of rows) {
			if (row.control.kind !== 'automations') {
				this.renderRow(card, row, row.control);
			}
		}
		this._automationFormSlot = append(element, $('.claude-automation-slot'));
		this._automationItemsSlot = append(element, $('.claude-automation-slot'));
		this.renderAutomationForm();
		this.renderAutomationItems();
	}

	private automationScopes(): ClaudeAutomationScope[] {
		return this._workspace.getWorkspace().folders.length > 0 ? ['workspace', 'user'] : ['user'];
	}

	private automationView(key: string): ClaudeAutomationView | undefined {
		return this._automations.getAutomations().find(view => view.automation.key === key);
	}

	/** Opens the form on a new automation or on the one with `key`, or closes it when it already shows that one. */
	private toggleAutomationForm(key: string): void {
		if (this._automationForm === key) {
			this.closeAutomationForm();
			return;
		}
		const view = key === NEW_AUTOMATION ? undefined : this.automationView(key);
		if (key !== NEW_AUTOMATION && !view) {
			return;
		}
		this._automationForm = key;
		this._automationTemplate = 'blank';
		this._automationDraft = view ? claudeAutomationDraft(view.automation) : emptyClaudeAutomationDraft(this.automationScopes()[0]);
		this._automationMemory = view ? undefined : '';
		this._automationDraft.memoryText = this._automationMemory;
		this._automationError = '';
		this.renderAutomationForm();
		this._focusables.get('automation.name')?.focus();
		if (view) {
			void this.loadAutomationMemory(key, this._automationDraft);
		}
	}

	/** Shows the automation's memory in its form once read (issue 518), unless the form has moved on. */
	private async loadAutomationMemory(key: string, draft: ClaudeAutomationDraft): Promise<void> {
		const text = await this._automations.readMemory(key);
		if (this._automationForm === key && this._automationDraft === draft && draft.memoryText === undefined) {
			this._automationMemory = text;
			draft.memoryText = text;
			if (draft.memory) {
				this.renderAutomationForm();
			}
		}
	}

	private closeAutomationForm(): void {
		const key = this._automationForm;
		this._automationForm = undefined;
		this._automationError = '';
		this.renderAutomationForm();
		this._focusables.get(key === NEW_AUTOMATION || !key ? 'automations.new' : `automation.edit:${key}`)?.focus();
	}

	private renderAutomationForm(): void {
		const slot = this._automationFormSlot;
		if (!slot) {
			return;
		}
		const active = getActiveElement();
		const focusKey = isHTMLElement(active) && slot.contains(active) ? active.dataset.focusKey : undefined;
		this._automationFormStore.clear();
		clearNode(slot);
		this._automationAdd?.setAttribute('aria-expanded', String(this._automationForm === NEW_AUTOMATION));
		const editing = this._automationForm;
		if (editing) {
			this.renderAutomationFields(slot, editing === NEW_AUTOMATION);
		}
		if (focusKey) {
			this._focusables.get(focusKey)?.focus();
		}
		this._scrollable.scanDomNode();
	}

	/** The editor's rows. Only the fields the trigger uses show, and Saved In only when there is a choice (DL-12). */
	private renderAutomationFields(slot: HTMLElement, isNew: boolean): void {
		const draft = this._automationDraft;
		const card = append(slot, $('.claude-settings-card.claude-customize-form'));
		card.dataset.form = 'automation';
		const store = this._automationFormStore;
		const submit = () => void this.saveAutomation();
		const field = (id: 'name' | 'prompt' | 'cron' | 'glob' | 'task' | 'budget' | 'maxTurns' | 'allowedTools' | 'repo' | 'branch' | 'label' | 'comment' | 'authors' | 'excludeAuthors' | 'headBranches' | 'keywords' | 'skipKeywords' | 'ignorePaths' | 'memoryText', title: string, description: string, placeholder: string, style?: 'multiline' | 'short' | 'number', unit?: string) => {
			const control = this.formRow(card, `automation-${id}`, title, description);
			const multiline = style === 'multiline';
			let input: HTMLInputElement | HTMLTextAreaElement;
			if (multiline) {
				input = append(control, $<HTMLTextAreaElement>('textarea.claude-field.is-multiline.claude-settings-input'));
				input.rows = 3;
			} else {
				input = append(control, $<HTMLInputElement>('input.claude-field.claude-settings-input'));
				input.type = 'text';
				input.classList.toggle('is-short', style === 'short');
				input.classList.toggle('is-number', style === 'number');
			}
			input.spellcheck = false;
			input.placeholder = placeholder;
			input.value = draft[id] ?? '';
			input.setAttribute('aria-label', title);
			const focusKey = `automation.${id}`;
			input.dataset.focusKey = focusKey;
			this._focusables.set(focusKey, input);
			if (unit) {
				append(control, $('span.claude-settings-unit')).textContent = unit;
			}
			store.add(addDisposableListener(input, EventType.INPUT, () => draft[id] = input.value));
			store.add(addDisposableListener(input, EventType.KEY_DOWN, event => {
				// In a multi-line field Enter is a new line and Ctrl/Cmd+Enter saves.
				if (event.key === 'Enter' && (!multiline || event.ctrlKey || event.metaKey)) {
					event.preventDefault();
					submit();
				} else if (event.key === 'Escape') {
					event.preventDefault();
					event.stopPropagation();
					this.closeAutomationForm();
				}
			}));
		};
		const select = (id: string, title: string, description: string, options: readonly ClaudeSettingsOption[], current: string, pick: (value: string) => void) => {
			const focusKey = `automation.${id}`;
			this.renderSelect(this.formRow(card, `automation-${id}`, title, description), focusKey, title, options, current, value => {
				pick(value);
				this.renderAutomationForm();
				this._focusables.get(focusKey)?.focus();
			});
		};

		if (isNew) {
			// A template refills the whole form, so it comes first (issue 506).
			select('template', localize('claudeAutomationTemplate', "Start From"), localize('claudeAutomationTemplateDesc', "A ready-made automation to adjust before you add it"),
				claudeAutomationTemplates().map(template => ({ value: template.id, label: template.label, description: template.description })), this._automationTemplate, value => {
					this._automationTemplate = value as ClaudeAutomationTemplateId;
					this._automationDraft = claudeAutomationTemplateDraft(this._automationTemplate, draft.scope, false, readClaudeReviewSummaryMode(this._configuration.getValue(CLAUDE_REVIEW_SUMMARY_SETTING)) !== 'off', readClaudeReviewDepthSetting(this._configuration.getValue(CLAUDE_REVIEW_DEPTH_SETTING)));
					this._automationDraft.memoryText = this._automationMemory;
				});
		}
		field('name', localize('claudeAutomationName', "Name"), localize('claudeAutomationNameDesc', "What the list and its notifications call it"), localize('claudeAutomationNamePlaceholder', "Fix failing tests"));
		field('prompt', localize('claudeAutomationPrompt', "Prompt"), localize('claudeAutomationPromptDesc', "What Claude is asked to do on each run"), localize('claudeAutomationPromptPlaceholder', "Run the tests and fix what fails"), 'multiline');
		const scopes = this.automationScopes();
		if (isNew && scopes.length > 1) {
			select('scope', localize('claudeAutomationScope', "Saved In"), localize('claudeAutomationScopeDesc', "Which automations file holds it"), [
				{ value: 'workspace', label: localize('claudeAutomationScopeWorkspace', "Workspace"), description: localize('claudeAutomationScopeWorkspaceDesc', ".klawly/automations.json, shared with the repository") },
				{ value: 'user', label: localize('claudeAutomationScopeUser', "User"), description: localize('claudeAutomationScopeUserDesc', "~/.klawly/automations.json, only you, in every project") },
			], draft.scope, value => draft.scope = value as ClaudeAutomationScope);
		}
		select('trigger', localize('claudeAutomationTrigger', "Trigger"), localize('claudeAutomationTriggerDesc', "What starts a run"),
			CLAUDE_AUTOMATION_TRIGGER_TYPES.map(type => ({ value: type, label: claudeAutomationTriggerLabel(type), description: claudeAutomationTriggerDescription(type) })), draft.trigger, value => draft.trigger = value as ClaudeAutomationTriggerType);
		switch (draft.trigger) {
			case 'schedule':
				field('cron', localize('claudeAutomationCron', "Schedule"), localize('claudeAutomationCronDesc', "Minute, hour, day, month and weekday, in local time"), '0 9 * * 1-5', 'short');
				break;
			case 'onSave':
				field('glob', localize('claudeAutomationGlob', "Files"), localize('claudeAutomationGlobDesc', "A save of a workspace file that matches starts a run"), 'src/**/*.ts');
				break;
			case 'onTaskFailed':
				field('task', localize('claudeAutomationTask', "Task"), localize('claudeAutomationTaskDesc', "The task's label. Empty: any task"), 'npm: build');
				break;
			case 'githubPullRequest':
				field('repo', localize('claudeAutomationRepo', "Repository"), localize('claudeAutomationRepoDesc', "Read with your GitHub CLI sign-in, every few minutes"), 'octo-org/app');
				select('pullRequest', localize('claudeAutomationPullRequest', "Starts When"), localize('claudeAutomationPullRequestDesc', "Which pull request change starts a run"),
					CLAUDE_AUTOMATION_PULL_REQUEST_CHOICES.map(choice => ({ value: choice, label: claudeAutomationPullRequestChoiceLabel(choice) })), draft.pullRequest, value => draft.pullRequest = value as ClaudeAutomationPullRequestChoice);
				if (draft.pullRequest === 'labeled') {
					field('label', localize('claudeAutomationLabel', "Label"), localize('claudeAutomationLabelDesc', "Adding this label starts a run"), 'needs-review', 'short');
				} else if (draft.pullRequest === 'commented' || draft.pullRequest === 'openedUpdatedOrCommented') {
					field('comment', localize('claudeAutomationComment', "Comment"), localize('claudeAutomationCommentDesc', "A pull request comment that contains this starts a run"), '@claude review', 'short');
				}
				field('branch', localize('claudeAutomationBase', "Base Branch"), localize('claudeAutomationBaseDesc', "Only pull requests into this branch. Empty: any"), 'main', 'short');
				// DL-06, DL-11: the same rows as the rest of the form, title case, a one-line hint each. Optional filters that narrow which pull requests start a run (issue 924).
				field('authors', localize('claudeAutomationAuthors', "Only Authors"), localize('claudeAutomationAuthorsDesc', "GitHub logins, separated by commas. Empty: anyone"), 'octocat, hubot', 'short');
				field('excludeAuthors', localize('claudeAutomationExcludeAuthors', "Skip Authors"), localize('claudeAutomationExcludeAuthorsDesc', "Never these logins, such as dependency bots"), 'dependabot[bot]', 'short');
				field('headBranches', localize('claudeAutomationHeadBranches', "Only Branches"), localize('claudeAutomationHeadBranchesDesc', "Head branch patterns, such as feature/**. Empty: any"), 'feature/**', 'short');
				field('keywords', localize('claudeAutomationKeywords', "Only Keywords"), localize('claudeAutomationKeywordsDesc', "The title or description has one of these. Empty: any"), 'review', 'short');
				field('skipKeywords', localize('claudeAutomationSkipKeywords', "Skip Keywords"), localize('claudeAutomationSkipKeywordsDesc', "Not when the title or description has one of these"), 'wip', 'short');
				select('skipDrafts', localize('claudeAutomationSkipDrafts', "Draft Pull Requests"), localize('claudeAutomationSkipDraftsDesc', "A comment that asks for a review still starts a run"), [
					{ value: 'on', label: localize('claudeAutomationSkipDraftsOn', "Skip") },
					{ value: 'off', label: localize('claudeAutomationSkipDraftsOff', "Include") },
				], draft.skipDrafts ? 'on' : 'off', value => draft.skipDrafts = value === 'on');
				field('ignorePaths', localize('claudeAutomationIgnorePaths', "Ignore Paths"), localize('claudeAutomationIgnorePathsDesc', "Skip a pull request that only changes files matching these patterns"), 'docs/**, **/*.md', 'short');
				break;
			case 'githubPush':
				field('repo', localize('claudeAutomationRepo', "Repository"), localize('claudeAutomationRepoDesc', "Read with your GitHub CLI sign-in, every few minutes"), 'octo-org/app');
				field('branch', localize('claudeAutomationPushBranch', "Branch"), localize('claudeAutomationPushBranchDesc', "New commits on this branch start a run"), 'main', 'short');
				break;
			case 'githubCheckFailed':
				field('repo', localize('claudeAutomationRepo', "Repository"), localize('claudeAutomationRepoDesc', "Read with your GitHub CLI sign-in, every few minutes"), 'octo-org/app');
				field('branch', localize('claudeAutomationRunBranch', "Branch"), localize('claudeAutomationRunBranchDesc', "Only runs on this branch. Empty: any"), 'main', 'short');
				break;
		}
		select('mode', localize('claudeAutomationMode', "Mode"), localize('claudeAutomationModeDesc', "The most a run may do"), [
			{ value: 'agent', label: localize('claudeSettingsModeAgent', "Agent"), description: localize('claudeAutomationModeAgentDesc', "Edits in its own worktree") },
			{ value: 'plan', label: localize('claudeSettingsModePlan', "Plan"), description: localize('claudeAutomationModePlanDesc', "Researches and writes a plan") },
			{ value: 'ask', label: localize('claudeSettingsModeAsk', "Ask"), description: localize('claudeAutomationModeAskDesc', "Reads and answers, changes nothing") },
		], draft.permissionMode, value => draft.permissionMode = value as AgentMode);
		select('model', localize('claudeAutomationModel', "Model"), localize('claudeAutomationModelDesc', "The model each run uses"),
			this.modelOptions(localize('claudeAutomationSameModel', "Same as New Agents"), draft.model), draft.model, value => draft.model = value);
		select('effort', localize('claudeAutomationEffort', "Effort"), localize('claudeAutomationEffortDesc', "How hard the model thinks"), [
			{ value: '', label: localize('claudeAutomationDefaultEffort', "Default") },
			...CLAUDE_CONFIGURABLE_EFFORT_LEVELS.map(level => ({ value: level, label: claudeEffortLabel(level) })),
		], draft.effort, value => draft.effort = value);
		field('budget', localize('claudeAutomationBudget', "Spend Cap"), localize('claudeAutomationBudgetDesc', "A run stops when it has spent this much"), '1', 'number', localize('claudeAutomationUsd', "USD"));
		field('maxTurns', localize('claudeAutomationTurns', "Turn Cap"), localize('claudeAutomationTurnsDesc', "Turns before a run stops. Empty: {0}", CLAUDE_AUTOMATION_DEFAULT_MAX_TURNS), String(CLAUDE_AUTOMATION_DEFAULT_MAX_TURNS), 'number');
		field('allowedTools', localize('claudeAutomationAllowed', "Allowed Tools"), localize('claudeAutomationAllowedDesc', "Requests a run may approve, one rule per line. Anything else is denied and the run needs you"), 'Bash(npm test:*)', 'multiline');
		select('memory', localize('claudeAutomationMemory', "Memory"), localize('claudeAutomationMemoryDesc', "A notes file each run reads and may rewrite for the next one"), [
			{ value: 'off', label: localize('claudeAutomationMemoryOff', "Off"), description: localize('claudeAutomationMemoryOffDesc', "Every run starts fresh") },
			{ value: 'on', label: localize('claudeAutomationMemoryOn', "On"), description: localize('claudeAutomationMemoryOnDesc', "Kept in ~/.klawly/automations") },
		], draft.memory ? 'on' : 'off', value => draft.memory = value === 'on');
		// DL-12: the opt-in shows only where it can apply: a schedule that is not in Agent mode, since a closed-time run only reads (issue 463).
		if (draft.trigger === 'schedule' && draft.permissionMode !== 'agent') {
			select('runWhenClosed', localize('claudeAutomationRunWhenClosed', "Run When Klawly Is Closed"), localize('claudeAutomationRunWhenClosedDesc', "The system scheduler starts it on time. It can only read files"), [
				{ value: 'off', label: localize('claudeAutomationRunWhenClosedOff', "Off"), description: localize('claudeAutomationRunWhenClosedOffDesc', "Runs only while Klawly is open") },
				{ value: 'on', label: localize('claudeAutomationRunWhenClosedOn', "On"), description: localize('claudeAutomationRunWhenClosedOnDesc', "Also runs when Klawly is closed") },
			], draft.runWhenClosed ? 'on' : 'off', value => draft.runWhenClosed = value === 'on');
		}
		// The notes show only while memory is on and read, like the trigger's fields (DL-12).
		if (draft.memory && draft.memoryText !== undefined) {
			field('memoryText', localize('claudeAutomationNotes', "Notes"), localize('claudeAutomationNotesDesc', "What runs have kept. Runs treat it as data, not instructions"), localize('claudeAutomationNotesPlaceholder', "Nothing kept yet"), 'multiline');
		}

		const foot = append(card, $('.claude-customize-form-foot'));
		const note = append(foot, $('.claude-customize-form-note'));
		note.classList.toggle('is-error', !!this._automationError);
		note.setAttribute('aria-live', 'polite');
		// The target has one choice, so the form says where a run works instead of asking (DL-12).
		note.textContent = this._automationError || localize('claudeAutomationWorktreeNote', "Each run works in a new worktree on its own branch.");
		const cancel = append(foot, $<HTMLButtonElement>('button.claude-btn.is-ghost'));
		cancel.type = 'button';
		cancel.textContent = localize('claudeCustomizeCancel', "Cancel");
		cancel.dataset.focusKey = 'automation.cancel';
		this._focusables.set('automation.cancel', cancel);
		store.add(addDisposableListener(cancel, EventType.CLICK, () => this.closeAutomationForm()));
		const save = append(foot, $<HTMLButtonElement>('button.claude-btn.is-primary'));
		save.type = 'button';
		save.textContent = isNew ? localize('claudeAutomationAdd', "Add Automation") : localize('claudeAutomationSave', "Save");
		save.disabled = this._automationBusy;
		save.dataset.focusKey = 'automation.submit';
		this._focusables.set('automation.submit', save);
		store.add(addDisposableListener(save, EventType.CLICK, submit));
	}

	private async saveAutomation(): Promise<void> {
		const editing = this._automationForm;
		if (!editing || this._automationBusy) {
			return;
		}
		const draft: ClaudeAutomationDraft = this._automationDraft;
		const existing = editing === NEW_AUTOMATION ? undefined : this.automationView(editing)?.automation;
		const scope = existing?.scope ?? (this.automationScopes().includes(draft.scope) ? draft.scope : 'user');
		const taken = new Set(this._automations.getAutomations().filter(view => view.automation.scope === scope).map(view => view.automation.id));
		const automation = claudeAutomationOfDraft(draft, existing?.id ?? claudeAutomationIdFor(draft.name, taken));
		if (isClaudeAutomationDraftError(automation)) {
			this._automationError = automation.message;
			this.renderAutomationForm();
			this._focusables.get(`automation.${automation.field}`)?.focus();
			return;
		}
		this._automationBusy = true;
		this._automationError = '';
		this.renderAutomationForm();
		try {
			await this._automations.save(scope, automation, existing?.id);
			if (automation.memory && draft.memoryText !== undefined && draft.memoryText !== this._automationMemory) {
				await this._automations.writeMemory(claudeAutomationKey(scope, automation.id), draft.memoryText);
			}
			this._automationBusy = false;
			this._automationForm = undefined;
			this.renderAutomationForm();
			this._focusables.get(existing ? `automation.edit:${existing.key}` : 'automations.new')?.focus();
		} catch (error) {
			this._automationBusy = false;
			this._automationError = errorMessage(error);
			this.renderAutomationForm();
			this._focusables.get('automation.submit')?.focus();
		}
	}

	private renderAutomationItems(): void {
		const slot = this._automationItemsSlot;
		if (!slot) {
			return;
		}
		const active = getActiveElement();
		const focusKey = isHTMLElement(active) && slot.contains(active) ? active.dataset.focusKey : undefined;
		this._automationItemsStore.clear();
		clearNode(slot);
		const views = this._automations.getAutomations();
		if (this._automationCount) {
			this._automationCount.textContent = String(views.length);
		}
		if (views.length === 0) {
			const empty = append(slot, $('.claude-settings-card'));
			const note = append(empty, $('.claude-settings-row.is-note'));
			append(note, $('.claude-settings-row-description')).textContent = localize('claudeAutomationsEmpty', "No automations yet. New Automation adds one to .klawly/automations.json in the workspace or ~/.klawly/automations.json.");
		} else {
			const card = append(slot, $('.claude-settings-card.claude-customize-card'));
			for (const view of views) {
				this.renderAutomationItem(card, view);
			}
		}
		if (focusKey) {
			this._focusables.get(focusKey)?.focus();
		}
		this._scrollable.scanDomNode();
	}

	private renderAutomationItem(card: HTMLElement, view: ClaudeAutomationView): void {
		const { automation, lastRun, nextRunAt } = view;
		const store = this._automationItemsStore;
		const row = append(card, $('.claude-customize-item'));
		row.dataset.item = `automation:${automation.key}`;
		const icon = append(row, $('.claude-customize-icon'));
		append(icon, $(ThemeIcon.asCSSSelector(claudeAutomationTriggerIcon(automation.trigger.type))));
		const text = append(row, $('.claude-customize-text'));
		append(text, $('.name')).textContent = automation.name;
		const detail = [claudeAutomationTriggerSummary(automation.trigger)];
		if (nextRunAt !== undefined) {
			detail.push(localize('claudeAutomationNextRun', "Next run {0}", fromNow(nextRunAt)));
		}
		detail.push(automation.scope === 'workspace' ? localize('claudeAutomationScopeWorkspace', "Workspace") : localize('claudeAutomationScopeUser', "User"));
		if (lastRun) {
			detail.push(lastRun.missedWhileClosed
				? localize('claudeAutomationLastRunMissed', "Last run {0} (missed while closed)", fromNow(lastRun.startedAt, true))
				: localize('claudeAutomationLastRun', "Last run {0}", fromNow(lastRun.startedAt, true)));
		}
		append(text, $('.detail')).textContent = detail.join(' \u00b7 ');
		if (lastRun) {
			const badge = append(row, $(`span.claude-badge.${AUTOMATION_STATE_CLASSES[lastRun.state]}`));
			badge.textContent = claudeAutomationRunStateLabel(lastRun.state);
			if (lastRun.message) {
				store.add(this._hover.setupDelayedHover(badge, { content: lastRun.message, additionalClasses: ['claude-root'] }));
			}
		}
		const key = automation.key;
		this.itemAction(row, `automation.run:${key}`, Codicon.play, localize('claudeAutomationRunNow', "Run Now"), () => void this.runAutomation(key), store);
		this.itemAction(row, `automation.edit:${key}`, Codicon.edit, localize('claudeAutomationEdit', "Edit Automation"), () => this.toggleAutomationForm(key), store);
		this.itemAction(row, `automation.remove:${key}`, Codicon.trash, localize('claudeAutomationRemove', "Remove Automation"), () => void this.removeAutomation(view), store);
		const toggle = this.renderToggle(row, `automation.enabled:${key}`, automation.enabled, enabled => void this.saveEnabled(view, enabled));
		toggle.setAttribute('aria-label', localize('claudeAutomationEnabled', "Run {0} on Its Trigger", automation.name));
	}

	private async runAutomation(key: string): Promise<void> {
		try {
			await this._automations.run(key);
		} catch (error) {
			this._notifications.error(errorMessage(error));
		}
	}

	private async saveEnabled(view: ClaudeAutomationView, enabled: boolean): Promise<void> {
		try {
			await this._automations.save(view.automation.scope, { ...view.automation, enabled });
		} catch (error) {
			this._notifications.error(errorMessage(error));
		}
	}

	private async removeAutomation(view: ClaudeAutomationView): Promise<void> {
		const { automation } = view;
		const { confirmed } = await this._dialogs.confirm({
			message: localize('claudeAutomationRemoveConfirm', "Remove the {0} automation?", automation.name),
			detail: localize('claudeAutomationRemoveDetail', "Klawly removes it from {0}. Its past runs stay in the Agents list.", automation.scope === 'workspace' ? '.klawly/automations.json' : '~/.klawly/automations.json'),
			primaryButton: localize('claudeCustomizeRemove', "Remove"),
		});
		if (!confirmed) {
			return;
		}
		if (this._automationForm === automation.key) {
			this._automationForm = undefined;
			this.renderAutomationForm();
		}
		try {
			await this._automations.remove(automation.key);
		} catch (error) {
			this._notifications.error(errorMessage(error));
		}
	}

	//#endregion

	//#region Models

	private reportedModels(): readonly ClaudeModelInfo[] {
		return this._models ?? [];
	}

	private customModels(): string[] {
		return readClaudeModelIdList(this._configuration.getValue(CLAUDE_MODELS_CUSTOM_SETTING));
	}

	private modelOptions(emptyLabel: string, current: string): ClaudeSettingsOption[] {
		const enabled = readClaudeModelIdList(this._configuration.getValue(CLAUDE_MODELS_ENABLED_SETTING));
		const models = pickableClaudeModels(this.reportedModels(), enabled, this.customModels());
		const options: ClaudeSettingsOption[] = [{ value: '', label: emptyLabel }];
		for (const model of models) {
			options.push({ value: model.id, label: claudeModelName(model), description: model.id !== claudeModelName(model) ? model.id : undefined });
		}
		if (current && !options.some(option => option.value === current)) {
			options.push({ value: current, label: current });
		}
		return options;
	}

	private renderModelList(card: HTMLElement): void {
		card.classList.add('claude-settings-models');
		const bar = append(card, $('.claude-settings-models-bar'));
		const filter = append(bar, $<HTMLInputElement>('input.claude-field.claude-settings-input.claude-settings-model-filter'));
		filter.type = 'text';
		filter.placeholder = localize('claudeSettingsAddModel', "Add or search model");
		filter.setAttribute('aria-label', localize('claudeSettingsAddModelLabel', "Add or Search Model"));
		filter.value = this._modelFilter;
		filter.dataset.focusKey = 'models.filter';
		this._focusables.set('models.filter', filter);
		this._renderStore.add(addDisposableListener(filter, EventType.INPUT, () => {
			this._modelFilter = filter.value;
			this.renderModelRows();
		}));
		this._renderStore.add(addDisposableListener(filter, EventType.KEY_DOWN, event => {
			if (event.key === 'Enter') {
				event.preventDefault();
				this.addCustomModel(filter.value);
			}
		}));
		const refresh = append(bar, $<HTMLButtonElement>('button.claude-icon-btn'));
		refresh.type = 'button';
		const refreshLabel = localize('claudeSettingsRefreshModels', "Refresh Models from Claude Code");
		refresh.setAttribute('aria-label', refreshLabel);
		refresh.dataset.focusKey = 'models.refresh';
		this._focusables.set('models.refresh', refresh);
		append(refresh, $(ThemeIcon.asCSSSelector(Codicon.refresh)));
		this._renderStore.add(this._hover.setupDelayedHover(refresh, { content: refreshLabel, additionalClasses: ['claude-root'] }));
		this._renderStore.add(addDisposableListener(refresh, EventType.CLICK, () => void this.refreshRuntime()));
		this._modelRows = append(card, $('.claude-settings-model-rows'));
		this.renderModelRows();
	}

	private renderModelRows(): void {
		const container = this._modelRows;
		if (!container) {
			return;
		}
		const active = getActiveElement();
		const focusKey = isHTMLElement(active) && container.contains(active) ? active.dataset.focusKey : undefined;
		this._modelRowStore.clear();
		clearNode(container);
		const reported = this.reportedModels();
		const reportedIds = reported.map(model => model.id);
		const enabled = readClaudeModelIdList(this._configuration.getValue(CLAUDE_MODELS_ENABLED_SETTING));
		const efforts = this.efforts();
		const filter = this._modelFilter.trim().toLowerCase();
		const matches = (name: string, id: string) => !filter || name.toLowerCase().includes(filter) || id.toLowerCase().includes(filter);
		let shown = 0;
		for (const model of reported) {
			const name = claudeModelName(model);
			if (!matches(name, model.id)) {
				continue;
			}
			shown++;
			const row = this.modelRow(container, model.id, name, name !== model.id ? model.id : undefined);
			const slot = append(row, $('.claude-settings-row-control'));
			const levels = model.supportsEffort ? (model.supportedEffortLevels ?? []).filter(level => CLAUDE_CONFIGURABLE_EFFORT_LEVELS.includes(level)) : [];
			if (levels.length > 0) {
				const options: ClaudeSettingsOption[] = [
					{ value: '', label: localize('claudeSettingsEffortLastUsed', "Last Used") },
					...levels.map(level => ({ value: level, label: claudeEffortLabel(level) })),
				];
				const select = this.renderSelect(slot, `model:${model.id}:effort`, localize('claudeSettingsEffortFor', "Effort for {0}", name), options, efforts[model.id] ?? '', value => this.setEffort(model.id, value));
				select.setAttribute('aria-label', localize('claudeSettingsEffortFor', "Effort for {0}", name));
			}
			const on = isClaudeModelEnabled(model.id, enabled, reportedIds);
			const toggle = this.renderToggle(slot, `model:${model.id}:toggle`, on, value => this.setModelEnabled(model.id, value));
			toggle.setAttribute('aria-label', localize('claudeSettingsShowModel', "Show {0} in the Model Picker", name));
		}
		for (const id of this.customModels().filter(custom => !reportedIds.includes(custom))) {
			if (!matches(id, id)) {
				continue;
			}
			shown++;
			const row = this.modelRow(container, id, id, localize('claudeSettingsCustomTag', "Custom model ID"));
			const slot = append(row, $('.claude-settings-row-control'));
			const remove = append(slot, $<HTMLButtonElement>('button.claude-icon-btn'));
			remove.type = 'button';
			const removeLabel = localize('claudeSettingsRemoveModel', "Remove {0}", id);
			remove.setAttribute('aria-label', removeLabel);
			remove.dataset.focusKey = `model:${id}:remove`;
			this._focusables.set(`model:${id}:remove`, remove);
			append(remove, $(ThemeIcon.asCSSSelector(Codicon.close)));
			this._modelRowStore.add(this._hover.setupDelayedHover(remove, { content: removeLabel, additionalClasses: ['claude-root'] }));
			this._modelRowStore.add(addDisposableListener(remove, EventType.CLICK, () => void this.removeCustomModel(id)));
		}
		if (shown === 0) {
			const empty = append(container, $('.claude-settings-row.is-note'));
			const text = append(empty, $('.claude-settings-row-description'));
			if (this._models === undefined) {
				text.textContent = localize('claudeSettingsModelsLoading', "Asking Claude Code for its models...");
			} else if (filter) {
				text.textContent = localize('claudeSettingsAddHint', "No model matches. Press Enter to add \"{0}\" as a custom model ID.", this._modelFilter.trim());
			} else {
				text.textContent = localize('claudeSettingsNoModels', "Claude Code has not reported any models. Check that it is installed and signed in, then refresh.");
			}
		}
		if (focusKey) {
			this._focusables.get(focusKey)?.focus();
		}
		this._scrollable.scanDomNode();
	}

	private modelRow(container: HTMLElement, id: string, name: string, detail: string | undefined): HTMLElement {
		const row = append(container, $('.claude-settings-row.is-model'));
		row.dataset.model = id;
		const text = append(row, $('.claude-settings-row-text'));
		const title = append(text, $('.claude-settings-row-title'));
		append(title, $('span.name')).textContent = name;
		if (detail) {
			append(title, $('span.detail')).textContent = detail;
		}
		return row;
	}

	private efforts(): Record<string, string> {
		const value = this._configuration.getValue(CLAUDE_MODELS_EFFORT_SETTING);
		return typeof value === 'object' && value !== null && !Array.isArray(value) ? { ...value as Record<string, string> } : {};
	}

	private setEffort(modelId: string, level: string): void {
		const efforts = this.efforts();
		if (level) {
			efforts[modelId] = level;
		} else {
			delete efforts[modelId];
		}
		this.write(CLAUDE_MODELS_EFFORT_SETTING, Object.keys(efforts).length > 0 ? efforts : undefined);
	}

	private setModelEnabled(modelId: string, on: boolean): void {
		const reportedIds = this.reportedModels().map(model => model.id);
		const enabled = readClaudeModelIdList(this._configuration.getValue(CLAUDE_MODELS_ENABLED_SETTING));
		const selected = reportedIds.filter(id => id === modelId ? on : isClaudeModelEnabled(id, enabled, reportedIds));
		const value = enabledClaudeModelsSetting(reportedIds, selected);
		if (!value) {
			this._notifications.warn(localize('claudeSettingsKeepOne', "Keep at least one model on."));
			return;
		}
		// Every model on is stored as [], which also means all.
		this.write(CLAUDE_MODELS_ENABLED_SETTING, value.length > 0 ? value : undefined);
	}

	private addCustomModel(value: string): void {
		const id = value.trim();
		if (!id) {
			return;
		}
		if (/\s/.test(id)) {
			this._notifications.warn(localize('claudeSettingsModelSpaces', "A model ID has no spaces."));
			return;
		}
		const custom = this.customModels();
		this._modelFilter = '';
		if (custom.includes(id) || this.reportedModels().some(model => model.id === id)) {
			this.renderModelRows();
			return;
		}
		this.write(CLAUDE_MODELS_CUSTOM_SETTING, [...custom, id]);
	}

	private async removeCustomModel(id: string): Promise<void> {
		await this.writeAsync(CLAUDE_MODELS_CUSTOM_SETTING, this.customModels().filter(custom => custom !== id));
		if (readClaudeModelId(this._configuration.getValue(CLAUDE_MODELS_DEFAULT_SETTING)) === id) {
			await this.writeAsync(CLAUDE_MODELS_DEFAULT_SETTING, undefined);
		}
		this._focusables.get('models.filter')?.focus();
	}

	//#endregion

	private write(key: string, value: unknown): void {
		void this.writeAsync(key, value);
	}

	/** Writes the user setting. A value equal to the default is removed, so settings.json keeps only real choices. */
	private async writeAsync(key: string, value: unknown): Promise<void> {
		const inspected = this._configuration.inspect(key);
		const stored = value === undefined || JSON.stringify(value) === JSON.stringify(inspected.defaultValue) ? undefined : value;
		try {
			await this._configuration.updateValue(key, stored, ConfigurationTarget.USER);
		} catch (error) {
			this._notifications.error(redactSecrets(error instanceof Error ? error.message : String(error)));
		}
	}
}

function mcpStateLabel(state: ClaudeMcpServerState): string {
	switch (state) {
		case 'connected': return localize('claudeMcpConnected', "Connected");
		case 'failed': return localize('claudeMcpFailed', "Failed");
		case 'needs-auth': return localize('claudeMcpNeedsAuth', "Needs Sign-In");
		case 'pending': return localize('claudeMcpPending', "Starting");
		case 'disabled': return localize('claudeMcpDisabled', "Off");
	}
}

function mcpStateClass(state: ClaudeMcpServerState): string {
	switch (state) {
		case 'connected': return 'is-success';
		case 'failed': return 'is-error';
		case 'needs-auth': return 'is-warning';
		case 'pending': return 'is-running';
		case 'disabled': return 'is-idle';
	}
}

function hookEventDescription(event: typeof CLAUDE_HOOK_EVENTS[number]): string {
	switch (event) {
		case 'PreToolUse': return localize('claudeHookPreToolUse', "Before a tool runs; the command can block it");
		case 'PostToolUse': return localize('claudeHookPostToolUse', "After a tool succeeds");
		case 'UserPromptSubmit': return localize('claudeHookUserPromptSubmit', "When you send a prompt");
		case 'Notification': return localize('claudeHookNotification', "When Claude Code notifies you");
		case 'Stop': return localize('claudeHookStop', "When Claude finishes replying");
		case 'SubagentStop': return localize('claudeHookSubagentStop', "When a subagent finishes");
		case 'SessionStart': return localize('claudeHookSessionStart', "When a session starts or resumes");
		case 'SessionEnd': return localize('claudeHookSessionEnd', "When a session ends");
		case 'PreCompact': return localize('claudeHookPreCompact', "Before the conversation is compacted");
		case 'PermissionRequest': return localize('claudeHookPermissionRequest', "When Claude Code asks for permission");
		case 'KlawlyTabRead': return localize('claudeHookKlawlyTabRead', "Klawly: before Tab sends a file; the command can skip it");
		case 'KlawlyInlineEdit': return localize('claudeHookKlawlyInlineEdit', "Klawly: before and after an inline edit; the command can block it");
		case 'KlawlyWorkspaceOpen': return localize('claudeHookKlawlyWorkspaceOpen', "Klawly: when a trusted workspace opens");
	}
}
