/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, append, clearNode } from '../../../../base/browser/dom.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { hash } from '../../../../base/common/hash.js';
import { DisposableStore, IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { joinPath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ContextKeyExpr, IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { defaultButtonStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { CLAUDE_AUTOMATIONS_FOLDER } from '../../../../platform/claude/common/claudeAutomation.js';
import { CLAUDE_FINDINGS_FILE_NAME, ClaudeFindingsFile, ClaudeSecurityFinding, claudeSecurityFixPrompt, dismissClaudeFinding, dismissClaudeFindings, isClaudeSecurityAutomationPrompt, openClaudeSecurityFindings, parseClaudeFindingsFile, parseClaudeSecurityFindings, stringifyClaudeFindingsFile } from '../../../../platform/claude/common/claudeSecurityFindings.js';
import { ViewAction, ViewPane } from '../../../browser/parts/views/viewPane.js';
import { IViewletViewOptions } from '../../../browser/parts/views/viewsViewlet.js';
import { Extensions as ViewExtensions, IViewContainersRegistry, IViewDescriptor, IViewDescriptorService, IViewsRegistry } from '../../../common/views.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IPathService } from '../../../services/path/common/pathService.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { IClaudeAgentService } from '../../../services/claude/common/claudeAgentService.js';
import { IClaudeAutomationService } from '../../../services/claude/common/claudeAutomationService.js';
import { IClaudeBackgroundAgentService } from '../../../services/claude/common/claudeBackgroundAgent.js';
import { replayDurableEvents } from '../../../services/claude/common/claudeTranscript.js';
import { CLAUDE_AGENT_ENABLED } from '../common/claudeContextKeys.js';
import { CLAUDE_OPEN_SETTINGS_COMMAND_ID, CLAUDE_VIEW_CONTAINER_ID, KLAWLY_CATEGORY } from '../common/claudeViews.js';

/** The Security Findings view (issue 871). */
export const CLAUDE_SECURITY_FINDINGS_VIEW_ID = 'workbench.view.claude.securityFindings';
const CLAUDE_SHOW_SECURITY_FINDINGS_COMMAND_ID = 'claude.showSecurityFindings';
const CLAUDE_REFRESH_SECURITY_FINDINGS_COMMAND_ID = 'claude.refreshSecurityFindings';
const CLAUDE_DISMISS_ALL_SECURITY_FINDINGS_COMMAND_ID = 'claude.dismissAllSecurityFindings';

interface RepoFindings {
	readonly repoRoot: string;
	readonly findings: readonly ClaudeSecurityFinding[];
}

/**
 * Security Findings (issue 871, DL-107): the findings the user's security runs
 * reported, per repository, worst first. Each row opens its file at the line,
 * hands the fix to a background agent (Fix with Agent) or is dismissed with a
 * reason that is kept in `~/.klawly/findings/<repo>/.klawly-findings.json`, so a
 * later run does not bring it back. While a security run is under way a
 * Scanning line names it, and an empty list offers to set one up (issue 1076).
 */
class ClaudeSecurityFindingsViewPane extends ViewPane {

	private list: HTMLElement | undefined;
	private readonly buttons = this._register(new DisposableStore());

	constructor(
		options: IViewletViewOptions,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IOpenerService openerService: IOpenerService,
		@IThemeService themeService: IThemeService,
		@IHoverService hoverService: IHoverService,
		@IClaudeBackgroundAgentService private readonly background: IClaudeBackgroundAgentService,
		@IClaudeAutomationService private readonly automations: IClaudeAutomationService,
		@IClaudeAgentService private readonly agents: IClaudeAgentService,
		@IFileService private readonly files: IFileService,
		@IPathService private readonly paths: IPathService,
		@IEditorService private readonly editors: IEditorService,
		@IQuickInputService private readonly quickInput: IQuickInputService,
		@INotificationService private readonly notifications: INotificationService,
		@ICommandService private readonly commands: ICommandService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
		this._register(this.background.onDidChangeTasks(() => this.refresh()));
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		this.list = append(container, $('.claude-security-findings'));
		this.refresh();
	}

	private async dismissalsFile(repoRoot: string): Promise<URI> {
		return joinPath(await this.paths.userHome(), CLAUDE_AUTOMATIONS_FOLDER, 'findings', `repo-${(hash(repoRoot) >>> 0).toString(16).padStart(8, '0')}`, CLAUDE_FINDINGS_FILE_NAME);
	}

	private async readDismissals(repoRoot: string): Promise<ClaudeFindingsFile> {
		try {
			return parseClaudeFindingsFile((await this.files.readFile(await this.dismissalsFile(repoRoot))).value.toString());
		} catch {
			return { dismissed: [] };
		}
	}

	private async collect(): Promise<readonly RepoFindings[]> {
		const byRepo = new Map<string, ClaudeSecurityFinding[]>();
		for (const task of this.background.getTasks()) {
			if (!this.automations.automationOfTask(task.id) || task.status === 'starting' || task.status === 'running') {
				continue;
			}
			const text = replayDurableEvents(this.agents.getSessionEvents(task.sessionId)).state.turns.map(turn => turn.assistantText).join('\n');
			const known = byRepo.get(task.repoRoot) ?? [];
			for (const finding of parseClaudeSecurityFindings(text)) {
				if (!known.some(other => other.key === finding.key)) {
					known.push(finding);
				}
			}
			byRepo.set(task.repoRoot, known);
		}
		const result: RepoFindings[] = [];
		for (const [repoRoot, found] of byRepo) {
			const open = openClaudeSecurityFindings(found, await this.readDismissals(repoRoot));
			if (open.length) {
				result.push({ repoRoot, findings: open });
			}
		}
		return result;
	}

	/** The security runs under way, by automation name and repository. */
	private scanning(): readonly { readonly name: string; readonly repoRoot: string }[] {
		const runs: { name: string; repoRoot: string }[] = [];
		for (const task of this.background.getTasks()) {
			const automation = this.automations.automationOfTask(task.id);
			if (automation && isClaudeSecurityAutomationPrompt(automation.prompt) && (task.status === 'starting' || task.status === 'running')) {
				runs.push({ name: automation.name, repoRoot: task.repoRoot });
			}
		}
		return runs;
	}

	async refresh(): Promise<void> {
		const list = this.list;
		if (!list) {
			return;
		}
		const repos = await this.collect();
		const scanning = this.scanning();
		this.buttons.clear();
		clearNode(list);
		// A run under way says so, since its findings only show once it ends (DL-107).
		for (const run of scanning) {
			const line = append(list, $('p.claude-security-findings-scanning'));
			append(line, $(`span.codicon.codicon-${Codicon.loading.id}.codicon-modifier-spin`));
			append(line, $('span', undefined, localize('claudeFindingsScanning', "Scanning: {0} is running in {1}.", run.name, run.repoRoot)));
		}
		if (!repos.length) {
			if (scanning.length) {
				append(list, $('p', undefined, localize('claudeFindingsNoneYet', "No open security findings yet. They show up here when the scan ends.")));
				return;
			}
			// DL-107: the empty list explains what a scan is and offers the one next step. DL-02: Klawly button styling, theme tokens only.
			const empty = append(list, $('.claude-security-findings-empty'));
			append(empty, $('h3', undefined, localize('claudeFindingsNoneTitle', "No Security Findings Yet")));
			append(empty, $('p', undefined, localize('claudeFindingsNone', "A security scan has Claude review the code in your workspace for vulnerabilities, such as injection flaws, secrets committed to code and unsafe dependencies. What it finds is listed here, worst first, so you can open each one or hand the fix to an agent.")));
			append(empty, $('p', undefined, localize('claudeFindingsNoneHow', "Set up a scan to run it on a schedule or on demand.")));
			append(empty, this.button(localize('claudeFindingsSetUp', "Set Up a Security Scan"), Codicon.shield.id, () => this.setUpScan(), true));
			return;
		}
		for (const { repoRoot, findings } of repos) {
			append(list, $('h4', undefined, repoRoot));
			for (const finding of findings) {
				this.renderFinding(list, repoRoot, finding);
			}
		}
	}

	private renderFinding(parent: HTMLElement, repoRoot: string, finding: ClaudeSecurityFinding): void {
		const row = append(parent, $('.claude-security-finding'));
		const head = append(row, $('div'));
		append(head, $('strong', undefined, `[${finding.severity}] ${finding.category}`));
		const place = append(head, $('a', undefined, ` ${finding.file}:${finding.line}`));
		place.setAttribute('role', 'button');
		place.tabIndex = 0;
		place.onclick = () => this.reveal(repoRoot, finding);
		place.onkeydown = e => {
			if (e.key === 'Enter') {
				this.reveal(repoRoot, finding);
			}
		};
		append(row, $('div', undefined, finding.detail));
		const actions = append(row, $('div'));
		append(actions, this.button(localize('claudeFindingFix', "Fix with Agent"), Codicon.sparkle.id, () => this.fix(finding)));
		append(actions, this.button(localize('claudeFindingDismiss', "Dismiss"), Codicon.close.id, () => this.dismiss(repoRoot, finding)));
	}

	private button(label: string, icon: string, run: () => void, primary = false): HTMLElement {
		const button = this.buttons.add(new Button(this.list!, { ...defaultButtonStyles, secondary: !primary, supportIcons: true, title: label }));
		button.label = `$(${icon}) ${label}`;
		this.buttons.add(button.onDidClick(run));
		button.element.classList.add('claude-security-findings-button');
		return button.element;
	}

	private async reveal(repoRoot: string, finding: ClaudeSecurityFinding): Promise<void> {
		await this.editors.openEditor({ resource: joinPath(URI.file(repoRoot), finding.file), options: { selection: { startLineNumber: finding.line, startColumn: 1 } } });
	}

	private async fix(finding: ClaudeSecurityFinding): Promise<void> {
		try {
			await this.background.start(claudeSecurityFixPrompt(finding), { title: localize('claudeFindingFixTitle', "Fix {0} in {1}", finding.category, finding.file), select: false });
			this.notifications.info(localize('claudeFindingFixStarted', "Claude is fixing {0} in a background agent.", finding.category));
		} catch (error) {
			this.notifications.error(localize('claudeFindingFixFailed', "Could not start the fix: {0}", error instanceof Error ? error.message : String(error)));
		}
	}

	private async setUpScan(): Promise<void> {
		try {
			await this.commands.executeCommand(CLAUDE_OPEN_SETTINGS_COMMAND_ID, { page: 'agents', automationTemplate: 'securityScan' });
		} catch (error) {
			this.notifications.error(error instanceof Error ? error.message : String(error));
		}
	}

	/** Dismisses every open finding with one reason, asked once (issue 1076). */
	async dismissAll(): Promise<void> {
		const repos = await this.collect();
		const count = repos.reduce((sum, repo) => sum + repo.findings.length, 0);
		if (!count) {
			this.notifications.info(localize('claudeFindingsNoneToDismiss', "There are no open security findings to dismiss."));
			return;
		}
		const reason = await this.quickInput.input({ prompt: localize('claudeFindingDismissAllWhy', "Why are these {0} findings not a problem?", count), placeHolder: localize('claudeFindingDismissAllExample', "For example: reviewed, all false positives") });
		if (reason === undefined) {
			return;
		}
		for (const { repoRoot, findings } of repos) {
			const next = dismissClaudeFindings(await this.readDismissals(repoRoot), findings.map(finding => finding.key), reason, Date.now());
			await this.files.writeFile(await this.dismissalsFile(repoRoot), VSBuffer.fromString(stringifyClaudeFindingsFile(next)));
		}
		await this.refresh();
	}

	private async dismiss(repoRoot: string, finding: ClaudeSecurityFinding): Promise<void> {
		const reason = await this.quickInput.input({ prompt: localize('claudeFindingDismissWhy', "Why is this not a problem?"), placeHolder: localize('claudeFindingDismissExample', "For example: test fixture, input is validated upstream") });
		if (reason === undefined) {
			return;
		}
		const resource = await this.dismissalsFile(repoRoot);
		const next = dismissClaudeFinding(await this.readDismissals(repoRoot), finding.key, reason, Date.now());
		await this.files.writeFile(resource, VSBuffer.fromString(stringifyClaudeFindingsFile(next)));
		await this.refresh();
	}
}

class RefreshSecurityFindingsAction extends ViewAction<ClaudeSecurityFindingsViewPane> {
	constructor() {
		super({
			id: CLAUDE_REFRESH_SECURITY_FINDINGS_COMMAND_ID,
			title: localize2('claudeFindingsRefresh', "Refresh"),
			icon: Codicon.refresh,
			viewId: CLAUDE_SECURITY_FINDINGS_VIEW_ID,
			menu: { id: MenuId.ViewTitle, when: ContextKeyExpr.equals('view', CLAUDE_SECURITY_FINDINGS_VIEW_ID), group: 'navigation', order: 1 },
		});
	}

	runInView(_accessor: ServicesAccessor, view: ClaudeSecurityFindingsViewPane): Promise<void> {
		return view.refresh();
	}
}

class DismissAllSecurityFindingsAction extends ViewAction<ClaudeSecurityFindingsViewPane> {
	constructor() {
		super({
			id: CLAUDE_DISMISS_ALL_SECURITY_FINDINGS_COMMAND_ID,
			title: localize2('claudeFindingsDismissAll', "Dismiss All"),
			icon: Codicon.clearAll,
			viewId: CLAUDE_SECURITY_FINDINGS_VIEW_ID,
			menu: { id: MenuId.ViewTitle, when: ContextKeyExpr.equals('view', CLAUDE_SECURITY_FINDINGS_VIEW_ID), group: 'navigation', order: 2 },
		});
	}

	runInView(_accessor: ServicesAccessor, view: ClaudeSecurityFindingsViewPane): Promise<void> {
		return view.dismissAll();
	}
}

class ShowSecurityFindingsAction extends Action2 {
	constructor() {
		super({
			id: CLAUDE_SHOW_SECURITY_FINDINGS_COMMAND_ID,
			title: localize2('claudeFindingsShow', "Show Security Findings"),
			category: KLAWLY_CATEGORY,
			precondition: CLAUDE_AGENT_ENABLED,
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		await accessor.get(IViewsService).openView(CLAUDE_SECURITY_FINDINGS_VIEW_ID, true);
	}
}

/** Registers the view in the Claude container, with its title actions and palette command. The returned disposable removes them again. */
export function registerClaudeSecurityFindingsView(): IDisposable {
	const container = Registry.as<IViewContainersRegistry>(ViewExtensions.ViewContainersRegistry).get(CLAUDE_VIEW_CONTAINER_ID);
	const views = Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry);
	const store = new DisposableStore();
	if (!container || views.getView(CLAUDE_SECURITY_FINDINGS_VIEW_ID)) {
		return store;
	}
	const view: IViewDescriptor = {
		id: CLAUDE_SECURITY_FINDINGS_VIEW_ID,
		name: localize2('claudeSecurityFindings', "Security Findings"),
		ctorDescriptor: new SyncDescriptor(ClaudeSecurityFindingsViewPane),
		canToggleVisibility: true,
		canMoveView: true,
		collapsed: true,
		weight: 20,
		order: 5,
		containerIcon: Codicon.shield,
		when: CLAUDE_AGENT_ENABLED,
	};
	views.registerViews([view], container);
	store.add(toDisposable(() => views.deregisterViews([view], container)));
	store.add(registerAction2(RefreshSecurityFindingsAction));
	store.add(registerAction2(DismissAllSecurityFindingsAction));
	store.add(registerAction2(ShowSecurityFindingsAction));
	return store;
}
