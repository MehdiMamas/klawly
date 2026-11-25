/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { getActiveElement, isEditableElement } from '../../../../base/browser/dom.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { basename } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { ITextModel } from '../../../../editor/common/model.js';
import { IModelService } from '../../../../editor/common/services/model.js';
import { ITextModelContentProvider, ITextModelService } from '../../../../editor/common/services/resolverService.js';
import { localize } from '../../../../nls.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { claudeEditedFileOf } from '../../../../platform/claude/common/claudeAgentFileTouch.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IEditorService, SIDE_GROUP } from '../../../services/editor/common/editorService.js';
import { IClaudeAgentService } from '../../../services/claude/common/claudeAgentService.js';
import { claudeFollowAction } from './claudeFollowAction.js';
import { CLAUDE_FOLLOW_AGENT_EDITS_SETTING } from './claudeFollowAgentEdits.js';
import { claudeLiveDiffAppend, claudeLiveDiffClear, claudeLiveDiffHunksOf, claudeLiveDiffKey, claudeLiveDiffTexts, ClaudeLiveDiffState, EMPTY_CLAUDE_LIVE_DIFF_STATE } from '../common/claudeLiveDiff.js';

export const CLAUDE_LIVE_DIFF_SETTING = 'claude.editor.followAgentEditsDiff';
const CLAUDE_LIVE_DIFF_SCHEME = 'claude-live-diff';

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'claude',
	order: 102,
	title: localize('claudeLiveDiffConfigurationTitle', "AI / Claude"),
	type: 'object',
	properties: {
		[CLAUDE_LIVE_DIFF_SETTING]: {
			type: 'boolean',
			scope: ConfigurationScope.APPLICATION,
			default: false,
			description: localize('claudeLiveDiffSetting', "While following Claude's edits, also opens a diff beside the editor that grows with each change the agent makes to the file. It never takes focus from your typing."),
		},
	},
});

/** The side view of one agent's changes to one file (issue 1367). `side` is the original or the modified text. */
function liveDiffUri(key: string, side: 'original' | 'modified', file: string): URI {
	return URI.from({ scheme: CLAUDE_LIVE_DIFF_SCHEME, path: `/${side}/${basename(URI.file(file))}`, query: key });
}

/**
 * Shows what each agent changes in a file as a diff beside the editor, growing with every Edit, MultiEdit or Write call.
 * The protocol delivers an edit's input whole, so the diff grows per change, not per token.
 */
class ClaudeLiveDiffContribution extends Disposable implements IWorkbenchContribution, ITextModelContentProvider {

	static readonly ID = 'workbench.contrib.claudeLiveDiff';

	private _state: ClaudeLiveDiffState = EMPTY_CLAUDE_LIVE_DIFF_STATE;
	private readonly _files = new Map<string, string>();

	constructor(
		@IClaudeAgentService agentService: IClaudeAgentService,
		@IConfigurationService private readonly _configuration: IConfigurationService,
		@IEditorService private readonly _editors: IEditorService,
		@IModelService private readonly _models: IModelService,
		@ITextModelService textModels: ITextModelService,
	) {
		super();
		this._register(textModels.registerTextModelContentProvider(CLAUDE_LIVE_DIFF_SCHEME, this));
		this._register(agentService.onDidReceiveEvent(event => {
			const agentId = event.parentRunId ? `${event.sessionId}:${event.parentRunId}` : event.sessionId;
			if (event.type === 'tool.started') {
				const file = claudeEditedFileOf(event.call.name, event.call.input);
				const hunks = claudeLiveDiffHunksOf(event.call.name, event.call.input);
				if (file && hunks.length) {
					this.add(agentId, file, hunks);
				}
			} else if (event.type === 'session.completed' || event.type === 'session.failed') {
				this._state = claudeLiveDiffClear(this._state, event.sessionId);
			}
		}));
	}

	private add(agentId: string, file: string, hunks: Parameters<typeof claudeLiveDiffAppend>[2]): void {
		const key = claudeLiveDiffKey(agentId, file);
		this._files.set(key, file);
		this._state = claudeLiveDiffAppend(this._state, key, hunks);
		const texts = claudeLiveDiffTexts(this._state.get(key) ?? []);
		const original = liveDiffUri(key, 'original', file);
		const modified = liveDiffUri(key, 'modified', file);
		this._models.getModel(original)?.setValue(texts.original);
		this._models.getModel(modified)?.setValue(texts.modified);
		if (this._configuration.getValue<boolean>(CLAUDE_FOLLOW_AGENT_EDITS_SETTING) === false || this._configuration.getValue<boolean>(CLAUDE_LIVE_DIFF_SETTING) !== true) {
			return;
		}
		const element = getActiveElement();
		if (claudeFollowAction(true, !!element && isEditableElement(element)) === 'open') {
			this._editors.openEditor({
				original: { resource: original },
				modified: { resource: modified },
				label: localize('claudeLiveDiffLabel', "Claude's Changes to {0}", basename(URI.file(file))),
				options: { preserveFocus: true, pinned: false },
			}, SIDE_GROUP);
		}
	}

	provideTextContent(resource: URI): Promise<ITextModel | null> | null {
		const key = resource.query;
		if (!this._files.has(key)) {
			return null;
		}
		const texts = claudeLiveDiffTexts(this._state.get(key) ?? []);
		const existing = this._models.getModel(resource);
		if (existing && !existing.isDisposed()) {
			return Promise.resolve(existing);
		}
		return Promise.resolve(this._models.createModel(resource.path.startsWith('/original/') ? texts.original : texts.modified, null, resource));
	}
}

registerWorkbenchContribution2(ClaudeLiveDiffContribution.ID, ClaudeLiveDiffContribution, WorkbenchPhase.AfterRestored);
