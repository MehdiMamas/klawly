/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { NormalizedClaudeEvent } from '../../common/claudeProtocol.js';
import { createsGitHubReference, findGitHubReferences } from '../../node/claudeGitHubReferences.js';
import { createClaudeNormalizerState, normalizeClaudeMessage } from '../../node/claudeStreamNormalizer.js';

suite('Claude GitHub references', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('pull request and issue URLs in text, once each, with their tails dropped', () => {
		const text = [
			'Opened https://github.com/MehdiMamas/klawly-ide/pull/431 for review.',
			'It fixes https://github.com/MehdiMamas/klawly-ide/issues/430#issuecomment-12 and',
			'see the files at https://github.com/MehdiMamas/klawly-ide/pull/431/files.',
			'Upstream: (http://www.github.com/microsoft/vscode.git/issues/7).',
		].join('\n');

		assert.deepStrictEqual(findGitHubReferences(text, false), [
			{ url: 'https://github.com/MehdiMamas/klawly-ide/pull/431', owner: 'MehdiMamas', repo: 'klawly-ide', number: 431, kind: 'pullRequest', createdBySession: false },
			{ url: 'https://github.com/MehdiMamas/klawly-ide/issues/430', owner: 'MehdiMamas', repo: 'klawly-ide', number: 430, kind: 'issue', createdBySession: false },
			{ url: 'https://github.com/microsoft/vscode/issues/7', owner: 'microsoft', repo: 'vscode', number: 7, kind: 'issue', createdBySession: false },
		]);
	});

	test('no false positives on other hosts or other GitHub pages', () => {
		const text = [
			'https://gitlab.com/owner/repo/pull/1',
			'https://github.com.evil.example/owner/repo/pull/2',
			'https://gist.github.com/owner/abc123',
			'https://notgithub.com/owner/repo/issues/3',
			'https://github.com/owner/repo/pull/new/feature-branch',
			'https://github.com/owner/repo/pulls',
			'https://github.com/owner/repo/issues',
			'https://github.com/owner/repo/commit/4a5b6c',
			'https://github.com/owner/repo/blob/main/src/pull/5',
			'https://github.com/owner/repo/pull/0',
			'https://github.com/owner/repo/pull/12abc',
			'https://github.com/-owner/repo/pull/6',
			'https://github.com/owner/repo/actions/runs/7',
			'github.com/owner/repo/pull/8 without a scheme',
		].join('\n');

		assert.deepStrictEqual(findGitHubReferences(text, false), []);
	});

	test('only gh pr create, gh issue create and GitHub MCP create tools create references', () => {
		assert.deepStrictEqual([
			createsGitHubReference('Bash', { command: 'gh pr create --draft --fill' }),
			createsGitHubReference('Bash', { command: 'git push -u origin feat && gh pr create --title x' }),
			createsGitHubReference('Bash', { command: 'gh issue create --title "Bug"' }),
			createsGitHubReference('mcp__github__create_pull_request', {}),
			createsGitHubReference('Bash', { command: 'gh pr view 12' }),
			createsGitHubReference('Bash', { command: 'echo "gh pr create" > notes.txt' }),
			createsGitHubReference('Bash', { command: 'sigh pr create' }),
			createsGitHubReference('Read', { command: 'gh pr create' }),
			createsGitHubReference('mcp__github__get_pull_request', {}),
		], [true, true, true, true, false, false, false, false, false]);
	});

	test('the stream normalizer sends references from assistant text and from gh pr create output', () => {
		const state = createClaudeNormalizerState();
		const messages: unknown[] = [
			{ type: 'assistant', message: { id: 'm1', content: [{ type: 'tool_use', id: 'push', name: 'Bash', input: { command: 'git push -u origin feat' } }] } },
			{ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'push', content: 'remote: Create a pull request for \'feat\' on GitHub by visiting:\nremote:      https://github.com/o/r/pull/new/feat' }] } },
			{ type: 'assistant', message: { id: 'm2', content: [{ type: 'tool_use', id: 'create', name: 'Bash', input: { command: 'gh pr create --fill' } }] } },
			{ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'create', content: 'https://github.com/o/r/pull/12\n' }] } },
			{ type: 'assistant', message: { id: 'm3', content: [{ type: 'tool_use', id: 'read', name: 'Read', input: { file_path: 'CHANGELOG.md' } }] } },
			{ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'read', content: 'Fixed https://github.com/o/r/issues/1' }] } },
			{ type: 'assistant', message: { id: 'm4', content: [{ type: 'text', text: 'Opened https://github.com/o/r/pull/12, which fixes https://github.com/o/r/issues/9.' }] } },
		];
		const references = messages
			.flatMap(message => normalizeClaudeMessage(message, 'session-1', state).events)
			.flatMap((event: NormalizedClaudeEvent) => event.type === 'github.referenceDetected' ? [`${event.reference.kind} ${event.reference.number} ${event.reference.createdBySession}`] : []);

		assert.deepStrictEqual(references, ['pullRequest 12 true', 'issue 9 false']);
	});

	test('a URL seen first in text is sent again once this session creates it', () => {
		const state = createClaudeNormalizerState();
		const messages: unknown[] = [
			{ type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'Next I will open https://github.com/o/r/pull/3.' }] } },
			{ type: 'assistant', message: { id: 'm2', content: [{ type: 'tool_use', id: 'create', name: 'Bash', input: { command: 'gh pr create --fill' } }] } },
			{ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'create', content: 'https://github.com/o/r/pull/3' }] } },
			{ type: 'assistant', message: { id: 'm3', content: [{ type: 'text', text: 'Done: https://github.com/o/r/pull/3' }] } },
		];
		const references = messages
			.flatMap(message => normalizeClaudeMessage(message, 'session-1', state).events)
			.flatMap((event: NormalizedClaudeEvent) => event.type === 'github.referenceDetected' ? [event.reference.createdBySession] : []);

		assert.deepStrictEqual(references, [false, true]);
	});
});
