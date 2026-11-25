/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { DEFAULT_PERMISSION_POLICY, PermissionPolicy } from '../../common/claudePermissions.js';
import { assessPath, canonicalizePath, classifyCommand, evaluateToolPolicy, isCredentialPath, isInsideWorkspace, PathRealpath, planFileLocation, ToolPolicyContext } from '../../common/claudeToolPolicy.js';
import { claudePlanDirectory, klawlyPlanDirectory as klawlyPlans } from '../../common/claudePlanFiles.js';
import { parseReadRules } from '../../common/claudeReadRules.js';

/** A realpath over a table of symlinks. A path that is not in the table exists as itself. */
function realpathWith(links: Record<string, string>, missing: readonly string[] = []): PathRealpath {
	return async path => {
		if (missing.some(prefix => path === prefix || path.startsWith(prefix + '/'))) {
			return undefined;
		}
		for (const [from, to] of Object.entries(links)) {
			if (path === from || path.startsWith(from + '/')) {
				return to + path.slice(from.length);
			}
		}
		return path;
	};
}

function context(overrides: Omit<Partial<ToolPolicyContext>, 'policy'> & { policy?: Partial<PermissionPolicy> } = {}): ToolPolicyContext {
	const { policy, ...rest } = overrides;
	return {
		cwd: '/ws',
		workspaceFolders: ['/ws'],
		additionalDirectories: [],
		trusted: true,
		policy: { ...DEFAULT_PERMISSION_POLICY, ...policy },
		...rest,
	};
}

suite('Claude tool policy: paths', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('canonicalizePath resolves relative paths and removes traversal', () => {
		assert.strictEqual(canonicalizePath('src/a.ts', '/ws'), '/ws/src/a.ts');
		assert.strictEqual(canonicalizePath('/ws/src/../../etc/passwd', '/ws'), '/etc/passwd');
		assert.strictEqual(canonicalizePath('./a//b/', '/ws'), '/ws/a/b');
		assert.strictEqual(canonicalizePath('C:\\ws\\src\\..\\a.ts', 'C:\\ws'), 'C:\\ws\\a.ts');
	});

	test('isInsideWorkspace is exact: a sibling that shares a prefix is outside', () => {
		assert.strictEqual(isInsideWorkspace('/ws', ['/ws']), true);
		assert.strictEqual(isInsideWorkspace('/ws/a/b.ts', ['/ws']), true);
		assert.strictEqual(isInsideWorkspace('/ws-evil/a.ts', ['/ws']), false);
		assert.strictEqual(isInsideWorkspace('/etc/passwd', ['/ws']), false);
		assert.strictEqual(isInsideWorkspace('/a/b', ['/ws', '/a']), true);
	});

	test('Windows paths compare without case and with either separator', () => {
		assert.strictEqual(isInsideWorkspace('C:\\Work\\app\\a.ts', ['c:\\work\\APP']), true);
		assert.strictEqual(isInsideWorkspace('C:\\Work\\app-evil\\a.ts', ['C:\\Work\\app']), false);
		assert.strictEqual(isInsideWorkspace('D:\\Work\\app\\a.ts', ['C:\\Work\\app']), false);
	});

	test('a traversal that leaves the workspace is outside', async () => {
		const assessed = await assessPath('src/../../outside.txt', context());
		assert.strictEqual(assessed.inside, false);
		assert.strictEqual(assessed.absolute, '/outside.txt');
	});

	test('a symlink inside the workspace that points outside is caught by the re-check', async () => {
		const realpath = realpathWith({ '/ws/link': '/etc' });
		const assessed = await assessPath('/ws/link/passwd', context({ realpath }));
		assert.strictEqual(assessed.absolute, '/ws/link/passwd');
		assert.strictEqual(assessed.real, '/etc/passwd');
		assert.strictEqual(assessed.inside, false);
		assert.strictEqual(assessed.escapesViaSymlink, true);
	});

	test('a new file resolves through its parent, so a link in the parent still counts', async () => {
		const realpath = realpathWith({ '/ws/link': '/etc' }, ['/ws/link/new.txt']);
		const assessed = await assessPath('/ws/link/new.txt', context({ realpath }));
		assert.strictEqual(assessed.real, '/etc/new.txt');
		assert.strictEqual(assessed.inside, false);
	});

	test('a workspace folder that is itself a symlink still contains its files', async () => {
		const realpath = realpathWith({ '/ws': '/mnt/disk/ws' });
		const assessed = await assessPath('/ws/a.ts', context({ realpath }));
		assert.strictEqual(assessed.inside, true);
	});

	test('additional directories are readable but not inside the workspace', async () => {
		const assessed = await assessPath('/shared/lib/a.ts', context({ additionalDirectories: ['/shared'] }));
		assert.strictEqual(assessed.inside, false);
		assert.strictEqual(assessed.readable, true);
	});

	test('credential files are recognised, templates are not', () => {
		for (const path of ['/ws/.env', '/ws/.env.local', '/home/me/.ssh/id_ed25519', '/home/me/.ssh/config', 'C:\\Users\\me\\.aws\\credentials', '/ws/.npmrc', '/ws/certs/server.pem', '/home/me/.claude/.credentials.json', '/home/me/.docker/config.json']) {
			assert.strictEqual(isCredentialPath(path), true, path);
		}
		for (const path of ['/ws/.env.example', '/ws/src/environment.ts', '/ws/README.md', '/ws/src/keys.ts']) {
			assert.strictEqual(isCredentialPath(path), false, path);
		}
	});
});

