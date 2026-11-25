/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Emitter } from '../../../../../base/common/event.js';
import { toDisposable } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IDelayedHoverOptions } from '../../../../../base/browser/ui/hover/hover.js';
import { IHoverService } from '../../../../../platform/hover/browser/hover.js';
import { NullHoverService } from '../../../../../platform/hover/test/browser/nullHoverService.js';
import { IClaudeAgentService } from '../../../../services/claude/common/claudeAgentService.js';
import { IClaudeMultitaskService, MultitaskGroup, MultitaskRun } from '../../../../services/claude/common/claudeMultitask.js';
import { ClaudeMultitaskCards } from '../../browser/chat/claudeMultitaskCards.js';

suite('Claude multitask cards (issue 686)', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('a read-only multitask says it runs in this folder, and one a reload interrupted waits for Send Results', () => {
		const readOnly: MultitaskGroup = {
			id: 'g1', sessionId: 's1', startedAt: 1, runs: [
				{ prompt: 'Explain the auth flow', status: 'running', readOnly: true, runSessionId: 'r1' },
				{ prompt: 'Find dead code', status: 'complete', readOnly: true, runSessionId: 'r2' },
			],
		};
		const reloaded: MultitaskGroup = {
			id: 'g2', sessionId: 's1', startedAt: 2, endedAt: 3, unsent: true, runs: [
				{ prompt: 'Fix the lint errors', status: 'complete' },
				{ prompt: 'Add tests', status: 'failed', error: 'Interrupted by a window reload.' },
			],
		};
		const changed = store.add(new Emitter<void>());
		const sessionChanged = store.add(new Emitter<void>());
		const calls: string[] = [];
		const multitask = {
			onDidChange: changed.event,
			getGroups: () => [readOnly, reloaded],
			getTask: () => undefined,
			canOpen: (run: MultitaskRun) => !!run.runSessionId,
			open: (run: MultitaskRun) => calls.push(`open ${run.prompt}`),
			sendResults: (groupId: string, sessionId: string) => calls.push(`send ${groupId} to ${sessionId}`),
			stop: async (groupId: string) => { calls.push(`stop ${groupId}`); },
			dismiss: (groupId: string) => calls.push(`dismiss ${groupId}`),
		} as unknown as IClaudeMultitaskService;
		const agent = {
			onDidChangeSession: sessionChanged.event,
			getCurrentSession: () => ({ id: 's1' }),
		} as unknown as IClaudeAgentService;
		const hovers = new Map<HTMLElement, () => IDelayedHoverOptions>();
		const hover = {
			...NullHoverService,
			setupDelayedHover: (target: HTMLElement, options: (() => IDelayedHoverOptions) | IDelayedHoverOptions) => {
				hovers.set(target, typeof options === 'function' ? options : () => options);
				return toDisposable(() => hovers.delete(target));
			},
		} as IHoverService;
		const host = document.createElement('div');
		const cards = store.add(new ClaudeMultitaskCards(host, () => undefined, multitask, agent, hover));

		const describe = () => [...host.querySelectorAll<HTMLElement>('.claude-multitask-group')].map(group => {
			const header = group.querySelector<HTMLElement>('.claude-multitask-header')!;
			return {
				icon: header.querySelector('.codicon')!.className.split(' ').find(name => name.startsWith('codicon-'))!,
				title: header.querySelector('.text')!.textContent,
				titleHover: hovers.get(header.querySelector<HTMLElement>('.text')!)?.().content,
				buttons: [...header.querySelectorAll<HTMLButtonElement>('button')].map(button => button.textContent || button.getAttribute('aria-label')),
				runs: [...group.querySelectorAll<HTMLButtonElement>('.claude-multitask-run')].map(row => `${row.querySelector('.text')!.textContent} | ${row.querySelector('.claude-multitask-badge')!.textContent}${row.disabled ? ' | disabled' : ''}`),
			};
		});
		const before = describe();
		const buttons = [...host.querySelectorAll<HTMLButtonElement>('button')];
		buttons.find(button => button.textContent === 'Send Results')!.click();
		buttons.find(button => button.getAttribute('aria-label') === 'Stop All')!.click();
		host.querySelector<HTMLButtonElement>('.claude-multitask-run')!.click();
		cards.dispose();

		assert.deepStrictEqual({ before, calls }, {
			before: [{
				icon: 'codicon-eye',
				title: '1 of 2 read-only tasks done in this folder',
				titleHover: '1 of 2 read-only tasks done in this folder\nThese tasks run in this chat\'s folder without worktrees: Ask and Plan do not change files.',
				buttons: ['Stop All'],
				runs: ['Explain the auth flow | running', 'Find dead code | done'],
			}, {
				icon: 'codicon-layers',
				title: '1 of 2 tasks done before the reload',
				titleHover: '1 of 2 tasks done before the reload',
				buttons: ['Send Results', 'Dismiss'],
				runs: ['Fix the lint errors | done | disabled', 'Add tests | failed | disabled'],
			}],
			calls: ['send g2 to s1', 'stop g1', 'open Explain the auth flow'],
		});
	});
});
