/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as nls from '../../../../nls.js';
import { registerSize, sizeForAllThemes } from '../sizeUtils.js';

// Klawly v5 type and spacing tokens (design canvas page v5, frames Type and Tokens).
// Emitted as `--vscode-klawly-*` CSS variables. Three text sizes only: 12, 13, 15.

export const fontSizeMeta = registerSize('klawly.fontSize.meta',
	sizeForAllThemes(12, 'px'),
	nls.localize('fontSizeMeta', "Klawly meta text size: meta lines, tool rows, compact buttons, status bar (VC02)."));

export const fontSizeBody = registerSize('klawly.fontSize.body',
	sizeForAllThemes(13, 'px'),
	nls.localize('fontSizeBody', "Klawly body text size: chat text, large buttons, menus, settings fields (VC01, VC02)."));

export const fontSizeHeading = registerSize('klawly.fontSize.heading',
	sizeForAllThemes(15, 'px'),
	nls.localize('fontSizeHeading', "Klawly heading size: plan titles, settings page titles, card heads (VC02). Pair with `fontWeight.semiBold`."));

export const lineHeightBody = registerSize('klawly.lineHeight.body',
	sizeForAllThemes(1.5, ''),
	nls.localize('lineHeightBody', "Klawly line height (unitless) for meta and body text."));

export const lineHeightHeading = registerSize('klawly.lineHeight.heading',
	sizeForAllThemes(1.3, ''),
	nls.localize('lineHeightHeading', "Klawly line height (unitless) for headings."));

export const cornerRadius = registerSize('klawly.cornerRadius',
	sizeForAllThemes(6, 'px'),
	nls.localize('cornerRadius', "Klawly corner radius for cards and buttons (VC21). Pills are for status only."));

export const klawlyCornerRadiusLarge = registerSize('klawly.cornerRadius.large',
	sizeForAllThemes(8, 'px'),
	nls.localize('cornerRadiusLarge', "Klawly corner radius for the larger surfaces of the Agent pane: user messages, permission cards, the composer and tool output (frames v5-S12, v5-S13)."));

export const klawlyCornerRadiusSmall = registerSize('klawly.cornerRadius.small',
	sizeForAllThemes(4, 'px'),
	nls.localize('cornerRadiusSmall', "Klawly corner radius for the small parts of the Agent pane: tool icons, file chips and inline code (frames v5-S12, v5-S13)."));

export const buttonHeightCompact = registerSize('klawly.button.height.compact',
	sizeForAllThemes(24, 'px'),
	nls.localize('buttonHeightCompact', "Klawly compact button height (VC21)."));

export const buttonHeightLarge = registerSize('klawly.button.height.large',
	sizeForAllThemes(28, 'px'),
	nls.localize('buttonHeightLarge', "Klawly large button height (VC21)."));

export const headerHeight = registerSize('klawly.header.height',
	sizeForAllThemes(35, 'px'),
	nls.localize('headerHeight', "Klawly pane header height; one header per pane (VC04)."));

export const paneWidth = registerSize('klawly.pane.width',
	sizeForAllThemes(400, 'px'),
	nls.localize('paneWidth', "Klawly default Agent pane width (VC03)."));

export const paneMinWidth = registerSize('klawly.pane.minWidth',
	sizeForAllThemes(320, 'px'),
	nls.localize('paneMinWidth', "Klawly minimum Agent pane width (VC03)."));

export const planMaxWidth = registerSize('klawly.plan.maxWidth',
	sizeForAllThemes(72, 'ch'),
	nls.localize('planMaxWidth', "Klawly maximum plan line width, in characters (VC11)."));

export const gap40 = registerSize('klawly.gap.xSmall',
	sizeForAllThemes(4, 'px'),
	nls.localize('gap40', "Klawly gap step 4."));

export const gap60 = registerSize('klawly.gap.small',
	sizeForAllThemes(6, 'px'),
	nls.localize('gap60', "Klawly gap step 6."));

export const gap80 = registerSize('klawly.gap.medium',
	sizeForAllThemes(8, 'px'),
	nls.localize('gap80', "Klawly gap step 8."));

export const gap120 = registerSize('klawly.gap.large',
	sizeForAllThemes(12, 'px'),
	nls.localize('gap120', "Klawly gap step 12."));

export const gap160 = registerSize('klawly.gap.xLarge',
	sizeForAllThemes(16, 'px'),
	nls.localize('gap160', "Klawly gap step 16."));
