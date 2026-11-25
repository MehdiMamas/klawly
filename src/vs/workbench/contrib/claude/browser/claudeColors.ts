/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Color } from '../../../../base/common/color.js';
import { localize } from '../../../../nls.js';
import { registerColor } from '../../../../platform/theme/common/colorRegistry.js';

/**
 * The agent's mode colors (DL-94, which replaces DL-09's teal Plan): Plan is orange, Agent is
 * gray, Ask is green, Debug is red and Multitask is purple; Accept Edits and auto stay purple
 * (DL-09). The pane tints the mode pill, the mode menu's icons, the plan card's label and the
 * permission level's icon from these (`--vscode-claude-mode-*`).
 * High contrast keeps its earlier values (DL-02).
 */
export const claudeModePlan = registerColor(
	'claude.mode.plan',
	{ dark: Color.fromHex('#dd8f52'), light: Color.fromHex('#9e5522'), hcDark: Color.fromHex('#f5c77e'), hcLight: Color.fromHex('#7a4f00') },
	localize('claude.mode.plan', "Color of the agent's Plan mode: its mode pill and plan actions.")
);

export const claudeModeAgent = registerColor(
	'claude.mode.agent',
	{ dark: Color.fromHex('#a3a3a3'), light: Color.fromHex('#5c5c5c'), hcDark: Color.fromHex('#d4d4d4'), hcLight: Color.fromHex('#3b3b3b') },
	localize('claude.mode.agent', "Color of the agent's Agent mode: its mode pill and its icon in the mode menu.")
);

export const claudeModeAsk = registerColor(
	'claude.mode.ask',
	{ dark: Color.fromHex('#7cba92'), light: Color.fromHex('#2a754c'), hcDark: Color.fromHex('#6fd39a'), hcLight: Color.fromHex('#11603a') },
	localize('claude.mode.ask', "Color of the agent's Ask mode: its mode pill.")
);

export const claudeModeAcceptEdits = registerColor(
	'claude.mode.acceptEdits',
	{ dark: Color.fromHex('#a891e6'), light: Color.fromHex('#6b52c0'), hcDark: Color.fromHex('#c6b5f5'), hcLight: Color.fromHex('#4b3399') },
	localize('claude.mode.acceptEdits', "Color of the Accept Edits and auto permission levels: their icon in the mode menu.")
);

export const claudeModeDebug = registerColor(
	'claude.mode.debug',
	{ dark: Color.fromHex('#ec7a8b'), light: Color.fromHex('#b4283d'), hcDark: Color.fromHex('#ff9aa8'), hcLight: Color.fromHex('#8f1c2e') },
	localize('claude.mode.debug', "Color of the agent's Debug mode: its mode pill and its icon in the mode menu.")
);

export const claudeModeMultitask = registerColor(
	'claude.mode.multitask',
	{ dark: Color.fromHex('#a891e6'), light: Color.fromHex('#6b52c0'), hcDark: Color.fromHex('#c6b5f5'), hcLight: Color.fromHex('#4b3399') },
	localize('claude.mode.multitask', "Color of parallel agents (Multitask): the icon on their cards.")
);
