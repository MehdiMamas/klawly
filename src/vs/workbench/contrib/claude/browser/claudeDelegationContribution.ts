/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ClaudeDepartmentHandler } from '../../../services/claude/common/claudeDepartments.js';
import { ClaudeStartAgentHandler } from '../../../services/claude/common/claudeStartAgentHandler.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { IClaudeDelegationService } from '../../../services/claude/common/claudeDelegation.js';

/**
 * Starts the delegation service with the window, so Auto can delegate the first
 * message and the delegate tool is answered (issue 693).
 */
export class ClaudeDelegationContribution implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.claudeDelegation';

	constructor(@IClaudeDelegationService _delegation: IClaudeDelegationService) { }
}

/**
 * Answers `klawly_department` calls in this window (issue 1177).
 */
export class ClaudeDepartmentContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.claudeDepartment';

	constructor(@IInstantiationService instantiation: IInstantiationService) {
		super();
		this._register(instantiation.createInstance(ClaudeDepartmentHandler));
	}
}

/**
 * Answers `klawly_start_agent` calls in this window (issue 991).
 */
export class ClaudeStartAgentContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.claudeStartAgent';

	constructor(@IInstantiationService instantiation: IInstantiationService) {
		super();
		this._register(instantiation.createInstance(ClaudeStartAgentHandler));
	}
}
