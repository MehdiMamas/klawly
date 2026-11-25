/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IClaudeWorktreeService } from '../../../../platform/claude/common/claudeBackground.js';
import { IEditorService } from '../../editor/common/editorService.js';
import { INativeWorkbenchEnvironmentService } from '../../environment/electron-browser/environmentService.js';
import { IClaudeAgentService } from '../common/claudeAgentService.js';
import { ClaudeBackgroundAgentService, ClaudeBackgroundPreview, IClaudeBackgroundAgentService, IClaudeBackgroundPreview } from '../common/claudeBackgroundAgent.js';
import { IClaudeReviewService } from '../common/claudeReview.js';
import { IClaudeWorkerRegistry } from '../common/claudeWorkerRegistry.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ClaudeWorktreeKeeper } from '../common/claudeWorktreeKeeper.js';
import { IWorkspaceTrustManagementService } from '../../../../platform/workspace/common/workspaceTrust.js';

export class NativeClaudeBackgroundPreview extends ClaudeBackgroundPreview {
	constructor(
		@INativeWorkbenchEnvironmentService environmentService: INativeWorkbenchEnvironmentService,
		@IClaudeReviewService review: IClaudeReviewService,
		@IDialogService dialog: IDialogService,
		@IEditorService editor: IEditorService,
		@IFileService files: IFileService,
	) {
		super(environmentService.userDataPath, review, dialog, editor, files);
	}
}

export class NativeClaudeBackgroundAgentService extends ClaudeBackgroundAgentService {
	constructor(
		@INativeWorkbenchEnvironmentService environmentService: INativeWorkbenchEnvironmentService,
		@IClaudeWorktreeService git: IClaudeWorktreeService,
		@IClaudeAgentService agent: IClaudeAgentService,
		@IClaudeBackgroundPreview preview: IClaudeBackgroundPreview,
		@IConfigurationService configuration: IConfigurationService,
		@IWorkspaceContextService workspace: IWorkspaceContextService,
		@IEditorService editor: IEditorService,
		@IFileService files: IFileService,
		@IDialogService dialog: IDialogService,
		@IWorkspaceTrustManagementService trust: IWorkspaceTrustManagementService,
		@IClaudeWorkerRegistry registry: IClaudeWorkerRegistry,
	) {
		super(environmentService.userDataPath, git, agent, preview, configuration, workspace, editor, files, dialog, trust, registry);
	}
}

export class NativeClaudeWorktreeKeeper extends ClaudeWorktreeKeeper {
	constructor(
		@INativeWorkbenchEnvironmentService environmentService: INativeWorkbenchEnvironmentService,
		@IStorageService storage: IStorageService,
		@IClaudeWorktreeService git: IClaudeWorktreeService,
		@IClaudeBackgroundAgentService background: IClaudeBackgroundAgentService,
		@IConfigurationService configuration: IConfigurationService,
		@IFileService files: IFileService,
	) {
		super(environmentService.userDataPath, storage, git, background, configuration, files);
	}
}
