/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { isCodeEditor } from '../../../../editor/browser/editorBrowser.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { AgentActionRequest, IClaudeActionService } from '../../../../platform/claude/common/claudeActions.js';
import { CLAUDE_ACTIONS_PREFER_COMMANDS_SETTING } from '../../../../platform/claude/common/claudeConfiguration.js';
import { ContextAttachment } from '../../../../platform/claude/common/claudeContext.js';
import { gitAttachmentHasChanges } from '../../../../platform/claude/common/claudeGit.js';
import { actionAvailable, actionNeedsEditorSelection, actionRequestText, actionSends, actionTurnLabel, AgentEnvelope, compileSubmission, resolveAgentAction } from '../../../../platform/claude/common/claudePrompt.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { ClaudeAgentSession, IClaudeAgentService } from '../../../services/claude/common/claudeAgentService.js';
import { IClaudeContextService } from '../../../services/claude/common/claudeContextService.js';
import { screenClaudeAttachmentSecrets } from '../common/claudeSecretGuard.js';

export class ClaudeActionService implements IClaudeActionService {
	declare readonly _serviceBrand: undefined;

	constructor(
		@IClaudeAgentService private readonly _agent: IClaudeAgentService,
		@IClaudeContextService private readonly _context: IClaudeContextService,
		@IEditorService private readonly _editors: IEditorService,
		@IWorkspaceContextService private readonly _workspace: IWorkspaceContextService,
		@IConfigurationService private readonly _configuration: IConfigurationService,
		@INotificationService private readonly _notifications: INotificationService,
		@IDialogService private readonly _dialogs: IDialogService,
	) { }

	resolve(req: AgentActionRequest) {
		const session = this._agent.getCurrentSession();
		return resolveAgentAction(req.id, {
			slashCommands: session?.slashCommands ?? [],
			skills: session?.skills ?? [],
			preferClaudeCommands: this._configuration.getValue(CLAUDE_ACTIONS_PREFER_COMMANDS_SETTING) !== false,
		});
	}

	async run(req: AgentActionRequest): Promise<void> {
		if (!actionAvailable(req.id)) {
			throw new Error(localize('claudeActionLater', "That action is not available yet."));
		}
		if (!actionNeedsEditorSelection(req.id)) {
			if (req.id === 'fixPreviewElement' && req.attachments.length === 0) {
				this._notifications.info(localize('claudeActionNeedsPreviewElement', "Pick an element in the preview first."));
				return;
			}
			if (req.id === 'explainDiff' && !req.attachments.some(attachment => attachment.kind === 'git-diff')) {
				this._notifications.info(localize('claudeActionNeedsDiff', "Choose a changed file first."));
				return;
			}
			if (req.id === 'explainCommit' && !req.args?.sha) {
				this._notifications.info(localize('claudeActionNeedsCommit', "Choose a commit first."));
				return;
			}
			const session = this._agent.getCurrentSession() ?? this._agent.createSession();
			await this.submitAction(req, session, [...session.attachments, ...actionAttachments(req)]);
			return;
		}
		const selection = this.selectionAttachment();
		if (!selection) {
			this._notifications.info(localize('claudeNeedsSelection', "Select some code first."));
			return;
		}
		const session = this._agent.getCurrentSession() ?? this._agent.createSession();
		await this.submitAction(req, session, mergeSelection(session.attachments, selection, req.attachments));
	}

