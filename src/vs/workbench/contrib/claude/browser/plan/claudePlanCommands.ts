/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { joinPath } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { IProductService } from '../../../../../platform/product/common/productService.js';
import { IPathService } from '../../../../services/path/common/pathService.js';

/** Opens a chat's plan as a file: `(sessionId, turnId, notes, plan)`. Used by Open Plan on the plan card. */
export const CLAUDE_OPEN_CHAT_PLAN_COMMAND_ID = 'klawly.plan.openFromChat';

/** Builds the plan in the active plan editor (Ctrl+Enter there). */
export const CLAUDE_BUILD_PLAN_COMMAND_ID = 'klawly.plan.build';

/** Moves a plan from Klawly's plan folder for this user into the workspace's `.claude/plans`: `(resource?)`. */
export const CLAUDE_SAVE_PLAN_TO_WORKSPACE_COMMAND_ID = 'klawly.plan.saveToWorkspace';

/** The plan editor's id, for opening a plan file in it from outside the plan contribution. */
export const CLAUDE_PLAN_EDITOR_ID = 'workbench.editor.klawlyPlan';

/**
 * Klawly's plan folder for this user, `~/.klawly/plans` (issue 322). Plans live
 * here by default, out of the project; `klawlyPlanDirectory` is the same path
 * on the Node side, where the tool policy lets Claude read and tick them.
 */
export async function userPlansFolder(paths: IPathService, product: IProductService): Promise<URI> {
	return joinPath(await paths.userHome(), product.dataFolderName, 'plans');
}
