/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../browser/editor.js';
import { EditorExtensions, IEditorFactoryRegistry, IEditorSerializer } from '../../../common/editor.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { parsePreviewUrl } from '../common/claudePreview.js';
import { registerClaudePreviewActions } from './claudePreviewActions.js';
import { ClaudePreviewEditor, ClaudePreviewInput } from './claudePreviewEditor.js';

export class ClaudePreviewInputSerializer implements IEditorSerializer {
	canSerialize(editor: EditorInput): boolean {
		return editor instanceof ClaudePreviewInput;
	}

	serialize(editor: EditorInput): string | undefined {
		return editor instanceof ClaudePreviewInput ? editor.url : undefined;
	}

	deserialize(instantiationService: IInstantiationService, serializedEditor: string): EditorInput | undefined {
		const href = parsePreviewUrl(serializedEditor);
		if (!href) {
			return undefined;
		}
		return instantiationService.createInstance(ClaudePreviewInput, href);
	}
}

export function registerClaudePreview(): void {
	Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
		EditorPaneDescriptor.create(
			ClaudePreviewEditor,
			ClaudePreviewEditor.ID,
			localize('claudePreviewEditor', "Browser Preview"),
		),
		[new SyncDescriptor(ClaudePreviewInput)],
	);
	Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).registerEditorSerializer(
		ClaudePreviewInput.ID,
		ClaudePreviewInputSerializer,
	);
	registerClaudePreviewActions();
}
