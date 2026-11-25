/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ClaudeAutomationEntry, ClaudeAutomationTrigger } from '../../../../../platform/claude/common/claudeAutomation.js';
import { ClaudeGitHubApiResponse, IClaudeGitHubApiService } from '../../../../../platform/claude/common/claudeAutomationGitHub.js';
import { ClaudeAutomationGitHubPoller } from '../../common/claudeAutomationGitHubPoller.js';

function automation(trigger: ClaudeAutomationTrigger, enabled = true): ClaudeAutomationEntry {
	return { id: 'push', name: 'Push', prompt: 'Check the push.', trigger, permissionMode: 'ask', target: 'worktree', budgetUsd: 1, allowedTools: [], enabled, scope: 'user', key: 'user:push' };
}

/** Answers each call with the next response and records the call. */
class FakeGitHub implements IClaudeGitHubApiService {
	declare readonly _serviceBrand: undefined;
	readonly calls: string[] = [];
	constructor(private readonly _answers: ClaudeGitHubApiResponse[]) { }
	async get(endpoint: string, etag?: string): Promise<ClaudeGitHubApiResponse> {
		this.calls.push(`${endpoint}${etag ? ` if ${etag}` : ''}`);
		return this._answers.shift() ?? { status: 304 };
	}
}

suite('Claude automation GitHub poller (issue 518)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('reuses the ETag, keeps events until a run takes them, and starts over when the trigger changes', async () => {
		const gitHub = new FakeGitHub([
			{ status: 200, etag: 'e1', body: { commit: { sha: 'a' } } },
			{ status: 304 },
			{ status: 200, etag: 'e2', body: { commit: { sha: 'b' } } },
			{ status: 200, etag: 'e3', body: { commit: { sha: 'c' } } },
			{ status: 0, error: 'gh: not signed in' },
			{ status: 200, etag: 'e4', body: { commit: { sha: 'd' } } },
		]);
		const poller = new ClaudeAutomationGitHubPoller(gitHub, () => 0);
		const main = automation({ type: 'githubPush', repo: 'octo-org/app', branch: 'main' });
		const pending = async (automations: ClaudeAutomationEntry[]) => (await poller.poll(automations)).map(result => [result.pending.map(event => event.kind === 'push' ? event.sha : event.kind), result.error]);
		const baseline = await pending([main]);
		const unchanged = await pending([main]);
		const first = await pending([main]);
		// The automation was busy: the event waits, and the next one joins it.
		const second = await pending([main]);
		poller.consume('user:push', 2);
		const failed = await pending([main]);
		const moved = await pending([automation({ type: 'githubPush', repo: 'octo-org/app', branch: 'release' })]);
		const disabled = await pending([automation(main.trigger, false)]);
		assert.deepStrictEqual({ baseline, unchanged, first, second, failed, disabled, moved, calls: gitHub.calls }, {
			baseline: [[[], undefined]],
			unchanged: [[[], undefined]],
			first: [[['b'], undefined]],
			second: [[['b', 'c'], undefined]],
			failed: [[[], 'gh: not signed in']],
			disabled: [],
			moved: [[[], undefined]],
			calls: [
				'repos/octo-org/app/branches/main',
				'repos/octo-org/app/branches/main if e1',
				'repos/octo-org/app/branches/main if e1',
				'repos/octo-org/app/branches/main if e2',
				'repos/octo-org/app/branches/main if e3',
				'repos/octo-org/app/branches/release',
			],
		});
	});
});
