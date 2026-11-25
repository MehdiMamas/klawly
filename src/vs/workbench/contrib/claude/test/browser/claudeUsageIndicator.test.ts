/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Emitter } from '../../../../../base/common/event.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IClaudeRuntimeService, ClaudeRuntimeState } from '../../../../../platform/claude/common/claude.js';
import { ClaudeAccountOverview, ClaudeUsageRefresh } from '../../../../../platform/claude/common/claudeAccount.js';
import { NormalizedClaudeEvent } from '../../../../../platform/claude/common/claudeProtocol.js';
import { FAKE_CLAUDE_ACCOUNT_OVERVIEW } from '../../../../../platform/claude/common/fakeClaudeRuntimeService.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IHostService } from '../../../../services/host/browser/host.js';
import { ClaudeUsageIndicator } from '../../browser/chat/claudeUsageIndicator.js';
import { CLAUDE_OPEN_SETTINGS_COMMAND_ID } from '../../common/claudeViews.js';

suite('Claude usage indicator', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	async function setup(overview: ClaudeAccountOverview | undefined | ((refresh: ClaudeUsageRefresh | undefined) => ClaudeAccountOverview)) {
		const events = store.add(new Emitter<NormalizedClaudeEvent>());
		const focus = store.add(new Emitter<boolean>());
		const runtimeState = store.add(new Emitter<ClaudeRuntimeState>());
		const commands: unknown[][] = [];
		const runtime = {
			onDidEmitEvent: events.event,
			onDidChangeRuntimeState: runtimeState.event,
			getAccountOverview: overview ? async (refresh?: ClaudeUsageRefresh) => typeof overview === 'function' ? overview(refresh) : overview : undefined,
		} as Partial<IClaudeRuntimeService> as IClaudeRuntimeService;
		const host = { hasFocus: true, onDidChangeFocus: focus.event } as Partial<IHostService> as IHostService;
		const commandService = {
			executeCommand: async (id: string, ...args: unknown[]) => {
				commands.push([id, ...args]);
				return undefined;
			},
		} as Partial<ICommandService> as ICommandService;
		const container = document.createElement('div');
		let heightChanges = 0;
		const indicator = store.add(new ClaudeUsageIndicator(container, () => heightChanges++, runtime, commandService, host));
		await new Promise(resolve => setTimeout(resolve, 0));
		const state = () => ({
			hidden: indicator.element.hidden,
			parts: [...indicator.element.querySelectorAll('.part')].map(part => `${part.className} ${part.textContent}`),
		});
		return { events, focus, runtimeState, commands, indicator, state, heightChanges: () => heightChanges };
	}

	test('hidden with no overview and for sign-ins without plan limits', async () => {
		const unknown = await setup(undefined);
		const noLimits = await setup({ live: true, usage: undefined });
		const before = [unknown.state(), noLimits.state()];
		noLimits.events.fire({ type: 'session.usageLimits', sessionId: 's1', windows: [] });
		assert.deepStrictEqual([...before, noLimits.state()], [
			{ hidden: true, parts: [] },
			{ hidden: true, parts: [] },
			{ hidden: true, parts: [] },
		]);
	});

	test('shows the fake runtime overview, then each usage event, with warning and full states', async () => {
		const { events, state } = await setup(FAKE_CLAUDE_ACCOUNT_OVERVIEW);
		const fixture = state();
		events.fire({ type: 'session.usageLimits', sessionId: 's1', windows: [{ kind: 'session', percent: 85 }, { kind: 'week', percent: 100 }] });
		assert.deepStrictEqual({ fixture: fixture.parts.length, hidden: fixture.hidden, updated: state() }, {
			fixture: 2,
			hidden: false,
			updated: { hidden: false, parts: ['part is-high Session85%', 'part is-full Week100%'] },
		});
	});

	test('asks the host to lay out again when the row shows, changes or hides (issue 332)', async () => {
		const shown = await setup(FAKE_CLAUDE_ACCOUNT_OVERVIEW);
		const counts = [shown.heightChanges()];
		shown.events.fire({ type: 'session.usageLimits', sessionId: 's1', windows: [{ kind: 'session', percent: 85 }] });
		counts.push(shown.heightChanges());
		shown.events.fire({ type: 'session.usageLimits', sessionId: 's1', windows: [] });
		counts.push(shown.heightChanges());
		const neverShown = await setup({ live: true, usage: undefined });
		neverShown.events.fire({ type: 'session.usageLimits', sessionId: 's1', windows: [] });
		counts.push(neverShown.heightChanges());
		assert.deepStrictEqual(counts, [1, 2, 3, 0]);
	});

	test('asks again when the window gets focus back, and an answer older than a usage event does not replace it (issue 704)', async () => {
		const asked: (ClaudeUsageRefresh | undefined)[] = [];
		const answers = [10, 20, 30];
		const { events, focus, state } = await setup(refresh => {
			asked.push(refresh);
			const percent = answers[asked.length - 1];
			return { live: false, usage: [{ kind: 'session', percent }], usageCheckedAt: percent * 1000 };
		});
		const seen = [state().parts];
		focus.fire(true);
		await new Promise(resolve => setTimeout(resolve, 0));
		seen.push(state().parts);
		events.fire({ type: 'session.usageLimits', sessionId: 's1', windows: [{ kind: 'session', percent: 50 }] });
		focus.fire(false);
		focus.fire(true);
		await new Promise(resolve => setTimeout(resolve, 0));
		seen.push(state().parts);
		assert.deepStrictEqual({ asked, seen }, {
			asked: [undefined, 'stale', 'stale'],
			seen: [['part Session10%'], ['part Session20%'], ['part Session50%']],
		});
	});

	test('switching accounts clears the old limits and shows the new one, and drops a late answer for the old one (issue 942)', async () => {
		let account = 'old';
		const answers = new Map<string, () => ClaudeAccountOverview>([
			['old', () => ({ live: false, usage: [{ kind: 'session', percent: 90 }], usageCheckedAt: Date.now() })],
			['new', () => ({ live: false, usage: [{ kind: 'session', percent: 5 }], usageCheckedAt: Date.now() })],
		]);
		const asked: (ClaudeUsageRefresh | undefined)[] = [];
		const { runtimeState, state } = await setup(refresh => {
			asked.push(refresh);
			return answers.get(account)!();
		});
		const before = state();
		account = 'new';
		runtimeState.fire({ installed: true, authenticated: true });
		const cleared = state();
		await new Promise(resolve => setTimeout(resolve, 0));
		assert.deepStrictEqual({ before, cleared, after: state(), asked }, {
			before: { hidden: false, parts: ['part is-high Session90%'] },
			cleared: { hidden: true, parts: [] },
			after: { hidden: false, parts: ['part Session5%'] },
			asked: [undefined, 'now'],
		});
	});

	test('the row names the account its limits belong to, and drops the name on a switch (issue 1270)', async () => {
		const { runtimeState, indicator } = await setup({ live: false, account: { email: 'a@x.dev' }, usage: [{ kind: 'session', percent: 10 }], usageCheckedAt: Date.now() });
		const named = indicator.element.title;
		runtimeState.fire({ installed: true, authenticated: true });
		assert.deepStrictEqual({ named, cleared: indicator.element.title }, { named: 'Plan usage of a@x.dev', cleared: '' });
	});

	test('clicking opens Settings on Plan & Usage', async () => {
		const { events, commands, indicator } = await setup(undefined);
		events.fire({ type: 'session.usageLimits', sessionId: 's1', windows: [{ kind: 'session', percent: 10 }] });
		indicator.element.click();
		assert.deepStrictEqual(commands, [[CLAUDE_OPEN_SETTINGS_COMMAND_ID, 'plan']]);
	});
});
