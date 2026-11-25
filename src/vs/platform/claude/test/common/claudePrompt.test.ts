/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { ContextAttachment } from '../../common/claudeContext.js';
import { formatLineAlignedDiff, resolveContextEnvelope, sliceRange } from '../../common/claudeContextResolve.js';
import { actionAvailable, actionNeedsEditorSelection, actionRequestText, actionTurnLabel, compilePrompt, compileSubmission, decidePaste, decideWorkspaceDrop, escapeAttr, formatSentPrompt, pinnedCommandResolution, rankContextCandidate, resolveAgentAction, selectionIsStale, sentImages, symbolChipRange } from '../../common/claudePrompt.js';

suite('Claude prompt compiler', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('compiles tagged blocks and escapes attachment metadata', () => {
		const prompt = compilePrompt({
			userText: 'Explain <script>',
			mode: 'agent',
			workspaceRoot: '/repo',
			activeFile: { relativePath: 'src/a.ts', cursorLine: 4, selection: 'const x = 1;' },
			attachments: [{
				kind: 'selection',
				path: 'src/a".ts',
				range: { startLine: 2, startColumn: 1, endLine: 2, endColumn: 8 },
				content: 'if (a < b) {',
				stale: true,
				truncated: false,
			}],
			diagnostics: [],
			instructionFiles: [],
		});

		assert.ok(prompt.includes('<ide_request mode="agent">'));
		assert.ok(prompt.includes('Explain &lt;script>'));
		assert.ok(prompt.includes('path="src/a&quot;.ts"'));
		assert.ok(prompt.includes('stale="true"'));
		assert.ok(prompt.includes('if (a &lt; b) {'));
		assert.ok(prompt.includes('<active_editor path="src/a.ts" cursor_line="4">'));
		assert.strictEqual(escapeAttr('a"b<c'), 'a&quot;b&lt;c');
	});

	test('a bare slash command is not wrapped', () => {
		const envelope = {
			userText: '/compact',
			mode: 'agent' as const,
			workspaceRoot: '/repo',
			attachments: [],
			diagnostics: [],
			instructionFiles: [],
		};
		assert.strictEqual(compileSubmission(envelope), '/compact');
	});

	test('a pinned command goes first on every message, unless the message is its own slash command (issue 488)', () => {
		const envelope = (userText: string) => ({ userText, mode: 'agent' as const, workspaceRoot: '/repo', attachments: [], diagnostics: [], instructionFiles: [] });
		const send = (text: string, pinned?: string) => compileSubmission(envelope(text), pinnedCommandResolution(pinned, text));
		assert.deepStrictEqual({
			pinned: send('look at the diff', 'review-pr').split('\n\n').slice(0, 2),
			ownCommand: send('/compact', 'review-pr'),
			indentedCommand: send('  /compact now', 'review-pr').startsWith('/review-pr'),
			none: send('look at the diff').startsWith('<ide_request'),
		}, {
			pinned: ['/review-pr', '<ide_request mode="agent">'],
			ownCommand: '/compact',
			indentedCommand: false,
			none: true,
		});
	});

	test('unsaved buffer text is what the selection chip compiles', async () => {
		const attachment: ContextAttachment = {
			kind: 'selection',
			uri: 'file:///repo/src/app.ts',
			range: { startLine: 2, startColumn: 1, endLine: 2, endColumn: 6 },
			versionId: 3,
		};
		const envelope = await resolveContextEnvelope('look', 'agent', [attachment], {
			relativePath: () => 'src/app.ts',
			readText: async () => ({ content: 'one\ntwo\nthree', languageId: 'typescript', versionId: 4, unsaved: true }),
			readMarkers: async () => [],
			readGit: async () => ({ stat: '', patch: '', truncated: false }),
			readTerminal: async () => undefined,
			activeEditor: () => undefined,
			workspaceRoot: () => '/repo',
		});
		const selection = envelope.attachments[0];
		assert.strictEqual(selection.kind, 'selection');
		if (selection.kind === 'selection') {
			assert.strictEqual(selection.content, 'two');
			assert.strictEqual(selection.stale, true);
		}
		const prompt = compilePrompt(envelope);
		assert.ok(prompt.includes('\ntwo\n'));
		assert.ok(prompt.includes('stale="true"'));
		assert.ok(prompt.includes('kind="selection"'));
		assert.strictEqual(sliceRange('one\ntwo\nthree', { startLine: 1, startColumn: 1, endLine: 1, endColumn: 2 }), 'o');
	});

	test('explain prefers a loaded skill, then the template', () => {
		const skill = resolveAgentAction('explainSelection', { slashCommands: [], skills: ['explain'], preferClaudeCommands: true });
		assert.deepStrictEqual(skill, { kind: 'skill', skill: 'explain' });
		assert.strictEqual(actionTurnLabel('explainSelection', skill), 'Explain selection · via /explain');

		const template = resolveAgentAction('explainSelection', { slashCommands: [], skills: [], preferClaudeCommands: true });
		assert.deepStrictEqual(template, { kind: 'prompt', templateId: 'explain-selection' });
		assert.strictEqual(actionTurnLabel('explainSelection', template), 'Explain selection · via template');

		const forced = resolveAgentAction('explainSelection', { slashCommands: [], skills: ['explain'], preferClaudeCommands: false });
		assert.strictEqual(forced.kind, 'prompt');
	});

	test('review prefers the slash command reported by session init', () => {
		const resolved = resolveAgentAction('reviewChanges', { slashCommands: ['review'], skills: ['code-review'], preferClaudeCommands: true });
		assert.deepStrictEqual(resolved, { kind: 'claude-command', command: 'review' });
	});

	test('security review runs /security-review when the session has it, and needs no editor selection', () => {
		assert.deepStrictEqual([
			resolveAgentAction('securityReviewChanges', { slashCommands: ['review', 'security-review'], skills: [], preferClaudeCommands: true }),
			resolveAgentAction('securityReviewChanges', { slashCommands: [], skills: [], preferClaudeCommands: true }),
			actionAvailable('securityReviewChanges'),
			actionNeedsEditorSelection('securityReviewChanges'),
		], [
			{ kind: 'claude-command', command: 'security-review' },
			{ kind: 'prompt', templateId: 'security-review-changes' },
			true,
			false,
		]);
	});

	test('split into pull requests runs /split-to-prs when the session has it, else a template that confirms before it acts and before it pushes (issue 504)', () => {
		const template = resolveAgentAction('splitPullRequests', { slashCommands: [], skills: [], preferClaudeCommands: true });
		const text = actionRequestText('splitPullRequests', template);
		assert.deepStrictEqual([
			resolveAgentAction('splitPullRequests', { slashCommands: ['split-to-prs'], skills: [], preferClaudeCommands: true }),
			resolveAgentAction('splitPullRequests', { slashCommands: [], skills: ['split-prs'], preferClaudeCommands: true }),
			template,
			actionTurnLabel('splitPullRequests', template),
			actionAvailable('splitPullRequests'),
			actionNeedsEditorSelection('splitPullRequests'),
			/without changing anything/.test(text),
			/ask me with a question to confirm the groups/i.test(text),
			/Never switch branches, reset, stash or commit in the current checkout/.test(text),
			/Ask me again before you push/.test(text),
			/gh pr create --draft/.test(text),
		], [
			{ kind: 'claude-command', command: 'split-to-prs' },
			{ kind: 'skill', skill: 'split-prs' },
			{ kind: 'prompt', templateId: 'split-pull-requests' },
			'Split into pull requests · via template',
			true,
			false,
			true,
			true,
			true,
			true,
			true,
		]);
	});

	test('a single-line range slices the columns, and a multi-line range keeps the middle lines', () => {
		assert.strictEqual(sliceRange('abcdefghij', { startLine: 1, startColumn: 5, endLine: 1, endColumn: 10 }), 'efghi');
		assert.strictEqual(sliceRange('aaaa\nbbbb\ncccc', { startLine: 1, startColumn: 3, endLine: 3, endColumn: 3 }), 'aa\nbbbb\ncc');
	});

	test('a symbol chip resolves the full symbol body, not the name range', async () => {
		const name = { startLine: 1, startColumn: 10, endLine: 1, endColumn: 13 };
		const body = { startLine: 1, startColumn: 1, endLine: 3, endColumn: 2 };
		assert.deepStrictEqual(symbolChipRange({ range: body, selectionRange: name }), body);
		const source = 'function foo() {\n  return 1;\n}\n';
		const envelope = await resolveContextEnvelope('look', 'agent', [{
			kind: 'symbol',
			uri: 'file:///repo/src/app.ts',
			name: 'foo',
			range: symbolChipRange({ range: body, selectionRange: name }),
		}], {
			relativePath: () => 'src/app.ts',
			readText: async () => ({ content: source, languageId: 'typescript', versionId: 1, unsaved: false }),
			readMarkers: async () => [],
			readGit: async () => ({ stat: '', patch: '', truncated: false }),
			readTerminal: async () => undefined,
			activeEditor: () => undefined,
			workspaceRoot: () => '/repo',
		});
		const symbol = envelope.attachments[0];
		assert.strictEqual(symbol.kind, 'symbol');
		if (symbol.kind === 'symbol') {
			assert.ok(symbol.content.includes('return 1;'));
			assert.strictEqual(symbol.content.includes('function foo() {'), true);
		}
	});

	test('an image attachment reaches Claude as a file path, and the turn keeps its name (issues 743, 744)', async () => {
		const attachments: ContextAttachment[] = [
			{ kind: 'image', localUri: 'file:///repo/shots/cart.png', name: 'Pasted image' },
			{ kind: 'file', uri: 'file:///repo/src/app.ts' },
			{ kind: 'image', localUri: 'file:///repo/shots/menu.png' },
		];
		const envelope = await resolveContextEnvelope('look', 'agent', attachments.filter(attachment => attachment.kind === 'image'), {
			relativePath: () => '',
			readText: async () => undefined,
			readMarkers: async () => [],
			readGit: async () => ({ stat: '', patch: '', truncated: false }),
			readTerminal: async () => undefined,
			activeEditor: () => undefined,
			workspaceRoot: () => '/repo',
		});
		assert.deepStrictEqual({
			paths: envelope.attachments.map(attachment => attachment.kind === 'image' ? attachment.path : attachment.kind),
			sent: sentImages(attachments),
			none: sentImages([{ kind: 'file', uri: 'file:///repo/src/app.ts' }]),
		}, {
			paths: [URI.parse('file:///repo/shots/cart.png').fsPath, URI.parse('file:///repo/shots/menu.png').fsPath],
			sent: [{ uri: 'file:///repo/shots/cart.png', name: 'Pasted image' }, { uri: 'file:///repo/shots/menu.png' }],
			none: undefined,
		});
	});

	test('an identical selection is not repeated in the active editor block', () => {
		const prompt = compilePrompt({
			userText: 'Explain',
			mode: 'agent',
			workspaceRoot: '/repo',
			activeFile: { relativePath: 'src/a.ts', cursorLine: 1, selection: 'const x = 1;' },
			attachments: [{
				kind: 'selection',
				path: 'src/a.ts',
				range: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 13 },
				content: 'const x = 1;',
				stale: false,
				truncated: false,
			}],
			diagnostics: [],
			instructionFiles: [],
		});
		assert.strictEqual(prompt.split('const x = 1;').length - 1, 1);
	});

	test('paste, drop, and stale-selection decisions', () => {
		assert.strictEqual(decidePaste({ plain: false, hasImage: true, text: '', copied: false, longPasteCharacters: 1500 }), 'image');
		assert.strictEqual(decidePaste({ plain: true, hasImage: true, text: 'hello', copied: true, longPasteCharacters: 1500 }), 'plain');
		assert.strictEqual(decidePaste({ plain: false, hasImage: false, text: 'hello', copied: true, longPasteCharacters: 1500 }), 'selection-chip');
		assert.strictEqual(decidePaste({ plain: false, hasImage: false, text: 'x'.repeat(1500), copied: false, longPasteCharacters: 1500 }), 'paste-pill');
		assert.strictEqual(decidePaste({ plain: false, hasImage: false, text: 'a\nb\nc\nd\ne\n', copied: false, longPasteCharacters: 1500 }), 'paste-pill');
		assert.strictEqual(decidePaste({ plain: false, hasImage: false, text: 'a\nb\nc\nd\n\n', copied: false, longPasteCharacters: 1500 }), 'insert');
		assert.strictEqual(decidePaste({ plain: true, hasImage: false, text: 'a\nb\nc\nd\ne', copied: false, longPasteCharacters: 1500 }), 'plain');
		assert.strictEqual(decidePaste({ plain: false, hasImage: false, text: 'short', copied: false, longPasteCharacters: 1500 }), 'insert');
		assert.strictEqual(decideWorkspaceDrop(false, false, false), 'ask');
		assert.strictEqual(decideWorkspaceDrop(true, true, false), 'image');
		assert.strictEqual(decideWorkspaceDrop(true, false, true), 'folder');
		assert.strictEqual(decideWorkspaceDrop(true, false, false), 'file');
		assert.strictEqual(selectionIsStale(1, undefined), false);
		assert.strictEqual(selectionIsStale(1, 1), false);
		assert.strictEqual(selectionIsStale(1, 2), true);
	});

	test('a diagnostics snapshot, a git changes chip, and a terminal chip compile together', async () => {
		const envelope = await resolveContextEnvelope('look', 'agent', [
			{
				kind: 'diagnostics',
				items: [{ severity: 'error', message: 'unused', path: 'src/a.ts', line: 2, column: 1 }],
			},
			{ kind: 'git-diff', scope: 'all', path: 'src/a.ts' },
			{ kind: 'terminal', terminalId: 1, lines: 3, text: 'exit 1', title: 'Task' },
		], {
			relativePath: () => 'src/a.ts',
			readText: async () => undefined,
			readMarkers: async () => { throw new Error('snapshot items must not be reread'); },
			readGit: async (scope, path) => ({ stat: `${scope} ${path ?? ''}`, patch: 'diff', truncated: false }),
			readTerminal: async () => { throw new Error('terminal text must not be reread'); },
			activeEditor: () => undefined,
			workspaceRoot: () => '/repo',
		});
		const prompt = compilePrompt(envelope);
		assert.ok(prompt.includes('unused'));
		assert.ok(prompt.includes('scope="all"'));
		assert.ok(prompt.includes('src/a.ts'));
		assert.ok(prompt.includes('title="Task"'));
		assert.ok(prompt.includes('exit 1'));
		assert.strictEqual(actionNeedsEditorSelection('fixProblems'), false);
		assert.strictEqual(actionNeedsEditorSelection('reviewChanges'), false);
	});

	test('a later action is not available, and the sent prompt omits allowed tools', () => {
		assert.strictEqual(actionAvailable('addSelection'), true);
		assert.strictEqual(actionAvailable('explainSelection'), true);
		assert.strictEqual(actionAvailable('reviewChanges'), true);
		assert.strictEqual(actionAvailable('generateCommitMessage'), true);
		assert.strictEqual(actionAvailable('explainDiff'), true);
		assert.strictEqual(actionAvailable('reviewTurnChanges'), true);
		assert.strictEqual(actionAvailable('fixPreviewElement'), true);
		assert.strictEqual(actionAvailable('fixProblems'), true);
		assert.strictEqual(actionAvailable('fixTerminalError'), true);
		assert.strictEqual(actionNeedsEditorSelection('fixProblems'), false);
		assert.strictEqual(actionNeedsEditorSelection('fixTerminalError'), false);
		const shown = formatSentPrompt({
			compiled: 'token sk-ant-secret',
			mode: 'agent',
			modelId: 'fixture-sonnet',
			additionalDirectories: ['D:\\outside'],
			resolution: { kind: 'claude-command', command: 'explain' },
		});
		assert.ok(shown.includes('action: claude-command explain'));
		assert.ok(shown.includes('sk-ant-secret'));
		assert.ok(!shown.includes('allowed tools'));
		assert.ok(formatLineAlignedDiff('a.ts', 'one\ntwo', 'one\ninserted\ntwo').startsWith('line-aligned comparison, not a unified diff'));
		assert.deepStrictEqual(resolveAgentAction('generateCommitMessage', {
			slashCommands: [],
			skills: ['commit'],
			preferClaudeCommands: true,
		}), { kind: 'prompt', templateId: 'generate-commit-message' });
		const explained = actionRequestText('explainCommit', { kind: 'prompt', templateId: 'explain-commit' }, {
			sha: 'abc1234def',
			subject: 'Add git',
			message: 'Add git',
		});
		assert.ok(explained.includes('git show --stat --patch abc1234def'));
		assert.ok(explained.includes('Do not edit files'));
	});

	test('picker ranking prefers a prefix over a later substring', () => {
		assert.ok(rankContextCandidate('mid', 'middleware.ts') > rankContextCandidate('mid', 'src/midpoint.ts'));
		assert.strictEqual(rankContextCandidate('zzz', 'middleware.ts'), 0);
		assert.ok(rankContextCandidate('', 'any') > 0);
	});
});
