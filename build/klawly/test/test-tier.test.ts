/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Run: node --test build/klawly/test/test-tier.test.ts

import assert from 'assert';
import { suite, test } from 'node:test';
import { areaOf, changedFiles, importsOf, isOnlyMainMerge, pickTier } from '../test-tier.ts';

/** A small tree: test files and helpers mapped to what they import. */
const TESTS = new Map<string, string[]>([
	['src/vs/platform/claude/test/common/claudeAutoModel.test.ts', ['src/vs/platform/claude/common/claudeAutoModel.ts']],
	['src/vs/platform/claude/test/common/claudeCanvas.test.ts', ['src/vs/platform/claude/common/claudeCanvas.ts']],
	['src/vs/platform/claude/test/node/claudeTerminalTool.test.ts', ['src/vs/platform/claude/node/claudeTerminalTool.ts']],
	['src/vs/workbench/contrib/claude/test/browser/claudeFocusTestUtils.ts', ['src/vs/workbench/contrib/claude/browser/claudePane.ts']],
	['src/vs/workbench/contrib/claude/test/browser/claudePaneLayout.test.ts', ['src/vs/workbench/contrib/claude/test/browser/claudeFocusTestUtils.ts']],
	['src/vs/workbench/contrib/claude/test/browser/claudeMenus.test.ts', ['src/vs/workbench/contrib/claude/browser/claudeMenus.ts']],
	['src/vs/workbench/contrib/claude/test/browser/claudeHome.test.ts', []],
	['src/vs/workbench/contrib/claude/test/node/claudeDiagnostics.test.ts', []],
	['src/vs/workbench/test/browser/workbenchTestServices.ts', []],
	['src/vs/workbench/test/browser/parts.test.ts', []],
]);

function tierOf(changed: string[], release = false) {
	const { tier, reasons, nodeTests, electronTests, uncovered } = pickTier(changed, TESTS, { release });
	return { tier, reasons, nodeTests, electronTests, uncovered };
}

