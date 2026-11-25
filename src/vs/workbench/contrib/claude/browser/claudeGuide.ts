/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Schemas } from '../../../../base/common/network.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, MenuId, MenuRegistry, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { klawlyGuideContext, klawlyGuidePrompt, KlawlyGuideKeybinding, KlawlyGuideSetting } from '../../../../platform/claude/common/claudeGuide.js';
import { CLAUDE_SUBAGENTS_BUILT_IN_SETTING } from '../../../../platform/claude/common/claudeConfiguration.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { IClaudeAgentService } from '../../../services/claude/common/claudeAgentService.js';
import { CLAUDE_AGENT_ENABLED } from '../common/claudeContextKeys.js';
import { CLAUDE_AGENT_VIEW_ID, KLAWLY_CATEGORY } from '../common/claudeViews.js';

export const KLAWLY_ASK_ABOUT_KLAWLY_COMMAND_ID = 'klawly.askAboutKlawly';

/** Settings and shortcuts of Klawly that the guide cannot read from FEATURES.md (issue 663). */
function isKlawlyKey(id: string): boolean {
	return id.startsWith('claude.') || id.startsWith('klawly.');
}

function klawlyWindowFacts(keybindings: IKeybindingService): string {
	const settings: KlawlyGuideSetting[] = Object.entries(Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).getConfigurationProperties())
		.filter(([key]) => isKlawlyKey(key))
		.map(([key, schema]) => ({ key, description: schema.markdownDescription ?? schema.description ?? '', defaultValue: schema.default }));
	const shortcuts: KlawlyGuideKeybinding[] = [];
	for (const item of keybindings.getKeybindings()) {
		const keys = item.resolvedKeybinding?.getLabel();
		const title = item.command ? MenuRegistry.getCommand(item.command)?.title : undefined;
		if (keys && item.command && isKlawlyKey(item.command) && title) {
			shortcuts.push({ label: typeof title === 'string' ? title : title.value, keys });
		}
	}
	return klawlyGuideContext(settings, shortcuts);
}

/**
 * Help > Ask About Klawly (issue 524): asks the question in a new chat through the
 * built-in klawly-guide subagent, which answers from Klawly's own docs with no tools.
 */
export function registerClaudeGuide(): void {
	registerAction2(class extends Action2 {
		constructor() {
			super({
				id: KLAWLY_ASK_ABOUT_KLAWLY_COMMAND_ID,
				title: localize2('klawlyAskAboutKlawly', "Ask About Klawly..."),
				category: KLAWLY_CATEGORY,
				f1: true,
				precondition: CLAUDE_AGENT_ENABLED,
				menu: { id: MenuId.MenubarHelpMenu, group: '3_feedback', order: -1, when: CLAUDE_AGENT_ENABLED },
			});
		}

		async run(accessor: ServicesAccessor, question?: unknown): Promise<void> {
			const configuration = accessor.get(IConfigurationService);
			const notifications = accessor.get(INotificationService);
			const quickInput = accessor.get(IQuickInputService);
			const workspace = accessor.get(IWorkspaceContextService);
			const views = accessor.get(IViewsService);
			const agent = accessor.get(IClaudeAgentService);
			const keybindings = accessor.get(IKeybindingService);
			if (configuration.getValue<boolean>(CLAUDE_SUBAGENTS_BUILT_IN_SETTING) === false) {
				notifications.prompt(Severity.Info, localize('klawlyGuideNeedsAgents', "Ask About Klawly uses Klawly's built-in subagents, which are turned off."), [{
					label: localize('klawlyGuideTurnOn', "Turn On"),
					run: () => configuration.updateValue(CLAUDE_SUBAGENTS_BUILT_IN_SETTING, true),
				}]);
				return;
			}
			const asked = typeof question === 'string' && question.trim() ? question : await quickInput.input({
				prompt: localize('klawlyGuidePrompt', "What do you want to know about Klawly?"),
				placeHolder: localize('klawlyGuidePlaceholder', "How do I review Claude's changes before keeping them?"),
			});
			if (!asked?.trim()) {
				return;
			}
			const cwd = workspace.getWorkspace().folders.find(folder => folder.uri.scheme === Schemas.file)?.uri.fsPath;
			if (!cwd) {
				notifications.error(localize('claudeNeedsFolder', "Open a local folder before messaging the agent."));
				return;
			}
			const session = agent.createSession();
			await views.openView(CLAUDE_AGENT_VIEW_ID, true);
			const text = klawlyGuidePrompt(asked);
			const facts = klawlyWindowFacts(keybindings);
			await agent.submit(session.id, text, cwd, { compiled: facts ? `${text}\n\n${facts}` : text, label: localize('klawlyGuideTurnLabel', "Ask About Klawly: {0}", asked.trim()) });
		}
	});
}
