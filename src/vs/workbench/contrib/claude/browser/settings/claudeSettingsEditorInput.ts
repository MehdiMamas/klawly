/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { IEditorOptions } from '../../../../../platform/editor/common/editor.js';
import { IProductService } from '../../../../../platform/product/common/productService.js';
import { EditorInputCapabilities, IUntypedEditorInput } from '../../../../common/editor.js';
import { EditorInput } from '../../../../common/editor/editorInput.js';
import { ClaudeAutomationTemplateId } from '../../common/claudeAutomationTemplates.js';
import { ClaudeOpenForm } from '../../common/claudeCustomizeCreate.js';
import { ClaudeSettingsPageId } from '../../common/claudeSettingsPages.js';

/** The one resource of the settings editor: there is one settings tab. */
export const CLAUDE_SETTINGS_EDITOR_RESOURCE = URI.from({ scheme: 'klawly-settings', path: '/settings' });

/** Opens the settings tab at a page, or with a search already typed. */
export interface IClaudeSettingsEditorOptions extends IEditorOptions {
	readonly page?: ClaudeSettingsPageId;
	readonly query?: string;
	/** On the Customize page, opens this add form (issue 680). */
	readonly form?: ClaudeOpenForm;
	/** On the Agents page, opens the New Automation form from this template (issue 1076). */
	readonly automationTemplate?: ClaudeAutomationTemplateId;
}

/** The Klawly settings as an editor tab. Its state is the settings themselves. */
export class ClaudeSettingsEditorInput extends EditorInput {

	static readonly ID = 'workbench.input.claudeSettings';
	static readonly EDITOR_ID = 'workbench.editor.claudeSettings';

	constructor(@IProductService private readonly _product: IProductService) {
		super();
	}

	override get typeId(): string {
		return ClaudeSettingsEditorInput.ID;
	}

	override get editorId(): string | undefined {
		return ClaudeSettingsEditorInput.EDITOR_ID;
	}

	override get resource(): URI {
		return CLAUDE_SETTINGS_EDITOR_RESOURCE;
	}

	override get capabilities(): EditorInputCapabilities {
		return EditorInputCapabilities.Singleton;
	}

	override getName(): string {
		return localize('claudeSettingsEditorName', "{0} Settings", this._product.nameShort);
	}

	override getIcon(): ThemeIcon {
		return Codicon.settings;
	}

	override matches(other: EditorInput | IUntypedEditorInput): boolean {
		return other instanceof ClaudeSettingsEditorInput || super.matches(other);
	}
}
