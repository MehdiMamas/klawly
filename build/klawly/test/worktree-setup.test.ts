/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Run: node --test build/klawly/test/worktree-setup.test.ts

import assert from 'assert';
import { suite, test } from 'node:test';
import { decideDependencies } from '../worktree-setup.ts';

const BASE = { worktreeHasModules: false, mainHasModules: true, mainLock: '{"a":1}', worktreeLock: '{"a":1}' };

suite('worktree-setup', () => {
	test('same lock file as main: link', () => {
		assert.strictEqual(decideDependencies(BASE), 'link');
	});

	test('lock file differs from main: install', () => {
		assert.strictEqual(decideDependencies({ ...BASE, worktreeLock: '{"a":2}' }), 'install');
	});

	test('main has no node_modules to link: install', () => {
		assert.strictEqual(decideDependencies({ ...BASE, mainHasModules: false }), 'install');
	});

	test('node_modules already there: leave it', () => {
		assert.strictEqual(decideDependencies({ ...BASE, worktreeHasModules: true }), 'present');
	});

	test('no lock file in the worktree: nothing to set up', () => {
		assert.strictEqual(decideDependencies({ ...BASE, worktreeLock: undefined }), 'unavailable');
	});
});
