/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { CLAUDE_REMOTE_SCHEME } from '../../../../platform/claude/common/claudeRemoteFiles.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { ClaudeRemoteFileSystemProvider } from '../../../services/claude/common/claudeRemoteFileSystemProvider.js';

/** Registers the `claude-remote:` provider, so Review and Restore reach files an agent changed on an SSH host (issue 425). */
export class ClaudeRemoteFilesContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.claudeRemoteFiles';

	constructor(
		@IFileService fileService: IFileService,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super();
		this._register(fileService.registerProvider(CLAUDE_REMOTE_SCHEME, instantiationService.createInstance(ClaudeRemoteFileSystemProvider)));
	}
}
