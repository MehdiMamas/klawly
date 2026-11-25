/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Emitter } from '../../../../../base/common/event.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IClaudeRuntimeService } from '../../../../../platform/claude/common/claude.js';
import { ClaudeSettingsToolRequest, ClaudeSettingsToolResult } from '../../../../../platform/claude/common/claudeSettingsTool.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { ConfigurationScope, IConfigurationPropertySchema } from '../../../../../platform/configuration/common/configurationRegistry.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { IWorkspaceContextService, WorkbenchState } from '../../../../../platform/workspace/common/workspace.js';
import { IClaudeAgentService } from '../../../../services/claude/common/claudeAgentService.js';
import { ClaudeSettingsToolHandler } from '../../browser/claudeSettingsToolHandler.js';

suite('Claude settings tool handler (issue 525)', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('finds, changes at the right scope, and refuses blocked keys, wrong types and other windows\' chats', async () => {
		const requests = store.add(new Emitter<ClaudeSettingsToolRequest>());
		const answers: [string, ClaudeSettingsToolResult][] = [];
		const updates: [string, unknown, ConfigurationTarget][] = [];
		const configuration = new TestConfigurationService({ editor: { fontSize: 14 } });
		configuration.updateValue = async (key: string, value: unknown, target?: unknown) => { updates.push([key, value, target as ConfigurationTarget]); };
		const schema: Record<string, IConfigurationPropertySchema> = {
			'editor.fontSize': { type: 'number', default: 14, minimum: 6, maximum: 100, description: 'Controls the font size in pixels.' },
			'editor.wordWrap': { type: 'string', enum: ['off', 'on'], default: 'off', description: 'Controls how lines wrap.' },
			'window.zoomLevel': { type: 'number', default: 0, scope: ConfigurationScope.APPLICATION, description: 'Zoom level of the window.' },
			'claude.agent.defaultPermissionMode': { type: 'string', default: 'strict', description: 'The permission level of every chat.' },
			'old.setting': { type: 'boolean', default: false, description: 'font', deprecationMessage: 'gone' },
		};
		const handler = new ClaudeSettingsToolHandler(
			() => schema,
			{ onDidRequestSettings: requests.event, resolveSettingsRequest: async (_session: string, requestId: string, result: ClaudeSettingsToolResult) => { answers.push([requestId, result]); } } as unknown as IClaudeRuntimeService,
			{ getSessions: () => [{ id: 'chat' }], getRuntimeSessionId: () => 'runtime-1' } as unknown as IClaudeAgentService,
			configuration as unknown as IConfigurationService,
			{ getWorkbenchState: () => WorkbenchState.FOLDER } as unknown as IWorkspaceContextService,
		);
		store.add(handler);
		const ask = async (requestId: string, request: Partial<ClaudeSettingsToolRequest>, sessionId = 'runtime-1') => {
			requests.fire({ sessionId, requestId, ...request } as ClaudeSettingsToolRequest);
			await new Promise(resolve => setTimeout(resolve, 0));
		};
		await ask('find', { action: 'find', query: 'font size' });
		await ask('set', { action: 'set', key: 'editor.fontSize', value: 16, scope: 'user' });
		await ask('workspace', { action: 'set', key: 'editor.wordWrap', value: 'on', scope: 'workspace' });
		await ask('blocked', { action: 'set', key: 'claude.agent.defaultPermissionMode', value: 'allowEverything', scope: 'user' });
		await ask('type', { action: 'set', key: 'editor.fontSize', value: '16', scope: 'user' });
		await ask('range', { action: 'set', key: 'editor.fontSize', value: 400, scope: 'user' });
		await ask('enum', { action: 'set', key: 'editor.wordWrap', value: 'bounded', scope: 'user' });
		await ask('appScope', { action: 'set', key: 'window.zoomLevel', value: 1, scope: 'workspace' });
		await ask('unknown', { action: 'set', key: 'no.such', value: 1, scope: 'user' });
		await ask('other', { action: 'find', query: 'font' }, 'runtime-9');
		const by = new Map(answers);
		assert.deepStrictEqual({
			found: by.get('find'),
			set: by.get('set'),
			workspace: by.get('workspace')?.kind,
			refused: ['blocked', 'type', 'range', 'enum', 'appScope', 'unknown'].map(id => { const result = by.get(id); return result?.kind === 'refused' ? result.message : result?.kind; }),
			otherWindow: by.has('other'),
			updates,
		}, {
			found: { kind: 'found', settings: [{ key: 'editor.fontSize', description: 'Controls the font size in pixels.', value: 14, default: 14, type: 'number' }] },
			set: { kind: 'set', key: 'editor.fontSize', previous: 14, value: 16, scope: 'user' },
			workspace: 'set',
			refused: [
				'claude.agent.defaultPermissionMode controls permissions, trust or what leaves the machine, so Claude cannot change it. Ask the user to change it in Settings.',
				'editor.fontSize takes a number, not "16".',
				'editor.fontSize must be at most 100.',
				'editor.wordWrap takes one of ["off","on"].',
				'window.zoomLevel applies to every window, so it can only be a user setting.',
				'There is no setting no.such. Use klawly_settings_find for the exact key.',
			],
			otherWindow: false,
			updates: [['editor.fontSize', 16, ConfigurationTarget.USER], ['editor.wordWrap', 'on', ConfigurationTarget.WORKSPACE]],
		});
	});
});