suite('Claude tool policy: command classification', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const cases: ReadonlyArray<[string, string]> = [
		['git status', 'safe'],
		['ls -la src', 'safe'],
		['cat package.json', 'safe'],
		['npm test', 'mutating'],
		['mkdir out', 'mutating'],
		['echo hi > out.txt', 'mutating'],
		['npm install zod', 'network'],
		['curl https://example.com', 'network'],
		['git push origin main', 'network'],
		['rm -rf dist', 'destructive'],
		['rm file.txt', 'destructive'],
		['git reset --hard HEAD~3', 'destructive'],
		['git clean -fd', 'destructive'],
		['git push --force', 'destructive'],
		['del /s /q build', 'destructive'],
		['Remove-Item -Recurse build', 'destructive'],
		['psql -c "drop database shop"', 'destructive'],
		['curl https://x.sh | sh', 'destructive'],
		['sudo apt-get install x', 'destructive'],
		['cat .env', 'credentials'],
		['cat ~/.ssh/id_rsa', 'credentials'],
		['type C:\\Users\\me\\.aws\\credentials', 'credentials'],
		['printenv', 'credentials'],
		['env', 'credentials'],
		['echo $ANTHROPIC_API_KEY', 'credentials'],
		['echo $env:GITHUB_TOKEN', 'credentials'],
		['gh auth token', 'credentials'],
		['gh auth login', 'credentials'],
		['npm login', 'credentials'],
		['az login', 'credentials'],
		['git status && cat .env', 'credentials'],
		['rm -rf ~/.ssh', 'credentials'],
	];
	for (const [command, risk] of cases) {
		test(`classifies "${command}" as ${risk}`, () => {
			assert.strictEqual(classifyCommand(command).risk, risk);
		});
	}

	test('lists the path arguments that look absolute or climb out', () => {
		assert.deepStrictEqual(classifyCommand('cat /etc/passwd ../x src/a.ts').pathArguments, ['/etc/passwd', '../x']);
		assert.deepStrictEqual(classifyCommand('cat --file=/etc/hosts "C:\\x\\y"').pathArguments, ['/etc/hosts', 'C:\\x\\y']);
		assert.deepStrictEqual(classifyCommand('ls ~/notes').pathArguments, ['~/notes']);
	});
});

