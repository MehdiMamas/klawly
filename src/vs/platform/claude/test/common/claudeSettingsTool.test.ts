/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { DEFAULT_PERMISSION_POLICY } from '../../common/claudePermissions.js';
import { CLAUDE_SETTINGS_FIND_TOOL_ID, CLAUDE_SETTINGS_SET_TOOL_ID, claudeSettingsChangeSubject, claudeSettingsToolText, isClaudeBlockedSetting } from '../../common/claudeSettingsTool.js';
import { evaluateToolPolicy, ToolPolicyContext } from '../../common/claudeToolPolicy.js';

suite('Claude settings tools (issue 525)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const context: ToolPolicyContext = { cwd: '/ws', workspaceFolders: ['/ws'], additionalDirectories: [], trusted: true, policy: { ...DEFAULT_PERMISSION_POLICY } };

	test('permissions, trust, runtime, telemetry and what leaves the machine are blocked; ordinary settings are not', () => {
		const keys = ['claude.agent.defaultPermissionMode', 'claude.agent.permissions.network', 'claude.agent.autoApproveWorkspaceWrites', 'claude.agent.runtimePath', 'claude.telemetry.enabled', 'claude.share.links', 'security.workspace.trust.enabled', 'update.mode', 'terminal.integrated.env.osx', 'editor.fontSize', 'claude.autocomplete.enabled', 'workbench.colorTheme'];
		assert.deepStrictEqual(keys.filter(isClaudeBlockedSetting), keys.slice(0, 9));
	});

	test('finding runs without a card, a change always asks with the setting and value, and a blocked one is refused', async () => {
		const decide = async (tool: string, input: unknown) => {
			const result = await evaluateToolPolicy(tool, input, context);
			return [result.behavior, result.subject, result.canRemember];
		};
		assert.deepStrictEqual([
			await decide(CLAUDE_SETTINGS_FIND_TOOL_ID, { query: 'font size' }),
			await decide(CLAUDE_SETTINGS_SET_TOOL_ID, { key: 'editor.fontSize', value: 16 }),
			await decide(CLAUDE_SETTINGS_SET_TOOL_ID, { key: 'editor.tabSize', value: 2, scope: 'workspace' }),
			await decide(CLAUDE_SETTINGS_SET_TOOL_ID, { key: 'claude.agent.defaultPermissionMode', value: 'allowEverything' }),
			(await evaluateToolPolicy(CLAUDE_SETTINGS_SET_TOOL_ID, { value: 1 }, context)).behavior,
		], [
			['allow', CLAUDE_SETTINGS_FIND_TOOL_ID, true],
			['ask', 'editor.fontSize = 16 (user)', false],
			['ask', 'editor.tabSize = 2 (workspace)', false],
			['deny', 'claude.agent.defaultPermissionMode = "allowEverything" (user)', false],
			'deny',
		]);
	});

	test('what Claude reads back', () => {
		assert.deepStrictEqual([
			claudeSettingsToolText({ kind: 'found', settings: [] }),
			claudeSettingsToolText({ kind: 'found', settings: [{ key: 'editor.fontSize', description: 'Font size', value: 14, default: 14, type: 'number' }] }).text,
			claudeSettingsToolText({ kind: 'set', key: 'editor.fontSize', previous: 14, value: 16, scope: 'user' }),
			claudeSettingsToolText({ kind: 'refused', message: 'no' }),
			claudeSettingsChangeSubject({ value: 1 }),
		], [
			{ text: 'No setting matches. Try other words.', isError: false },
			'{"key":"editor.fontSize","description":"Font size","value":14,"default":14,"type":"number"}',
			{ text: 'Changed editor.fontSize from 14 to 16 (user settings).', isError: false },
			{ text: 'no', isError: true },
			undefined,
		]);
	});
});