suite('test-tier', () => {

	test('docs only needs no runner', () => {
		assert.deepStrictEqual(tierOf(['docs/rules/50-testing.md', 'design/chat/index.html', 'AGENTS.md', 'src/vs/platform/claude/README.md']), {
			tier: 0, reasons: ['docs only: no runner'], nodeTests: [], electronTests: [], uncovered: [],
		});
	});

	test('a small fix runs the tests that import the changed files, directly or through helpers', () => {
		assert.deepStrictEqual(tierOf(['src/vs/workbench/contrib/claude/browser/claudePane.ts', 'src/vs/workbench/contrib/claude/browser/claudeMenus.ts', 'docs/notes.md']), {
			tier: 1,
			reasons: ['small fix in src/vs/workbench/contrib/claude'],
			nodeTests: [],
			electronTests: ['src/vs/workbench/contrib/claude/test/browser/claudeMenus.test.ts', 'src/vs/workbench/contrib/claude/test/browser/claudePaneLayout.test.ts'],
			uncovered: [],
		});
	});

	test('a changed test runs itself; common and node tests go to the node run', () => {
		assert.deepStrictEqual(tierOf(['src/vs/platform/claude/test/common/claudeCanvas.test.ts', 'src/vs/platform/claude/common/claudeAutoModel.ts']), {
			tier: 1,
			reasons: ['small fix in src/vs/platform/claude'],
			nodeTests: ['src/vs/platform/claude/test/common/claudeAutoModel.test.ts', 'src/vs/platform/claude/test/common/claudeCanvas.test.ts'],
			electronTests: [],
			uncovered: [],
		});
	});

	test('a file no test imports falls back to its nearest test folder, never a whole layer', () => {
		assert.deepStrictEqual(tierOf(['src/vs/workbench/contrib/claude/browser/chat/claudeNew.ts']).electronTests, [
			'src/vs/workbench/contrib/claude/test/browser/claudeHome.test.ts',
			'src/vs/workbench/contrib/claude/test/browser/claudeMenus.test.ts',
			'src/vs/workbench/contrib/claude/test/browser/claudePaneLayout.test.ts',
		]);
		assert.deepStrictEqual(tierOf(['src/vs/workbench/contrib/claude/electron-main/claudeNew.ts']).uncovered, ['src/vs/workbench/contrib/claude/electron-main/claudeNew.ts']);
	});

	test('lock, build, CI, shared-core, public-API and security paths are Tier 2 however small', () => {
		const risky = [
			'package-lock.json', 'extensions/git/package.json', '.nvmrc', 'build/klawly/test-tier.ts', 'scripts/test.sh', '.github/workflows/heavy-tests.yml',
			'src/vs/base/common/strings.ts', 'src/vs/workbench/browser/layout.ts', 'src/vs/platform/claude/common/claudeProtocol.ts', 'src/vscode-dts/vscode.d.ts',
			'src/vs/workbench/api/common/extHost.api.impl.ts', 'src/vs/platform/claude/node/claudeAgentHost.ts', 'src/vs/workbench/contrib/claude/browser/claudePermissionCard.ts',
		];
		assert.deepStrictEqual(risky.map(file => [file, tierOf([file]).tier, tierOf([file]).reasons[0].split(':')[0]]), [
			['package-lock.json', 2, 'dependencies'],
			['extensions/git/package.json', 2, 'dependencies'],
			['.nvmrc', 2, 'dependencies'],
			['build/klawly/test-tier.ts', 2, 'build'],
			['scripts/test.sh', 2, 'build'],
			['.github/workflows/heavy-tests.yml', 2, 'ci'],
			['src/vs/base/common/strings.ts', 2, 'shared-core'],
			['src/vs/workbench/browser/layout.ts', 2, 'shared-core'],
			['src/vs/platform/claude/common/claudeProtocol.ts', 2, 'shared-core'],
			['src/vscode-dts/vscode.d.ts', 2, 'public-api'],
			['src/vs/workbench/api/common/extHost.api.impl.ts', 2, 'public-api'],
			['src/vs/platform/claude/node/claudeAgentHost.ts', 2, 'security'],
			['src/vs/workbench/contrib/claude/browser/claudePermissionCard.ts', 2, 'security'],
		]);
	});

	test('two areas or too many files is a normal PR', () => {
		assert.deepStrictEqual(tierOf(['src/vs/platform/claude/common/claudeCanvas.ts', 'src/vs/workbench/contrib/claude/browser/claudeMenus.ts']).reasons, [
			'more than one area: src/vs/platform/claude, src/vs/workbench/contrib/claude',
		]);
		const six = ['a', 'b', 'c', 'd', 'e', 'f'].map(name => `src/vs/workbench/contrib/claude/browser/${name}.ts`);
		assert.deepStrictEqual(tierOf(six).reasons, ['6 source files (a small fix has at most 5)']);
		// Tests do not count toward the limit.
		assert.strictEqual(tierOf([...six.slice(0, 5), 'src/vs/workbench/contrib/claude/test/browser/claudeHome.test.ts']).tier, 1);
	});

	test('a release runs the full suites', () => {
		assert.deepStrictEqual(tierOf(['src/vs/platform/claude/common/claudeCanvas.ts'], true), {
			tier: 3, reasons: ['small fix in src/vs/platform/claude', 'release or end of sprint: full suites'], nodeTests: [], electronTests: [], uncovered: [],
		});
	});

	test('areas', () => {
		assert.deepStrictEqual([
			'src/vs/workbench/contrib/claude/browser/chat/x.ts',
			'src/vs/workbench/services/claude/test/common/x.test.ts',
			'src/vs/platform/claude/common/x.ts',
			'src/vs/editor/contrib/hover/browser/x.ts',
			'extensions/theme-klawly/themes/dark.json',
			'README.md',
		].map(areaOf), [
			'src/vs/workbench/contrib/claude',
			'src/vs/workbench/services/claude',
			'src/vs/platform/claude',
			'src/vs/editor/contrib/hover',
			'extensions/theme-klawly',
			'.',
		]);
	});

	test('a changed test the head tree does not have is never listed', () => {
		assert.deepStrictEqual(tierOf(['src/vs/platform/claude/test/common/claudeGone.test.ts', 'src/vs/platform/claude/common/claudeCanvas.ts']).nodeTests, [
			'src/vs/platform/claude/test/common/claudeCanvas.test.ts',
		]);
	});

	test('without a merge base the change is refused, never a diff of the two trees', () => {
		const calls: string[] = [];
		const run = (args: readonly string[]) => {
			calls.push(args[0]);
			if (args[0] === 'merge-base') {
				throw new Error('fatal: no merge base');
			}
			return 'src/vs/platform/claude/common/claudeCanvas.ts';
		};
		assert.throws(() => changedFiles('origin/main', 'HEAD', false, run), /No merge base for origin\/main and HEAD/);
		assert.deepStrictEqual(calls, ['merge-base']);
	});

	test('imports: relative and vs/ specifiers, static, dynamic and side-effect', () => {
		const content = [
			`import assert from 'assert';`,
			`import { a } from '../../common/claudeCanvas.js';`,
			`import type { B } from './helpers.js';`,
			`import 'vs/workbench/contrib/claude/browser/claude.contribution.js';`,
			`const c = await import('../../node/lazy.js');`,
			`export { d } from '../../../../base/common/event.js';`,
		].join('\n');
		assert.deepStrictEqual(importsOf('src/vs/platform/claude/test/common/x.test.ts', content), [
			'src/vs/platform/claude/common/claudeCanvas.ts',
			'src/vs/platform/claude/test/common/helpers.ts',
			'src/vs/workbench/contrib/claude/browser/claude.contribution.ts',
			'src/vs/platform/claude/node/lazy.ts',
			'src/vs/base/common/event.ts',
		]);
	});
});

