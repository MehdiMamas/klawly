/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { countConflictMarkers, MERGE_CONFLICT_FILE_LIMIT, mergeConflictChunks } from '../../common/claudeMergeConflicts.js';
import { actionAvailable, actionNeedsEditorSelection, actionRequestText, actionTurnLabel, CLAUDE_ATTACHMENT_CHAR_LIMIT, compileSubmission, resolveAgentAction } from '../../common/claudePrompt.js';

const CONFLICTED = [
	'export const total = 1;',
	'<<<<<<< HEAD',
	'export const tax = 0.2;',
	'=======',
	'export const tax = 0.25;',
	'>>>>>>> feature',
	'<<<<<<< HEAD',
	'export const currency = "EUR";',
	'||||||| base',
	'export const currency = "USD";',
	'=======',
	'export const currency = "GBP";',
	'>>>>>>> feature',
].join('\n');

suite('Claude merge conflicts', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('counts conflict markers at the start of a line only', () => {
		assert.deepStrictEqual([
			countConflictMarkers(CONFLICTED),
			countConflictMarkers('<<<<<<<\nours\n=======\ntheirs\n>>>>>>>'),
			countConflictMarkers('const shift = a <<<<<<< b;\n<<<<<<<< eight'),
			countConflictMarkers(undefined),
		], [2, 1, 0, 0]);
	});

	test('one summary attachment, then one per file with the merge base and both sides', () => {
		const chunks = mergeConflictChunks({
			ours: { ref: 'HEAD', branch: 'main', commits: [{ id: '0123456789abcdef', subject: 'Raise the tax rate' }] },
			theirs: { ref: 'MERGE_HEAD', commits: [] },
			files: [
				{ path: 'src/prices.ts', working: CONFLICTED, base: 'export const tax = 0.2;\n', ours: 'export const tax = 0.2;\n', theirs: 'export const tax = 0.25;\n' },
				{ path: 'src/removed.ts', working: 'kept\n', base: 'old\n', ours: 'kept\n' },
			],
		});
		assert.deepStrictEqual(chunks, [{
			id: 'merge-conflicts',
			text: [
				'Merge conflicts',
				'',
				'Ours (stage 2): main (HEAD)',
				'  01234567 Raise the tax rate',
				'Theirs (stage 3): MERGE_HEAD',
				'  (no commits found)',
				'',
				'Conflicted files:',
				'- src/prices.ts (2 conflicts)',
				'- src/removed.ts (no conflict markers)',
			].join('\n'),
		}, {
			id: 'merge-conflict:src/prices.ts',
			text: [
				'File: src/prices.ts (2 conflicts)',
				'',
				'--- Merge base (stage 1)',
				'export const tax = 0.2;\n',
				'',
				'--- Ours (stage 2)',
				'export const tax = 0.2;\n',
				'',
				'--- Theirs (stage 3)',
				'export const tax = 0.25;\n',
			].join('\n'),
		}, {
			id: 'merge-conflict:src/removed.ts',
			text: [
				'File: src/removed.ts (no conflict markers)',
				'',
				'--- Merge base (stage 1)',
				'old\n',
				'',
				'--- Ours (stage 2)',
				'kept\n',
				'',
				'--- Theirs (stage 3): the file does not exist on this side',
			].join('\n'),
		}]);
	});

	test('long sides are clipped under the attachment limit and name the git command for the rest', () => {
		const long = 'x'.repeat(CLAUDE_ATTACHMENT_CHAR_LIMIT);
		const files = Array.from({ length: MERGE_CONFLICT_FILE_LIMIT + 2 }, (_, index) => ({ path: `f${index}.ts`, base: long, ours: long, theirs: long }));
		const chunks = mergeConflictChunks({ ours: { ref: 'HEAD', commits: [] }, theirs: { ref: 'MERGE_HEAD', commits: [] }, files });
		assert.deepStrictEqual({
			count: chunks.length,
			fits: chunks.every(chunk => chunk.text.length <= CLAUDE_ATTACHMENT_CHAR_LIMIT),
			more: chunks[0].text.endsWith('- … and 2 more'),
			command: chunks[1].text.includes('run `git show :3:f0.ts` for all of it'),
		}, { count: MERGE_CONFLICT_FILE_LIMIT + 1, fits: true, more: true, command: true });
	});

	test('Resolve conflicts prefers the user\'s /resolve command or skill, else the template', () => {
		const command = resolveAgentAction('resolveConflicts', { slashCommands: ['resolve'], skills: ['resolve'], preferClaudeCommands: true });
		const skill = resolveAgentAction('resolveConflicts', { slashCommands: [], skills: ['merge-conflicts'], preferClaudeCommands: true });
		const template = resolveAgentAction('resolveConflicts', { slashCommands: ['resolve'], skills: [], preferClaudeCommands: false });
		const text = actionRequestText('resolveConflicts', template);
		assert.deepStrictEqual({
			command,
			skill,
			template,
			label: actionTurnLabel('resolveConflicts', command),
			available: actionAvailable('resolveConflicts'),
			needsSelection: actionNeedsEditorSelection('resolveConflicts'),
			noStaging: text.includes('Do not stage, commit, continue or abort the merge'),
			compiled: compileSubmission({ userText: '/resolve', mode: 'agent', workspaceRoot: '/repo', attachments: [{ kind: 'pasted-text', text: 'Merge conflicts', lineCount: 1, truncated: false }], diagnostics: [], instructionFiles: [] }, command).startsWith('/resolve\n\n'),
		}, {
			command: { kind: 'claude-command', command: 'resolve' },
			skill: { kind: 'skill', skill: 'merge-conflicts' },
			template: { kind: 'prompt', templateId: 'resolve-conflicts' },
			label: 'Resolve conflicts · via /resolve',
			available: true,
			needsSelection: false,
			noStaging: true,
			compiled: true,
		});
	});
});
