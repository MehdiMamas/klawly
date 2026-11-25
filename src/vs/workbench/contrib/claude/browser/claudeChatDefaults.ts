/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { ChatAIDisabledSettingId } from '../../../../platform/chat/common/chatSettings.js';
import { Extensions as ConfigurationExtensions, IConfigurationDefaults, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { USE_MODAL_EDITOR_SETTING } from '../../../services/editor/common/editorService.js';
import { ChatConfiguration } from '../../chat/common/constants.js';
import { ActivityBarPosition, LayoutSettings } from '../../../services/layout/browser/layoutService.js';
import { ThemeSettingDefaults, ThemeSettings } from '../../../services/themes/common/workbenchThemeService.js';

/**
 * Claude onboarding replaces the Copilot setup flow, so Copilot's setup prompts,
 * status item and chat entry points start hidden (`chat.disableAIFeatures`).
 * A user can still turn them on. `product.json` keeps `defaultChatAgent`: the
 * account and welcome onboarding services read it at startup.
 *
 * Klawly Dark and Klawly Light (`extensions/theme-klawly`) are the default themes.
 * `ThemeSettingDefaults` names them too, so the first paint already uses them;
 * these overrides keep the Klawly layer explicit if an upstream merge resets it.
 *
 * Nothing opens at startup (`workbench.startupEditor`): an empty window shows
 * Klawly's Home in the editor area instead of the Welcome page.
 *
 * The window layout (ide-03, ide-04): the view switcher sits on top of the side
 * bar instead of in a separate bar, so Settings moves to the title bar; the title
 * bar shows the project name rather than a search box; and the layout control
 * is its toggles alone (side bar, panel, agent), without the extra menu button.
 * The view switcher hides where it would hold one view container
 * (`workbench.activityBar.autoHide`), so the agent pane opens on its own header
 * row, level with the editor tabs (#106); the side bar keeps its icons.
 *
 * The frame is flat: upstream's Modern UI (`workbench.experimental.modernUI`)
 * stays off, so the parts touch edge to edge with 1px borders instead of floating
 * as rounded cards. `preventExperimentOverride` keeps the experiment from turning it on.
 *
 * The editor is quiet: no minimap, indent guides, whitespace dots in selections,
 * lightbulb or colored bracket pairs, and selections are square. Brackets take
 * the theme's punctuation color instead. The overview ruler stays: it marks where
 * a turn's pending changes are. A user can turn any of these back on.
 *
 * Code is set in Cascadia Code at 13px on a 19px line, with ligatures, like the
 * prototype's mono font (`design/assets/global.css`). Cascadia Code ships with
 * Windows 11 only, so the family falls back to Consolas, then the macOS and Linux
 * monospace fonts. The terminal inherits the family from the editor and takes the
 * same 13px size.
 *
 * View header actions stay visible on expanded views (`workbench.view.alwaysShowHeaderActions`),
 * so New File, New Folder, Refresh and Collapse show on the Explorer's root header without a hover.
 *
 * Breadcrumbs show the path and the innermost symbol at the cursor only
 * (`breadcrumbs.symbolPath: last`), not the whole chain of symbols around it.
 *
 * The terminal is quiet too (issue 166): a new terminal shows no first-run hint
 * (`terminal.integrated.initialHint`), and command decorations stay in the
 * overview ruler instead of a circle in the gutter beside each prompt.
 *
 * Settings and Keyboard Shortcuts open as editor tabs, not in a centered modal
 * (`workbench.editor.useModal: off`). With `off`, an explicit `MODAL_GROUP`
 * request falls back to the normal editor group too, so both editors follow it.
 *
 * VS Code's own title bar button for its Agents window stays hidden: Klawly's Agents
 * Window pill opens that window when `claude.agentsWindow.enabled` is on (DL-27).
 */
export function registerClaudeChatDefaults(): IDisposable {
	const defaults: IConfigurationDefaults = {
		overrides: {
			[ChatAIDisabledSettingId]: true,
			[ThemeSettings.COLOR_THEME]: ThemeSettingDefaults.COLOR_THEME_DARK,
			[ThemeSettings.PREFERRED_DARK_THEME]: ThemeSettingDefaults.COLOR_THEME_DARK,
			[ThemeSettings.PREFERRED_LIGHT_THEME]: ThemeSettingDefaults.COLOR_THEME_LIGHT,
			'workbench.startupEditor': 'none',
			[LayoutSettings.ACTIVITY_BAR_LOCATION]: ActivityBarPosition.TOP,
			[LayoutSettings.COMMAND_CENTER]: false,
			[LayoutSettings.MODERN_UI]: false,
			'workbench.layoutControl.type': 'toggles',
			'window.title': '${dirty}${rootName}${separator}${profileName}',
			'editor.minimap.enabled': false,
			'editor.guides.indentation': false,
			'editor.renderWhitespace': 'none',
			'editor.bracketPairColorization.enabled': false,
			'editor.lightbulb.enabled': 'off',
			'editor.roundedSelection': false,
			'editor.fontFamily': '"Cascadia Code", Consolas, "SF Mono", Menlo, "Courier New", monospace',
			'editor.fontSize': 13,
			'editor.lineHeight': 19,
			'editor.fontLigatures': true,
			'terminal.integrated.fontSize': 13,
			'workbench.view.alwaysShowHeaderActions': true,
			'breadcrumbs.symbolPath': 'last',
			'terminal.integrated.initialHint': false,
			'terminal.integrated.shellIntegration.decorationsEnabled': 'overviewRuler',
			[USE_MODAL_EDITOR_SETTING]: 'off',
			[LayoutSettings.ACTIVITY_BAR_AUTO_HIDE]: true,
			[ChatConfiguration.TitleBarOpenInAgentsWindowEnabled]: false,
		},
		donotCache: true,
		preventExperimentOverride: true,
		source: 'klawlyDefaults',
	};
	const registry = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration);
	registry.registerDefaultConfigurations([defaults]);
	return toDisposable(() => registry.deregisterDefaultConfigurations([defaults]));
}
