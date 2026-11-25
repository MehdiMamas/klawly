/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { relativePath } from '../../../../base/common/resources.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { CLAUDE_REVIEW_CONFIG_FILE_SETTING, describeClaudeEffectiveReviewConfig, readClaudeReviewConfigFile, readClaudeReviewConfigLayers } from '../../../../platform/claude/common/claudeReviewConfig.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { EditorResourceAccessor } from '../../../common/editor.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { CLAUDE_AGENT_ENABLED } from '../common/claudeContextKeys.js';
import { KLAWLY_CATEGORY } from '../common/claudeViews.js';

export const CLAUDE_SHOW_EFFECTIVE_REVIEW_CONFIG_COMMAND_ID = 'claude.review.showEffectiveConfig';

/** Issue 922: shows which review rules, ignores and severity apply to the open file. */
export function registerClaudeReviewConfigCommand(): void {
	registerAction2(class extends Action2 {
		constructor() {
			super({
				id: CLAUDE_SHOW_EFFECTIVE_REVIEW_CONFIG_COMMAND_ID,
				title: localize2('claudeShowEffectiveReviewConfig', "Show Effective Review Config for This File"),
				category: KLAWLY_CATEGORY,
				f1: true,
				precondition: CLAUDE_AGENT_ENABLED,
			});
		}

		async run(accessor: ServicesAccessor): Promise<void> {
			const dialogs = accessor.get(IDialogService);
			const files = accessor.get(IFileService);
			const resource = EditorResourceAccessor.getOriginalUri(accessor.get(IEditorService).activeEditor);
			const folder = resource && accessor.get(IWorkspaceContextService).getWorkspaceFolder(resource);
			const path = folder && resource ? relativePath(folder.uri, resource) : undefined;
			if (!folder || !path) {
				await dialogs.info(localize('claudeReviewConfigNoFile', "Open a file in your workspace first."));
				return;
			}
			const name = readClaudeReviewConfigFile(accessor.get(IConfigurationService).getValue(CLAUDE_REVIEW_CONFIG_FILE_SETTING));
			const layers = await readClaudeReviewConfigLayers([path], name, async config => {
				try {
					return (await files.readFile(folder.toResource(config))).value.toString();
				} catch {
					return undefined;
				}
			});
			await dialogs.info(localize('claudeReviewConfigTitle', "Effective Review Config"), describeClaudeEffectiveReviewConfig(layers, path));
		}
	});
}
