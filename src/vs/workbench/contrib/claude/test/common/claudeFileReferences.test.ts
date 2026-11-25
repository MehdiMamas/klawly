/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { findFileReferences, parseWorkspacePath, sessionWorkFolders } from '../../common/claudeFileReferences.js';

suite('Claude file references', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('finds a relative path with a line and an optional column', () => {
		const matches = findFileReferences('See src/app.ts:12 and src/app.ts:12:4.');
		assert.deepStrictEqual(matches.map(match => ({ path: match.path, line: match.line, column: match.column })), [
			{ path: 'src/app.ts', line: 12, column: undefined },
			{ path: 'src/app.ts', line: 12, column: 4 },
		]);
	});

	test('skips absolute paths, drive letters, and parent segments', () => {
		const text = [
			'/etc/passwd:1',
			'C:/secret.ts:2',
			'../secret.ts:3',
			'./src/app.ts:4',
			'http://example.com:80',
			'src/app.ts:0',
			'not-a-path:12',
		].join(' ');
		assert.deepStrictEqual(findFileReferences(text), []);
	});

	test('URI schemes, traversal inside a path, UNC and home paths never become links', () => {
		const text = [
			'src/../../etc/passwd.ts:1',
			'src/./app.ts:2',
			'command:workbench.action.files.save:3',
			'javascript:alert.js:4',
			'file:///etc/passwd.ts:5',
			'vscode://file/c/x.ts:6',
			'\\\\server\\share\\x.ts:7',
			'~/secrets.ts:8',
			'src\\app.ts:9',
		].join(' ');
		assert.deepStrictEqual(findFileReferences(text).map(match => match.path), []);
	});

	test('a code span or link target names a file, a folder or a line', () => {
		const inputs = ['src/words.js', './SPEC.md', 'src/', 'src/a.ts:12:4', 'src/a.ts#L7-L9', 'src/a.ts:3-8', '.gitignore', 'C:\\work\\app\\src\\a.ts:2', '/home/me/app/src/a.ts', '~/.klawly/plans/fix-a1b2.plan.md:4'];
		assert.deepStrictEqual(inputs.map(input => parseWorkspacePath(input)), [
			{ path: 'src/words.js', absolute: false, folder: false, line: undefined, column: undefined },
			{ path: 'SPEC.md', absolute: false, folder: false, line: undefined, column: undefined },
			{ path: 'src', absolute: false, folder: true, line: undefined, column: undefined },
			{ path: 'src/a.ts', absolute: false, folder: false, line: 12, column: 4 },
			{ path: 'src/a.ts', absolute: false, folder: false, line: 7, column: undefined },
			{ path: 'src/a.ts', absolute: false, folder: false, line: 3, column: undefined },
			{ path: '.gitignore', absolute: false, folder: false, line: undefined, column: undefined },
			{ path: 'C:\\work\\app\\src\\a.ts', absolute: true, folder: false, line: 2, column: undefined },
			{ path: '/home/me/app/src/a.ts', absolute: true, folder: false, line: undefined, column: undefined },
			{ path: '.klawly/plans/fix-a1b2.plan.md', absolute: false, home: true, folder: false, line: 4, column: undefined },
		]);
	});

	test('words, commands, URLs, other users\' homes and traversal are not paths', () => {
		const inputs = ['npm', 'npm install', '/review', 'v1.2.3', 'https://example.com/a.ts', 'command:x.ts', 'javascript:alert.js', 'file:///etc/passwd', '~root/.ssh/id_rsa', '~', '~/../secret.ts', '../secret.ts', 'src/../../etc/passwd', 'src/a.ts:0', '', '`a.ts`'];
		assert.deepStrictEqual(inputs.map(input => parseWorkspacePath(input)), inputs.map(() => undefined));
	});

	test('session work folders: changed before read, newest first, absolute paths and file URIs only', () => {
		const folders = sessionWorkFolders([
			{ changedFiles: [], cards: [{ kind: 'file', file: '/repo/README.md' }, { kind: 'edit', file: '/repo/src/old.ts' }] },
			{
				changedFiles: ['file:///repo/.worktrees/wt/docs/SPEC.md', 'untitled:Untitled-1'],
				cards: [
					{ kind: 'file', file: '/repo/.worktrees/wt/src/words.js' },
					{ kind: 'edit', file: '/repo/.worktrees/wt/src/stats.js' },
					{ kind: 'edit', file: 'relative/a.ts' },
					{ kind: 'command' },
					{ kind: 'search', file: '/elsewhere' },
					{ kind: 'file', file: '/repo/src/old.ts' },
				],
			},
		]);
		assert.deepStrictEqual({ changed: folders.changed.map(folder => folder.path), read: folders.read.map(folder => folder.path) }, {
			changed: ['/repo/.worktrees/wt/src', '/repo/.worktrees/wt/docs', '/repo/src'],
			read: ['/repo'],
		});
	});
});