suite('Claude tool policy: decisions', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('reads inside the workspace are allowed, Grep without a path included', async () => {
		assert.strictEqual((await evaluateToolPolicy('Read', { file_path: 'src/a.ts' }, context())).behavior, 'allow');
		assert.strictEqual((await evaluateToolPolicy('Grep', { pattern: 'x' }, context())).behavior, 'allow');
		assert.strictEqual((await evaluateToolPolicy('Glob', { pattern: '*.ts', path: '/ws/src' }, context())).behavior, 'allow');
	});

	test('a read outside the workspace asks, and may be remembered', async () => {
		const result = await evaluateToolPolicy('Read', { file_path: '/etc/hosts' }, context());
		assert.strictEqual(result.behavior, 'ask');
		assert.strictEqual(result.details.targetPath, '/etc/hosts');
		assert.strictEqual(result.details.outsideWorkspace, true);
		assert.strictEqual(result.canRemember, true);
	});

	test('a read of a credential file asks even inside the workspace and is never remembered', async () => {
		const result = await evaluateToolPolicy('Read', { file_path: '.env' }, context());
		assert.strictEqual(result.behavior, 'ask');
		assert.strictEqual(result.canRemember, false);
	});

	test('a write inside the workspace asks under the prompt preset and shows the absolute path', async () => {
		const result = await evaluateToolPolicy('Edit', { file_path: 'src/a.ts' }, context({ policy: { writeWorkspace: 'ask' } }));
		assert.strictEqual(result.behavior, 'ask');
		assert.strictEqual(result.details.targetPath, '/ws/src/a.ts');
		assert.strictEqual(result.canRemember, true);
		assert.strictEqual(result.subject, '/ws/src/a.ts');
	});

	test('the writeWorkspace setting allows an ordinary write but nothing sensitive', async () => {
		const allow = context({ policy: { writeWorkspace: 'allow' } });
		assert.strictEqual((await evaluateToolPolicy('Write', { file_path: 'src/a.ts' }, allow)).behavior, 'allow');
		for (const file_path of ['.env', '.git/hooks/pre-commit', '/ws/.ssh/id_rsa', '/etc/hosts', '../outside.txt']) {
			assert.strictEqual((await evaluateToolPolicy('Write', { file_path }, allow)).behavior, 'ask', file_path);
		}
	});

	test('a write outside the workspace asks once only, or is denied by setting', async () => {
		const ask = await evaluateToolPolicy('Write', { file_path: '/Users/me/.config/x.json' }, context());
		assert.strictEqual(ask.behavior, 'ask');
		assert.strictEqual(ask.canRemember, false);
		assert.strictEqual(ask.details.outsideWorkspace, true);
		const denied = await evaluateToolPolicy('Write', { file_path: '/Users/me/.config/x.json' }, context({ policy: { writeOutsideWorkspace: 'deny' } }));
		assert.strictEqual(denied.behavior, 'deny');
		assert.ok(denied.message?.includes('/Users/me/.config/x.json'));
	});

	test('a write through a symlink that leaves the workspace is treated as outside', async () => {
		const realpath = realpathWith({ '/ws/link': '/etc' });
		const result = await evaluateToolPolicy('Write', { file_path: '/ws/link/cron.d/x' }, context({ realpath, policy: { writeWorkspace: 'allow' } }));
		assert.strictEqual(result.behavior, 'ask');
		assert.strictEqual(result.canRemember, false);
		assert.strictEqual(result.details.outsideWorkspace, true);
		assert.ok(result.why.includes('/etc/cron.d/x'));
	});

	test('a write with no path is denied instead of guessed', async () => {
		assert.strictEqual((await evaluateToolPolicy('Write', {}, context())).behavior, 'deny');
		assert.strictEqual((await evaluateToolPolicy('Edit', 'oops', context())).behavior, 'deny');
		assert.strictEqual((await evaluateToolPolicy('Bash', {}, context())).behavior, 'deny');
	});

	test('a safe command is allowed, and asks when the setting says so', async () => {
		assert.strictEqual((await evaluateToolPolicy('Bash', { command: 'git status' }, context())).behavior, 'allow');
		assert.strictEqual((await evaluateToolPolicy('Bash', { command: 'git status' }, context({ policy: { shellSafe: 'ask' } }))).behavior, 'ask');
	});

	test('a safe command that reads outside the workspace asks', async () => {
		const result = await evaluateToolPolicy('Bash', { command: 'cat /etc/passwd' }, context());
		assert.strictEqual(result.behavior, 'ask');
		assert.strictEqual(result.details.targetPath, '/etc/passwd');
		const climb = await evaluateToolPolicy('Bash', { command: 'cat ../secrets.txt' }, context());
		assert.strictEqual(climb.behavior, 'ask');
	});

	test('a command that is not known to be read-only asks with its exact text and directory', async () => {
		const result = await evaluateToolPolicy('Bash', { command: 'npm test' }, context());
		assert.strictEqual(result.behavior, 'ask');
		assert.strictEqual(result.details.command, 'npm test');
		assert.strictEqual(result.details.cwd, '/ws');
		assert.strictEqual(result.canRemember, true);
	});

	test('a destructive command asks once only, and the setting can deny it', async () => {
		const ask = await evaluateToolPolicy('Bash', { command: 'git reset --hard HEAD~3' }, context());
		assert.strictEqual(ask.behavior, 'ask');
		assert.strictEqual(ask.details.risk, 'destructive');
		assert.strictEqual(ask.canRemember, false);
		const denied = await evaluateToolPolicy('Bash', { command: 'rm -rf dist' }, context({ policy: { shellDestructive: 'deny' } }));
		assert.strictEqual(denied.behavior, 'deny');
	});

	test('a command that touches credentials is never allowed automatically, whatever the settings', async () => {
		const loose = context({ policy: { writeWorkspace: 'allow', shellSafe: 'allow', network: 'allow' } });
		for (const command of ['cat .env', 'cat ~/.ssh/id_rsa', 'printenv', 'echo $GITHUB_TOKEN', 'git status && cat .env']) {
			const result = await evaluateToolPolicy('Bash', { command }, loose);
			assert.strictEqual(result.behavior, 'ask', command);
			assert.strictEqual(result.canRemember, false, command);
			assert.strictEqual(result.details.risk, 'credentials', command);
		}
	});

	test('network commands and web tools follow the network setting', async () => {
		assert.strictEqual((await evaluateToolPolicy('Bash', { command: 'npm install zod' }, context())).behavior, 'ask');
		assert.strictEqual((await evaluateToolPolicy('Bash', { command: 'npm install zod' }, context({ policy: { network: 'allow' } }))).behavior, 'allow');
		assert.strictEqual((await evaluateToolPolicy('Bash', { command: 'npm install zod' }, context({ policy: { network: 'deny' } }))).behavior, 'deny');
		assert.strictEqual((await evaluateToolPolicy('WebFetch', { url: 'https://example.com' }, context())).behavior, 'ask');
		assert.strictEqual((await evaluateToolPolicy('WebFetch', { url: 'https://example.com' }, context({ policy: { network: 'deny' } }))).behavior, 'deny');
	});

	test('an untrusted workspace never gets an automatic write, command, or fetch, and nothing is remembered', async () => {
		const untrusted = context({ trusted: false, policy: { writeWorkspace: 'allow', shellSafe: 'allow', network: 'allow' } });
		for (const [tool, input] of [['Write', { file_path: 'a.ts' }], ['Bash', { command: 'git status' }], ['Bash', { command: 'npm test' }], ['WebFetch', { url: 'https://example.com' }]] as const) {
			const result = await evaluateToolPolicy(tool, input, untrusted);
			assert.strictEqual(result.behavior, 'ask', tool);
			assert.strictEqual(result.canRemember, false, tool);
		}
		// Reading what the user opened is still free.
		assert.strictEqual((await evaluateToolPolicy('Read', { file_path: 'a.ts' }, untrusted)).behavior, 'allow');
		// A refusal stays a refusal.
		assert.strictEqual((await evaluateToolPolicy('Bash', { command: 'npm install zod' }, context({ trusted: false, policy: { network: 'deny' } }))).behavior, 'deny');
	});

	test('every path a read or search tool names is checked, not only the first field', async () => {
		for (const [tool, input] of [
			['Glob', { pattern: '/etc/*' }],
			['Glob', { pattern: '/etc/*', path: '/ws/src' }],
			['Glob', { pattern: '../*.txt' }],
			['Glob', { pattern: 'src/*/../../../etc/x' }],
			['Glob', { pattern: '~/.config/*' }],
			['LS', { path: '/etc' }],
			['Grep', { pattern: 'x', path: '/etc', glob: '*.conf' }],
			['NotebookRead', { notebook_path: '/etc/n.ipynb' }],
		] as const) {
			const result = await evaluateToolPolicy(tool, input, context());
			assert.strictEqual(result.behavior, 'ask', `${tool} ${JSON.stringify(input)}`);
			assert.strictEqual(result.details.outsideWorkspace, true, `${tool} ${JSON.stringify(input)}`);
		}
		for (const [tool, input] of [['Glob', { pattern: 'src/**/*.ts' }], ['Glob', { pattern: '**/*.ts' }], ['LS', { path: '/ws/src' }], ['LS', {}]] as const) {
			assert.strictEqual((await evaluateToolPolicy(tool, input, context())).behavior, 'allow', `${tool} ${JSON.stringify(input)}`);
		}
		const credentials = await evaluateToolPolicy('Glob', { pattern: '.env' }, context());
		assert.strictEqual(credentials.behavior, 'ask');
		assert.strictEqual(credentials.canRemember, false);
	});

	test('a symlink that leaves the workspace is caught in a Glob prefix, an LS path, and a relative command argument', async () => {
		const realpath = realpathWith({ '/ws/link': '/etc' });
		for (const [tool, input] of [['Glob', { pattern: 'link/*' }], ['LS', { path: 'link' }], ['Bash', { command: 'cat link/passwd' }], ['Bash', { command: 'ls -la link' }], ['Bash', { command: 'cat --file=link/passwd' }]] as const) {
			const result = await evaluateToolPolicy(tool, input, context({ realpath, policy: { shellSafe: 'allow' } }));
			assert.strictEqual(result.behavior, 'ask', `${tool} ${JSON.stringify(input)}`);
			assert.strictEqual(result.details.outsideWorkspace, true, `${tool} ${JSON.stringify(input)}`);
		}
		assert.strictEqual((await evaluateToolPolicy('Bash', { command: 'cat src/a.ts' }, context({ realpath }))).behavior, 'allow');
	});

	test('MCP and unknown tools cannot be remembered in an untrusted workspace', async () => {
		for (const tool of ['mcp__db__drop', 'SomethingNew']) {
			const trusted = await evaluateToolPolicy(tool, {}, context());
			assert.strictEqual(trusted.canRemember, true, tool);
			const untrusted = await evaluateToolPolicy(tool, {}, context({ trusted: false }));
			assert.strictEqual(untrusted.behavior, 'ask', tool);
			assert.strictEqual(untrusted.canRemember, false, tool);
		}
		// Bookkeeping and read tools are not held back by missing trust.
		assert.strictEqual((await evaluateToolPolicy('TodoWrite', {}, context({ trusted: false }))).behavior, 'allow');
		assert.strictEqual((await evaluateToolPolicy('LS', { path: 'src' }, context({ trusted: false }))).behavior, 'allow');
	});

	test('with automatic read approval off, workspace reads and searches ask and can be remembered', async () => {
		const strict = context({ policy: { readWorkspace: 'ask' } });
		const results = await Promise.all(([
			['Read', { file_path: 'src/a.ts' }],
			['Grep', { pattern: 'x', path: 'src' }],
			['Grep', { pattern: 'x' }],
			['Glob', { pattern: '**/*.ts' }],
			['LS', {}],
			['NotebookRead', { notebook_path: 'n.ipynb' }],
		] as const).map(async ([tool, input]) => {
			const result = await evaluateToolPolicy(tool, input, strict);
			return [tool, result.behavior, result.canRemember, result.details.outsideWorkspace];
		}));
		assert.deepStrictEqual(results, [
			['Read', 'ask', true, false],
			['Grep', 'ask', true, false],
			['Grep', 'ask', true, false],
			['Glob', 'ask', true, false],
			['LS', 'ask', true, false],
			['NotebookRead', 'ask', true, false],
		]);
		// The default still reads freely, and the setting does not touch commands or bookkeeping tools.
		assert.strictEqual((await evaluateToolPolicy('Read', { file_path: 'src/a.ts' }, context())).behavior, 'allow');
		assert.strictEqual((await evaluateToolPolicy('Bash', { command: 'git status' }, strict)).behavior, 'allow');
		assert.strictEqual((await evaluateToolPolicy('TodoWrite', {}, strict)).behavior, 'allow');
		// Credential files still cannot be remembered.
		assert.strictEqual((await evaluateToolPolicy('Read', { file_path: '.env' }, strict)).canRemember, false);
	});

	test('MCP and unknown tools ask, and bookkeeping tools do not', async () => {
		assert.strictEqual((await evaluateToolPolicy('mcp__db__drop', {}, context())).behavior, 'ask');
		assert.strictEqual((await evaluateToolPolicy('SomethingNew', {}, context())).behavior, 'ask');
		assert.strictEqual((await evaluateToolPolicy('TodoWrite', {}, context())).behavior, 'allow');
		assert.strictEqual((await evaluateToolPolicy('Skill', {}, context())).behavior, 'allow');
	});

	test('grant keys differ by tool and exact subject', async () => {
		const a = await evaluateToolPolicy('Bash', { command: 'npm test' }, context());
		const b = await evaluateToolPolicy('Bash', { command: 'npm test -- --watch' }, context());
		const c = await evaluateToolPolicy('Write', { file_path: 'a.ts' }, context());
		assert.strictEqual(new Set([a.grantKey, b.grantKey, c.grantKey]).size, 3);
	});
});

