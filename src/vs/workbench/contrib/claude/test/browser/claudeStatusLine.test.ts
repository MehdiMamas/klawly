/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { timeout } from '../../../../../base/common/async.js';
import { Emitter } from '../../../../../base/common/event.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IClaudeRuntimeService } from '../../../../../platform/claude/common/claude.js';
import { ClaudeStatusLineRequest, ClaudeStatusLineResult } from '../../../../../platform/claude/common/claudeStatusLine.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IWorkspaceTrustManagementService } from '../../../../../platform/workspace/common/workspaceTrust.js';
import { TestWorkspaceTrustManagementService } from '../../../../test/common/workbenchTestServices.js';
import { IClaudeAgentService } from '../../../../services/claude/common/claudeAgentService.js';
import { IClaudeWorkerRegistry } from '../../../../services/claude/common/claudeWorkerRegistry.js';
import { CLAUDE_STATUS_LINE_SHOW_COST_SETTING } from '../../../../../platform/claude/common/claudeStatusLine.js';
import { ClaudeStatusLine } from '../../browser/chat/claudeStatusLine.js';

suite('Claude status line widget (issue 515)', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('shows the colored first line after a turn ends, never while it streams, and hides when there is none', async () => {
		const requests: ClaudeStatusLineRequest[] = [];
		let answer: ClaudeStatusLineResult = { kind: 'line', text: '\u001b[32mmain\u001b[0m Opus' };
		let status: 'running' | 'completed' = 'running';
		const viewState = store.add(new Emitter<{ readonly sessionId: string }>());
		const session = { id: 's1', claudeSessionId: 'cc-1', modelId: 'opus', modelName: 'Opus 5.5' };
		const instantiation = store.add(new TestInstantiationService());
		instantiation.stub(IClaudeRuntimeService, {
			getRuntimeState: async () => ({ version: '2.1.296' }),
			runStatusLine: async (request: ClaudeStatusLineRequest) => { requests.push(request); return answer; },
		} as unknown as IClaudeRuntimeService);
		instantiation.stub(IClaudeAgentService, {
			onDidChangeSession: store.add(new Emitter<void>()).event,
			onDidChangeViewState: viewState.event,
			getCurrentSession: () => session,
			getViewState: () => ({ turns: [{ id: 't1', status }], usage: { costUsd: 0.25 } }),
		} as unknown as IClaudeAgentService);
		// The runs a chat started roll their cost up into the chat's (issues 693, 836).
		instantiation.stub(IClaudeWorkerRegistry, { sessionTotals: () => ({ costUsd: 0.5, inputTokens: 0, outputTokens: 0, runs: 1 }) } as unknown as IClaudeWorkerRegistry);
		instantiation.stub(IConfigurationService, new TestConfigurationService());
		instantiation.stub(IWorkspaceContextService, { getWorkspace: () => ({ folders: [{ uri: URI.file('/work') }] }) } as unknown as IWorkspaceContextService);
		instantiation.stub(IWorkspaceTrustManagementService, store.add(new TestWorkspaceTrustManagementService(true)));
		const container = document.createElement('div');
		const line = store.add(instantiation.createInstance(ClaudeStatusLine, container, () => { }));
		const settle = () => timeout(400);

		await settle();
		const whileRunning = { hidden: line.element.hidden, runs: requests.length };
		status = 'completed';
		viewState.fire({ sessionId: 's1' });
		await settle();
		const shown = {
			hidden: line.element.hidden,
			parts: [...line.element.children].map(span => [span.textContent, span.className]),
			input: requests[0]?.input,
			trusted: requests[0]?.trusted,
		};
		viewState.fire({ sessionId: 's1' });
		await settle();
		const unchanged = requests.length;
		answer = { kind: 'none' };
		session.modelId = 'sonnet';
		viewState.fire({ sessionId: 's1' });
		await settle();
		assert.deepStrictEqual({ whileRunning, shown, unchanged, gone: line.element.hidden }, {
			whileRunning: { hidden: true, runs: 0 },
			shown: {
				hidden: false,
				parts: [['main', 'ansi-2'], [' Opus', '']],
				input: { hook_event_name: 'Status', session_id: 'cc-1', cwd: URI.file('/work').fsPath, model: { id: 'opus', display_name: 'Opus 5.5' }, workspace: { current_dir: URI.file('/work').fsPath, project_dir: URI.file('/work').fsPath }, version: '2.1.296', cost: { total_cost_usd: 0.75 } },
				trusted: true,
			},
			unchanged: 1,
			gone: true,
		});
	});

	test('leaves the cost out of what the command gets when the cost setting is off (issue 1584)', async () => {
		const requests: ClaudeStatusLineRequest[] = [];
		const instantiation = store.add(new TestInstantiationService());
		instantiation.stub(IClaudeRuntimeService, {
			getRuntimeState: async () => ({ version: '2.1.296' }),
			runStatusLine: async (request: ClaudeStatusLineRequest) => { requests.push(request); return { kind: 'line', text: 'main' } as ClaudeStatusLineResult; },
		} as unknown as IClaudeRuntimeService);
		instantiation.stub(IClaudeAgentService, {
			onDidChangeSession: store.add(new Emitter<void>()).event,
			onDidChangeViewState: store.add(new Emitter<{ readonly sessionId: string }>()).event,
			getCurrentSession: () => ({ id: 's1', claudeSessionId: 'cc-1', modelId: 'opus', modelName: 'Opus 5.5' }),
			getViewState: () => ({ turns: [{ id: 't1', status: 'completed' }], usage: { costUsd: 0.25 } }),
		} as unknown as IClaudeAgentService);
		instantiation.stub(IClaudeWorkerRegistry, { sessionTotals: () => ({ costUsd: 0.5, inputTokens: 0, outputTokens: 0, runs: 1 }) } as unknown as IClaudeWorkerRegistry);
		instantiation.stub(IConfigurationService, new TestConfigurationService({ [CLAUDE_STATUS_LINE_SHOW_COST_SETTING]: false }));
		instantiation.stub(IWorkspaceContextService, { getWorkspace: () => ({ folders: [{ uri: URI.file('/work') }] }) } as unknown as IWorkspaceContextService);
		instantiation.stub(IWorkspaceTrustManagementService, store.add(new TestWorkspaceTrustManagementService(true)));
		store.add(instantiation.createInstance(ClaudeStatusLine, document.createElement('div'), () => { }));
		await timeout(400);
		assert.deepStrictEqual({ runs: requests.length, hasCost: requests[0] && 'cost' in requests[0].input && requests[0].input.cost !== undefined }, { runs: 1, hasCost: false });
	});
});