	private async submitAction(req: AgentActionRequest, session: ClaudeAgentSession, attachments: ContextAttachment[]): Promise<void> {
		if (!actionSends(req.id)) {
			this._agent.setAttachments(session.id, attachments);
			return;
		}
		const resolution = this.resolve(req);
		const text = actionRequestText(req.id, resolution, req.args);
		const cwd = this._workspace.getWorkspace().folders.find(folder => folder.uri.scheme === 'file')?.uri.fsPath;
		if (!cwd) {
			this._notifications.error(localize('claudeNeedsFolder', "Open a local folder before messaging the agent."));
			return;
		}
		let envelope = await this._context.resolve(text, session.mode, attachments);
		// Nothing staged: write the message for the uncommitted changes instead (issue 748).
		if (req.id === 'generateCommitMessage' && gitDiffIsEmpty(envelope) && attachments.some(attachment => attachment.kind === 'git-diff' && attachment.scope === 'staged')) {
			envelope = await this._context.resolve(text, session.mode, attachments.map(attachment => attachment.kind === 'git-diff' ? { kind: 'git-diff', scope: 'working-tree' } : attachment));
		}
		if ((req.id === 'reviewChanges' || req.id === 'explainDiff' || req.id === 'splitPullRequests') && gitDiffIsEmpty(envelope)) {
			this._notifications.info(req.id === 'reviewChanges'
				? localize('claudeNothingToReview', "There are no changes to review.")
				: req.id === 'splitPullRequests'
					? localize('claudeNothingToSplit', "There are no uncommitted changes to split into pull requests.")
					: localize('claudeNothingToExplain', "There is nothing to explain in that diff."));
			return;
		}
		if (req.id === 'generateCommitMessage' && gitDiffIsEmpty(envelope)) {
			this._notifications.info(localize('claudeNoCommitChanges', "There are no changes to commit."));
			return;
		}
		const screened = await screenClaudeAttachmentSecrets(envelope, this._dialogs, this._configuration);
		if (!screened) {
			return;
		}
		const compiled = compileSubmission(screened, resolution);
		await this._agent.submit(session.id, text, cwd, {
			compiled,
			resolution,
			label: actionTurnLabel(req.id, resolution),
		});
	}

	private selectionAttachment(): ContextAttachment | undefined {
		const control = this._editors.activeTextEditorControl;
		if (!isCodeEditor(control)) {
			return undefined;
		}
		const model = control.getModel();
		const range = control.getSelection();
		if (!model || !range || range.isEmpty()) {
			return undefined;
		}
		return {
			kind: 'selection',
			uri: model.uri.toString(),
			range: {
				startLine: range.startLineNumber,
				startColumn: range.startColumn,
				endLine: range.endLineNumber,
				endColumn: range.endColumn,
			},
			versionId: model.getVersionId(),
		};
	}
}

function gitDiffIsEmpty(envelope: AgentEnvelope): boolean {
	const git = envelope.attachments.find(attachment => attachment.kind === 'git-diff');
	if (!git || git.kind !== 'git-diff') {
		return false;
	}
	return !gitAttachmentHasChanges(git.stat, git.patch);
}

function actionAttachments(req: AgentActionRequest): ContextAttachment[] {
	const attachments = [...req.attachments];
	if ((req.id === 'reviewChanges' || req.id === 'splitPullRequests') && !attachments.some(attachment => attachment.kind === 'git-diff')) {
		attachments.push({ kind: 'git-diff', scope: 'all' });
	}
	// The Source Control command picks staged or working-tree changes (issue 748); other callers start from the staged diff.
	if (req.id === 'generateCommitMessage' && !attachments.some(attachment => attachment.kind === 'git-diff')) {
		attachments.push({ kind: 'git-diff', scope: 'staged' });
	}
	return attachments;
}

function mergeSelection(existing: readonly ContextAttachment[], selection: ContextAttachment, extra: readonly ContextAttachment[]): ContextAttachment[] {
	const merged = [...existing, ...extra];
	const key = attachmentKey(selection);
	if (!merged.some(item => attachmentKey(item) === key)) {
		merged.push(selection);
	}
	return merged;
}

function attachmentKey(attachment: ContextAttachment): string {
	if (attachment.kind === 'selection') {
		return `${attachment.kind}:${attachment.uri}:${attachment.range.startLine}`;
	}
	return attachment.kind;
}