suite('Claude tool policy: plan files and modes (Phase 27)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const plans = ['/home/me/.claude/plans'];

	test('plan files are *.plan.md, .claude/plans/ and the legacy .klawly/plans/ inside the workspace, and *.md in the Claude plan folder', () => {
		const cases: [string, string | undefined][] = [
			['/ws/docs/feature.plan.md', 'workspace'],
			['/ws/FEATURE.PLAN.MD', 'workspace'],
			['/ws/.claude/plans/a.md', 'workspace'],
			['/ws/.claude/plans/sub/notes.txt', 'workspace'],
			['/ws/.claude/plans', undefined],
			['/ws/.klawly/plans/a.md', 'workspace'],
			['/ws/.klawly/plans/sub/notes.txt', 'workspace'],
			['/ws/.klawly/plans', undefined],
			['/ws/plan.md', undefined],
			['/ws/src/a.ts', undefined],
			['/other/x.plan.md', undefined],
			['/home/me/.claude/plans/happy-fox.md', 'claude'],
			['/home/me/.claude/plans/x.json', undefined],
			['/home/me/.claude/settings.md', undefined],
			['/ws-evil/a.plan.md', undefined],
		];
		assert.deepStrictEqual(cases.map(([path]) => [path, planFileLocation(path, ['/ws'], plans)]), cases);
		assert.strictEqual(planFileLocation('C:\\Work\\App\\.Klawly\\Plans\\a.md', ['c:\\work\\app'], []), 'workspace');
		assert.strictEqual(claudePlanDirectory('/home/me'), '/home/me/.claude/plans');
		assert.strictEqual(claudePlanDirectory('C:\\Users\\me'), 'C:\\Users\\me\\.claude\\plans');
		assert.strictEqual(claudePlanDirectory('/home/me', '/cfg/claude'), '/cfg/claude/plans');
	});

	test('Plan writes only plan files, after following symlinks', async () => {
		// The acceptEdits preset: under the default prompt preset these writes ask first.
		const plan = (overrides: Omit<Partial<ToolPolicyContext>, 'policy'> = {}) => context({ mode: 'plan', planDirectories: plans, policy: { writeWorkspace: 'allow' }, ...overrides });
		assert.deepStrictEqual(await Promise.all(['docs/x.plan.md', '.claude/plans/a.md', '.klawly/plans/a.md', '/home/me/.claude/plans/p.md', 'src/a.ts', '/etc/x.plan.md', '.env'].map(async file_path => {
			const result = await evaluateToolPolicy('Write', { file_path }, plan());
			return [file_path, result.behavior, result.modeDenial === true];
		})), [
			['docs/x.plan.md', 'allow', false],
			['.claude/plans/a.md', 'allow', false],
			['.klawly/plans/a.md', 'allow', false],
			['/home/me/.claude/plans/p.md', 'allow', false],
			['src/a.ts', 'deny', true],
			['/etc/x.plan.md', 'deny', true],
			['.env', 'deny', true],
		]);
		// A plan-file name that is a link to source code is not a plan file.
		const realpath = realpathWith({ '/ws/sneaky.plan.md': '/ws/src/index.ts', '/home/me/.claude/plans/out.md': '/etc/profile' });
		assert.strictEqual((await evaluateToolPolicy('Write', { file_path: 'sneaky.plan.md' }, plan({ realpath }))).behavior, 'deny');
		assert.strictEqual((await evaluateToolPolicy('Write', { file_path: '/home/me/.claude/plans/out.md' }, plan({ realpath }))).behavior, 'deny');
		// The prompt preset still asks for a plan-file edit in the workspace; untrusted asks once.
		assert.strictEqual((await evaluateToolPolicy('Write', { file_path: 'a.plan.md' }, context({ mode: 'plan', policy: { writeWorkspace: 'ask' } }))).behavior, 'ask');
		const untrusted = await evaluateToolPolicy('Write', { file_path: 'a.plan.md' }, plan({ trusted: false }));
		assert.deepStrictEqual([untrusted.behavior, untrusted.canRemember], ['ask', false]);
	});

	test('the Klawly plan folder for this user (issue 322): plan files there are readable, and writable in Plan and Agent as if in the workspace', async () => {
		const klawlyPlanDirectory = klawlyPlans('/home/me', '.klawly');
		assert.deepStrictEqual([klawlyPlanDirectory, klawlyPlans('C:\\Users\\me', '.klawly-dev')], ['/home/me/.klawly/plans', 'C:\\Users\\me\\.klawly-dev\\plans']);
		assert.deepStrictEqual(['/home/me/.klawly/plans/a-1b2c3d.plan.md', '/home/me/.klawly/plans/x.json', '/home/me/.klawly/argv.json', '/home/me/.klawly/plans'].map(path => planFileLocation(path, ['/ws'], plans, [klawlyPlanDirectory])), ['klawly', undefined, undefined, undefined]);
		const file_path = '/home/me/.klawly/plans/a-1b2c3d.plan.md';
		const behavior = async (toolName: string, overrides: Omit<Partial<ToolPolicyContext>, 'policy'> & { policy?: Partial<PermissionPolicy> }) => (await evaluateToolPolicy(toolName, { file_path }, context({ klawlyPlanDirectory, ...overrides }))).behavior;
		assert.deepStrictEqual([
			await behavior('Read', {}),
			await behavior('Edit', { mode: 'agent', policy: { writeWorkspace: 'allow' } }),
			await behavior('Edit', { mode: 'agent', policy: { writeWorkspace: 'ask' } }),
			await behavior('Write', { mode: 'plan', policy: { writeWorkspace: 'allow' } }),
			await behavior('Edit', { mode: 'ask' }),
			// Without the folder (an older host), the same file is outside the workspace.
			await behavior('Edit', { mode: 'agent', klawlyPlanDirectory: undefined, policy: { writeWorkspace: 'allow' } }),
			// Only `.md` files count, and a link out of the folder is not a plan file.
			(await evaluateToolPolicy('Edit', { file_path: '/home/me/.klawly/plans/x.json' }, context({ klawlyPlanDirectory, policy: { writeWorkspace: 'allow' } }))).behavior,
			(await evaluateToolPolicy('Edit', { file_path }, context({ klawlyPlanDirectory, policy: { writeWorkspace: 'allow' }, realpath: realpathWith({ [file_path]: '/etc/profile' }) }))).behavior,
		], ['allow', 'allow', 'ask', 'allow', 'deny', 'ask', 'ask', 'ask']);
	});

	test('issue 399: Plan writes its plan to a plan folder without a card, and a plan-file card outside Plan has a matching title and hint', async () => {
		const klawlyPlanDirectory = klawlyPlans('/home/me', '.klawly');
		const prompt = (overrides: Omit<Partial<ToolPolicyContext>, 'policy'> = {}) => context({ planDirectories: plans, klawlyPlanDirectory, policy: { writeWorkspace: 'ask' }, ...overrides });
		const summary = async (toolName: string, file_path: string, overrides: Omit<Partial<ToolPolicyContext>, 'policy'> = {}) => {
			const result = await evaluateToolPolicy(toolName, { file_path }, prompt(overrides));
			return [file_path, result.behavior, result.details.outsideWorkspace, result.why, result.planFile];
		};
		assert.deepStrictEqual([
			// Plan mode, the prompt preset: the plan is the turn's output.
			await summary('Write', '/home/me/.klawly/plans/clear-cart.plan.md', { mode: 'plan' }),
			await summary('Edit', '/home/me/.claude/plans/happy-fox.md', { mode: 'plan' }),
			// A path that climbs out of the folder is not a plan file.
			await summary('Write', '/home/me/.klawly/plans/../evil.plan.md', { mode: 'plan' }),
			// A plan file in the workspace still follows the workspace preset.
			await summary('Write', 'docs/x.plan.md', { mode: 'plan' }),
			// Build ticks the to-dos: it asks, and the card says it is the plan file.
			await summary('Edit', '/home/me/.klawly/plans/clear-cart.plan.md', { mode: 'agent' }),
			// Claude Code's own folder is outside the workspace outside Plan mode, and the card says so.
			await summary('Edit', '/home/me/.claude/plans/happy-fox.md', { mode: 'agent' }),
		], [
			['/home/me/.klawly/plans/clear-cart.plan.md', 'allow', false, '', 'klawly'],
			['/home/me/.claude/plans/happy-fox.md', 'allow', false, '', 'claude'],
			['/home/me/.klawly/plans/../evil.plan.md', 'deny', true, 'Plan mode only writes plan files.', undefined],
			['docs/x.plan.md', 'ask', false, 'Claude wants to change a file in the workspace.', undefined],
			['/home/me/.klawly/plans/clear-cart.plan.md', 'ask', false, 'Claude wants to update the plan file.', 'klawly'],
			['/home/me/.claude/plans/happy-fox.md', 'ask', true, 'This file is outside the workspace.', 'claude'],
		]);
		// Credentials still win, and an untrusted workspace still asks once.
		assert.strictEqual((await evaluateToolPolicy('Write', { file_path: '/home/me/.klawly/plans/.ssh/id_rsa.md' }, prompt({ mode: 'plan' }))).details.risk, 'credentials');
		const untrusted = await evaluateToolPolicy('Write', { file_path: '/home/me/.klawly/plans/a.plan.md' }, prompt({ mode: 'plan', trusted: false }));
		assert.deepStrictEqual([untrusted.behavior, untrusted.canRemember], ['ask', false]);
	});

	test('issues 399 and 400 with the home folder as the workspace: the plan folders inside it stay plan folders', async () => {
		const klawlyPlanDirectory = klawlyPlans('/home/me', '.klawly');
		assert.deepStrictEqual(['/home/me/.klawly/plans/a.plan.md', '/home/me/.claude/plans/happy-fox.md', '/home/me/docs/x.plan.md'].map(path => planFileLocation(path, ['/home/me'], plans, [klawlyPlanDirectory])), ['klawly', 'claude', 'workspace']);
		const home = (overrides: Omit<Partial<ToolPolicyContext>, 'policy'> & { policy?: Partial<PermissionPolicy> } = {}) => context({ cwd: '/home/me', workspaceFolders: ['/home/me'], planDirectories: plans, klawlyPlanDirectory, policy: { writeWorkspace: 'ask' }, ...overrides });
		const summary = async (toolName: string, file_path: string, overrides: Omit<Partial<ToolPolicyContext>, 'policy'> & { policy?: Partial<PermissionPolicy> } = {}) => {
			const result = await evaluateToolPolicy(toolName, { file_path }, home(overrides));
			return [file_path, result.behavior, result.details.outsideWorkspace, result.planFile];
		};
		assert.deepStrictEqual([
			await summary('Write', '/home/me/.klawly/plans/clear-cart.plan.md', { mode: 'plan' }),
			await summary('Edit', '/home/me/.claude/plans/happy-fox.md', { mode: 'plan' }),
			await summary('Edit', '/home/me/.klawly/plans/clear-cart.plan.md', { mode: 'agent' }),
			await summary('Edit', '/home/me/.klawly/plans/clear-cart.plan.md', { mode: 'agent', policy: { writeWorkspace: 'allow' } }),
			await summary('Write', '/home/me/src/a.ts', { mode: 'agent' }),
		], [
			['/home/me/.klawly/plans/clear-cart.plan.md', 'allow', false, 'klawly'],
			['/home/me/.claude/plans/happy-fox.md', 'allow', false, 'claude'],
			['/home/me/.klawly/plans/clear-cart.plan.md', 'ask', false, 'klawly'],
			['/home/me/.klawly/plans/clear-cart.plan.md', 'allow', false, 'klawly'],
			['/home/me/src/a.ts', 'ask', false, undefined],
		]);
		// Credentials, .git and a link out of the folder still come before the auto-allow.
		const realpath = realpathWith({ '/home/me/.klawly/plans/out.md': '/home/me/src/index.ts' });
		assert.deepStrictEqual([
			(await evaluateToolPolicy('Write', { file_path: '/home/me/.klawly/plans/.ssh/id_rsa.md' }, home({ mode: 'plan' }))).details.risk,
			(await evaluateToolPolicy('Write', { file_path: '/home/me/.klawly/plans/out.md' }, home({ mode: 'plan', realpath }))).behavior,
			(await evaluateToolPolicy('Write', { file_path: '/home/me/.git/hooks/x.plan.md' }, home({ mode: 'plan', policy: { writeWorkspace: 'allow' } }))).behavior,
		], ['credentials', 'deny', 'ask']);
	});

	test('Ask never writes, plan files included; Plan and Ask fetch without a card unless the network is denied', async () => {
		const ask = await evaluateToolPolicy('Write', { file_path: 'a.plan.md' }, context({ mode: 'ask', planDirectories: plans }));
		assert.deepStrictEqual([ask.behavior, ask.modeDenial], ['deny', true]);
		for (const mode of ['plan', 'ask'] as const) {
			assert.strictEqual((await evaluateToolPolicy('WebFetch', { url: 'https://x.dev' }, context({ mode }))).behavior, 'allow', mode);
			assert.strictEqual((await evaluateToolPolicy('WebFetch', { url: 'https://x.dev' }, context({ mode, policy: { network: 'deny' } }))).behavior, 'deny', mode);
			assert.strictEqual((await evaluateToolPolicy('WebFetch', { url: 'https://x.dev' }, context({ mode, trusted: false }))).behavior, 'ask', mode);
		}
		assert.strictEqual((await evaluateToolPolicy('WebFetch', { url: 'https://x.dev' }, context({ mode: 'agent' }))).behavior, 'ask');
	});
});

