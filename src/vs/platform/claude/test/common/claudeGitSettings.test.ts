/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { backgroundBranchName } from '../../common/claudeBackground.js';
import { CLAUDE_GIT_COMMIT_ATTRIBUTION_SETTING, CLAUDE_GIT_INSTRUCTIONS_SETTING, CLAUDE_GIT_PR_ATTRIBUTION_SETTING, CLAUDE_GIT_WORKTREE_BASE_SETTING, claudeGitFlagSettings, DEFAULT_CLAUDE_GIT_SETTINGS, readClaudeBranchPrefix, readClaudeGitSettings } from '../../common/claudeGitSettings.js';

suite('Claude git settings', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('settings read with defaults, and only a change from a default reaches Claude Code', () => {
		const values: Record<string, unknown> = {
			[CLAUDE_GIT_COMMIT_ATTRIBUTION_SETTING]: false,
			[CLAUDE_GIT_PR_ATTRIBUTION_SETTING]: 'no',
			[CLAUDE_GIT_INSTRUCTIONS_SETTING]: false,
			[CLAUDE_GIT_WORKTREE_BASE_SETTING]: 'head',
		};
		const changed = readClaudeGitSettings(key => values[key]);
		assert.deepStrictEqual({
			unset: readClaudeGitSettings(() => undefined),
			changed,
			flags: [
				claudeGitFlagSettings(undefined),
				claudeGitFlagSettings(DEFAULT_CLAUDE_GIT_SETTINGS),
				claudeGitFlagSettings(changed),
				claudeGitFlagSettings({ ...DEFAULT_CLAUDE_GIT_SETTINGS, prAttribution: false }),
			],
		}, {
			unset: DEFAULT_CLAUDE_GIT_SETTINGS,
			changed: { commitAttribution: false, prAttribution: true, workflowInstructions: false, worktreeBase: 'head' },
			flags: [
				undefined,
				undefined,
				{ attribution: { commit: '' }, includeGitInstructions: false, worktree: { baseRef: 'head' } },
				{ attribution: { pr: '' } },
			],
		});
	});

	test('a branch prefix git would refuse, or that reads as an option, falls back to agent/', () => {
		const prefixes = ['agent/', 'alex', 'feat-', 'team/bots_', '  ai/ ', '', '-x/', '/x', 'a..b/', 'a b/', 'x.lock/', 'a//b', 'ref^', 'x.', 42, undefined];
		assert.deepStrictEqual(prefixes.map(prefix => backgroundBranchName('id', readClaudeBranchPrefix(prefix))), [
			'agent/id', 'alex/id', 'feat-id', 'team/bots_id', 'ai/id', 'agent/id', 'agent/id', 'agent/id', 'agent/id', 'agent/id', 'agent/id', 'agent/id', 'agent/id', 'agent/id', 'agent/id', 'agent/id',
		]);
	});
});