suite('isOnlyMainMerge', () => {
	/** A fake git: rev-list gives the commits since `since`, diffs give the file lists. */
	function fake(opts: { commits: string[]; ancestor?: boolean; mainSide: string[]; branchSide: string[] }) {
		return (args: readonly string[]): string => {
			switch (args[0]) {
				case 'rev-list': return opts.commits.join('\n');
				case 'rev-parse': return 'S';
				case 'merge-base': if (args[1] === '--is-ancestor') { if (opts.ancestor === false) { throw new Error('no'); } return ''; } return 'F';
				case 'diff': return (args[2] === 'F' ? opts.branchSide : opts.mainSide).join('\n');
				default: throw new Error(args.join(' '));
			}
		};
	}

	test('a merge of main that overlaps the branch only in design/sync.json needs no run', () => {
		assert.strictEqual(isOnlyMainMerge('S', 'H', 'origin/main', fake({ commits: ['M S P'], mainSide: ['a.ts', 'design/sync.json'], branchSide: ['b.ts', 'design/sync.json'] })), true);
	});

	test('overlap in another file, a non-merge, a branch commit or a merge of something else needs a run', () => {
		const ok = { mainSide: ['a.ts'], branchSide: ['a.ts'] };
		assert.deepStrictEqual([
			isOnlyMainMerge('S', 'H', 'origin/main', fake({ commits: ['M S P'], ...ok })),
			isOnlyMainMerge('S', 'H', 'origin/main', fake({ commits: ['C S'], mainSide: [], branchSide: [] })),
			isOnlyMainMerge('S', 'H', 'origin/main', fake({ commits: ['M S P', 'C S'], mainSide: [], branchSide: [] })),
			isOnlyMainMerge('S', 'H', 'origin/main', fake({ commits: ['M S P'], ancestor: false, mainSide: [], branchSide: [] })),
			isOnlyMainMerge('S', 'H', 'origin/main', fake({ commits: ['M X P'], mainSide: [], branchSide: [] })),
		], [false, false, false, false, false]);
	});
});
