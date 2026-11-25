/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../browser/editor.js';
import { EditorExtensions } from '../../../common/editor.js';
import { ClaudeSplitEditor, ClaudeSplitInput } from './claudeSplitEditor.js';

/** Registers the group editor for Split into Pull Requests (issue 970). The tab is not restored on restart: the plan is built from the changes that exist then. */
export function registerClaudeSplit(): void {
	Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
		EditorPaneDescriptor.create(
			ClaudeSplitEditor,
			ClaudeSplitEditor.ID,
			localize('claudeSplitEditor', "Split into Pull Requests"),
		),
		[new SyncDescriptor(ClaudeSplitInput)],
	);
}
