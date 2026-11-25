/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { ConfigurationTarget } from '../../../../platform/configuration/common/configuration.js';
import { CLAUDE_AUTO_ENABLED_SETTING } from '../../../../platform/claude/common/claudeConfiguration.js';

/** The part of the configuration service Auto writes through. */
export interface ClaudeAutoSettingWriter {
	updateValue(key: string, value: unknown, target: ConfigurationTarget): Promise<void>;
}

/**
 * Turns Auto on or off. Auto is a model-picker entry (issue 1579): it changes
 * only who picks the model, never the permission level, which stays as the user set it.
 */
export async function setClaudeAutoEnabled(writer: ClaudeAutoSettingWriter, on: boolean): Promise<void> {
	await writer.updateValue(CLAUDE_AUTO_ENABLED_SETTING, on, ConfigurationTarget.USER);
}

/** The model picker's Auto entry: its label and the line under it (DL-109, issue 1579). */
export function claudeAutoModelEntryText(): { readonly label: string; readonly description: string } {
	return {
		label: localize('claudeAutoModelEntry', "Auto"),
		description: localize('claudeAutoModelEntryDesc', "Picks the model for each turn"),
	};
}