suite('Claude tool policy: files Claude cannot read (issue 458)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const home = '/home/me';
	const readRules = parseReadRules('.env\n*.pem\n~/.ssh\nsecrets/*\n!secrets/public.txt\n', { source: 'user', home });
	const open: Partial<PermissionPolicy> = { readWorkspace: 'allow', writeWorkspace: 'allow', writeOutsideWorkspace: 'ask', shellSafe: 'allow', network: 'allow' };
	const blockedContext = (overrides: Omit<Partial<ToolPolicyContext>, 'policy'> = {}) => context({ readRules, homeDirectory: home, policy: open, ...overrides });

	test('Read, Edit, Write, Grep, Glob and LS are denied for a blocked file and cannot be remembered', async () => {
		const requests: [string, unknown][] = [
			['Read', { file_path: '/ws/.env' }],
			['Edit', { file_path: '/ws/app/.env', old_string: 'a', new_string: 'b' }],
			['Write', { file_path: '/ws/key.pem', content: 'x' }],
			['Grep', { pattern: 'x', path: '/ws/secrets/a.txt' }],
			['Glob', { pattern: '/home/me/.ssh/*' }],
			['LS', { path: '~/.ssh' }],
		];
		for (const [tool, input] of requests) {
			const verdict = await evaluateToolPolicy(tool, input, blockedContext());
			assert.deepStrictEqual([tool, verdict.behavior, verdict.canRemember], [tool, 'deny', false]);
		}
	});

	test('the block holds in every mode, with a trusted or untrusted workspace', async () => {
		for (const mode of ['agent', 'plan', 'ask'] as const) {
			for (const trusted of [true, false]) {
				const verdict = await evaluateToolPolicy('Read', { file_path: '/ws/.env' }, blockedContext({ mode, trusted }));
				assert.deepStrictEqual([mode, trusted, verdict.behavior], [mode, trusted, 'deny']);
			}
		}
	});

	test('a Grep or Glob without a path is judged by the working folder', async () => {
		const verdict = await evaluateToolPolicy('Grep', { pattern: 'x' }, blockedContext({ cwd: '/ws/secrets/sub', workspaceFolders: ['/ws'] }));
		assert.strictEqual(verdict.behavior, 'deny');
	});

	test('shell operands and a symlink into a blocked place are denied', async () => {
		assert.deepStrictEqual(
			[
				(await evaluateToolPolicy('Bash', { command: 'cat .env' }, blockedContext())).behavior,
				(await evaluateToolPolicy('Bash', { command: 'cat secrets/a.txt' }, blockedContext())).behavior,
				(await evaluateToolPolicy('Bash', { command: 'cat ~/.ssh/id_rsa' }, blockedContext())).behavior,
				(await evaluateToolPolicy('Read', { file_path: '/ws/link' }, blockedContext({ realpath: realpathWith({ '/ws/link': '/ws/.env' }) }))).behavior,
			],
			['deny', 'deny', 'deny', 'deny']);
	});

	test('an MCP tool with a path argument is denied', async () => {
		const verdict = await evaluateToolPolicy('mcp__files__open', { path: '/ws/.env' }, blockedContext());
		assert.strictEqual(verdict.behavior, 'deny');
	});

	test('a file not on the list, or let through by a ! rule, is judged as before', async () => {
		const plain = await evaluateToolPolicy('Read', { file_path: '/ws/readme.md' }, blockedContext());
		const reopened = await evaluateToolPolicy('Read', { file_path: '/ws/secrets/public.txt' }, blockedContext());
		const unlisted = await evaluateToolPolicy('Read', { file_path: '/ws/notes.txt' }, context());
		assert.deepStrictEqual([plain.behavior, reopened.behavior, unlisted.behavior], ['allow', 'allow', 'allow']);
	});
});
