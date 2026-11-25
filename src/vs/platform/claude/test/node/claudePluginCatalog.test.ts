/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { dirname, join } from '../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { ClaudePluginCommand, claudePluginKinds, filterClaudePlugins, knownClaudePluginKinds, readClaudePluginCommandResult } from '../../common/claudePlugins.js';
import { ClaudeCatalogFetchResult, claudeIconDataUrl, ClaudePluginCatalogReader, claudePluginIconUrl, parseClaudeMarketplaceManifest, readAllowedTools } from '../../node/claudePluginCatalog.js';
import { ClaudeNodeRuntimeService } from '../../node/claudeNodeRuntimeService.js';
import { ExecFileOptions } from '../../node/claudeRuntime.js';

/** Customize > Discover reads Claude Code plugin marketplaces and installs through `claude plugin` (issue 427). */
suite('Claude plugin catalog', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();
	const folders: string[] = [];

	teardown(() => {
		for (const folder of folders.splice(0)) {
			rmSync(folder, { recursive: true, force: true });
		}
	});

	function tree(files: Record<string, string>): string {
		const root = mkdtempSync(join(tmpdir(), 'klawly-plugins-'));
		folders.push(root);
		for (const [path, body] of Object.entries(files)) {
			mkdirSync(dirname(join(root, path)), { recursive: true });
			writeFileSync(join(root, path), body);
		}
		return root;
	}

	test('a marketplace manifest keeps valid entries, counts broken ones and ignores what it does not know', () => {
		const manifest = parseClaudeMarketplaceManifest(JSON.stringify({
			name: 'team',
			metadata: { pluginRoot: './plugins' },
			plugins: [
				{ name: 'lint', displayName: 'Lint', description: 'Lints', author: { name: 'Ada' }, source: 'lint', category: 'dev', logo: 'https://cdn.example/lint.png', futureField: { kind: 'widgets' } },
				{ name: 'remote', icon: 'http://insecure.example/remote.png', source: { source: 'git-subdir', url: 'https://github.com/acme/tools.git', path: 'plugins/remote', ref: 'v1', sha: 'abcdef1' } },
				{ name: 'npm-one', source: { source: 'npm', package: '@acme/plugin' } },
				{ name: 'escape', source: '../outside' },
				{ description: 'no name', source: './x' },
				{ name: 'no-source' },
			],
		}));
		assert.deepStrictEqual(manifest, {
			name: 'team',
			skipped: 3,
			plugins: [
				{ name: 'lint', displayName: 'Lint', description: 'Lints', author: 'Ada', category: 'dev', homepage: undefined, version: undefined, icon: 'https://cdn.example/lint.png', source: { kind: 'relative', path: 'plugins/lint' }, declared: { commands: undefined, agents: undefined, skills: undefined, hooks: undefined, mcpServers: undefined } },
				{ name: 'remote', displayName: undefined, description: '', author: undefined, category: undefined, homepage: undefined, version: undefined, icon: undefined, source: { kind: 'github', repo: 'acme/tools', ref: 'v1', sha: 'abcdef1', path: 'plugins/remote' }, declared: { commands: undefined, agents: undefined, skills: undefined, hooks: undefined, mcpServers: undefined } },
				{ name: 'npm-one', displayName: undefined, description: '', author: undefined, category: undefined, homepage: undefined, version: undefined, icon: undefined, source: { kind: 'other', label: '@acme/plugin' }, declared: { commands: undefined, agents: undefined, skills: undefined, hooks: undefined, mcpServers: undefined } },
			],
		});
		assert.deepStrictEqual([parseClaudeMarketplaceManifest('{'), parseClaudeMarketplaceManifest('{"plugins":{}}')], [undefined, undefined]);
	});

	test('a plugin icon comes from its entry, then its GitHub account, then its homepage favicon, and only safe images are kept (issue 534)', async () => {
		const github = { kind: 'github', repo: 'supabase-community/supabase-mcp' } as const;
		const relative = { kind: 'relative', path: 'plugins/x' } as const;
		const urls = [
			claudePluginIconUrl({ icon: 'https://cdn.example/x.png', homepage: 'https://x.example', source: github }),
			claudePluginIconUrl({ source: github }),
			claudePluginIconUrl({ homepage: 'https://github.com/acme/tool#readme', source: relative }),
			claudePluginIconUrl({ homepage: 'https://github.com/orgs/acme/projects', source: relative }),
			claudePluginIconUrl({ homepage: 'https://www.example.com/docs/plugin', source: relative }),
			claudePluginIconUrl({ homepage: 'http://insecure.example', source: relative }),
			claudePluginIconUrl({ source: relative }),
		];
		const png = VSBuffer.fromByteArray([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
		const kinds = [
			png,
			VSBuffer.fromString('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
			VSBuffer.fromByteArray([0, 0, 1, 0, 1, 0, 16, 16, 0, 0, 0, 0]),
			VSBuffer.alloc(200 * 1024),
		].map(bytes => claudeIconDataUrl(bytes)?.split(',')[0]);

		const marketplace = tree({
			'.claude-plugin/marketplace.json': JSON.stringify({
				name: 'team',
				plugins: [
					{ name: 'a', source: { source: 'github', repo: 'acme/a' } },
					{ name: 'b', source: { source: 'github', repo: 'acme/b' } },
					{ name: 'c', homepage: 'https://c.example', source: './c' },
					{ name: 'd', source: './d' },
				],
			}),
		});
		const config = tree({ 'plugins/known_marketplaces.json': JSON.stringify({ team: { source: { source: 'github', repo: 'acme/team' }, installLocation: marketplace } }) });
		const fetched: string[] = [];
		let now = 0;
		const reader = new ClaudePluginCatalogReader({
			configDirectory: config,
			fetch: async () => ({ status: 404 }),
			fetchBytes: async url => {
				fetched.push(url);
				return url.includes('acme') ? { status: 200, body: png } : { status: 404 };
			},
			now: () => now,
		});
		const first = await reader.getPluginIcons(['a@team', 'b@team', 'c@team', 'd@team', 'missing@team'], { builtIn: false });
		await reader.getPluginIcons(['a@team', 'c@team'], { builtIn: false });
		now = 11 * 60 * 1000;
		await reader.getPluginIcons(['a@team', 'c@team'], { builtIn: false });
		assert.deepStrictEqual({ urls, kinds, icons: Object.keys(first), fetched }, {
			urls: [
				'https://cdn.example/x.png',
				'https://github.com/supabase-community.png?size=64',
				'https://github.com/acme.png?size=64',
				undefined,
				'https://www.example.com/favicon.ico',
				undefined,
				undefined,
			],
			kinds: ['data:image/png;base64', undefined, 'data:image/x-icon;base64', undefined],
			icons: ['a@team', 'b@team'],
			// One fetch for both acme plugins; the miss is tried again after ten minutes, the hit is kept.
			fetched: ['https://github.com/acme.png?size=64', 'https://c.example/favicon.ico', 'https://c.example/favicon.ico'],
		});
	});

	test('the catalog reads added marketplaces and installs, and details list every hook, server and tool', async () => {
		const marketplace = tree({
			'.claude-plugin/marketplace.json': JSON.stringify({
				name: 'team',
				plugins: [
					{ name: 'guard', description: 'Guards commands', source: './plugins/guard', version: '2.0.0' },
					{ name: 'remote', description: 'Elsewhere', source: { source: 'url', url: 'https://git.example/remote.git' } },
				],
			}),
			'plugins/guard/.claude-plugin/plugin.json': JSON.stringify({ name: 'guard', mcpServers: { docs: { url: 'https://docs.example/mcp' } } }),
			'plugins/guard/commands/review.md': '---\nallowed-tools: Bash(git diff:*), Read\n---\nReview.',
			'plugins/guard/agents/checker.md': 'An agent.',
			'plugins/guard/skills/style/SKILL.md': '---\nname: style\nallowed-tools:\n  - Grep\n---\nStyle.',
			'plugins/guard/hooks/hooks.json': JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: '${CLAUDE_PLUGIN_ROOT}/check.sh' }] }] } }),
			'plugins/guard/.mcp.json': JSON.stringify({ mcpServers: { db: { command: 'npx', args: ['db-mcp', '--readonly'] } } }),
			'plugins/guard/README.md': '# Guard',
		});
		const config = tree({
			'plugins/known_marketplaces.json': JSON.stringify({ team: { source: { source: 'github', repo: 'acme/team' }, installLocation: marketplace } }),
			'plugins/installed_plugins.json': JSON.stringify({ version: 2, plugins: { 'guard@team': [{ scope: 'user', installPath: join(marketplace, 'plugins', 'guard'), version: '1.0.0' }] } }),
		});
		const fetched: string[] = [];
		const reader = new ClaudePluginCatalogReader({ configDirectory: config, fetch: async url => { fetched.push(url); return { status: 404 }; } });

		const catalog = await reader.getCatalog({ builtIn: false });
		const details = await reader.getDetails('guard@team', { builtIn: false });
		assert.deepStrictEqual({
			marketplaces: catalog.marketplaces,
			plugins: catalog.plugins.map(plugin => ({ id: plugin.id, source: plugin.source, installed: plugin.installed, updateAvailable: plugin.updateAvailable, kinds: plugin.contents && { skills: plugin.contents.skills, subagents: plugin.contents.subagents, commands: plugin.contents.commands } })),
			details: details && { contents: details.contents, readme: details.readme },
			remoteDetails: (await reader.getDetails('remote@team', { builtIn: false }))?.contents.complete,
			fetched,
		}, {
			marketplaces: [{ name: 'team', source: 'acme/team', added: true, builtIn: false, pluginCount: 2 }],
			plugins: [
				{ id: 'guard@team', source: 'team/plugins/guard', installed: { scope: 'user', version: '1.0.0' }, updateAvailable: true, kinds: { skills: ['style'], subagents: ['checker'], commands: ['review'] } },
				{ id: 'remote@team', source: 'https://git.example/remote.git', installed: undefined, updateAvailable: false, kinds: undefined },
			],
			details: {
				contents: {
					skills: ['style'],
					subagents: ['checker'],
					commands: ['review'],
					hooks: [{ event: 'PreToolUse', matcher: 'Bash', command: '${CLAUDE_PLUGIN_ROOT}/check.sh' }],
					mcpServers: [{ name: 'db', command: 'npx', args: ['db-mcp', '--readonly'], url: undefined }, { name: 'docs', command: undefined, args: undefined, url: 'https://docs.example/mcp' }],
					allowedTools: ['Bash(git diff:*)', 'Read', 'Grep'],
					complete: true,
				},
				readme: '# Guard',
			},
			remoteDetails: false,
			fetched: [],
		});
		assert.deepStrictEqual([filterClaudePlugins(catalog.plugins, '', 'mcp'), filterClaudePlugins(catalog.plugins, 'ELSEWHERE', undefined)].map(list => list.map(plugin => plugin.id)), [['guard@team'], ['remote@team']]);
	});

	test('the built-in marketplace is fetched with its ETag and reused on 304', async () => {
		const config = tree({});
		const calls: { url: string; etag: string | undefined }[] = [];
		const responses: ClaudeCatalogFetchResult[] = [
			{ status: 200, etag: '"v1"', body: JSON.stringify({ name: 'claude-plugins-official', plugins: [{ name: 'hello', description: 'Hi', source: { source: 'github', repo: 'acme/hello' } }] }) },
			{ status: 304 },
		];
		const reader = new ClaudePluginCatalogReader({ configDirectory: config, fetch: async (url, etag) => { calls.push({ url, etag }); return responses.shift() ?? { status: 500 }; } });

		const first = await reader.getCatalog({ builtIn: true });
		const cached = await reader.getCatalog({ builtIn: true });
		const refreshed = await reader.getCatalog({ builtIn: true, refresh: true });
		const off = await reader.getCatalog({ builtIn: false });
		const manifestUrl = 'https://raw.githubusercontent.com/anthropics/claude-plugins-official/HEAD/.claude-plugin/marketplace.json';
		assert.deepStrictEqual({
			calls,
			first: first.plugins.map(plugin => `${plugin.id} ${plugin.source}`),
			sameObject: first === cached,
			refreshed: refreshed.plugins.map(plugin => plugin.id),
			marketplaces: refreshed.marketplaces,
			off: off.plugins.length,
		}, {
			calls: [{ url: manifestUrl, etag: undefined }, { url: manifestUrl, etag: '"v1"' }],
			first: ['hello@claude-plugins-official acme/hello'],
			sameObject: true,
			refreshed: ['hello@claude-plugins-official'],
			marketplaces: [{ name: 'claude-plugins-official', source: 'anthropics/claude-plugins-official', added: false, builtIn: true, pluginCount: 1 }],
			off: 0,
		});
	});

	test('project settings declare marketplaces, the catalog cache gives kinds, and GitHub plugins resolve through one tree call', async () => {
		const cwd = tree({
			'.claude/settings.json': JSON.stringify({ extraKnownMarketplaces: { team: { source: { source: 'github', repo: 'acme/team' } }, shared: { source: { source: 'github', repo: 'acme/shared' } } } }),
			'.claude/settings.local.json': JSON.stringify({ extraKnownMarketplaces: { mine: { source: { source: 'directory', path: './market' } } } }),
			'market/.claude-plugin/marketplace.json': JSON.stringify({ name: 'mine', plugins: [{ name: 'tool', source: './tool' }] }),
			'market/tool/commands/go.md': 'Go.',
		});
		const team = tree({
			'.claude-plugin/marketplace.json': JSON.stringify({ name: 'team', plugins: [{ name: 'guard', source: './guard' }] }),
			'guard/agents/checker.md': 'An agent.',
		});
		const config = tree({
			'plugins/known_marketplaces.json': JSON.stringify({ team: { source: { source: 'github', repo: 'acme/team' }, installLocation: team } }),
			'plugins/installed_plugins.json': JSON.stringify({
				version: 2, plugins: {
					'guard@team': [{ scope: 'project', projectPath: join(tmpdir(), 'elsewhere'), installPath: join(team, 'guard') }],
					'tool@mine': [{ scope: 'local', projectPath: cwd, installPath: join(cwd, 'market', 'tool'), version: '1.0.0' }],
				},
			}),
			'plugins/plugin-catalog-cache.json': JSON.stringify({ catalog: { plugins: { 'cached@shared': { components: { skills: [{ name: 's', chars: 10 }], agents: [], hooks: ['PreToolUse'], mcpServers: [] } } } } }),
		});
		const shared = 'https://api.github.com/repos/acme/shared/git/trees/HEAD?recursive=1';
		const responses: Record<string, (etag: string | undefined) => ClaudeCatalogFetchResult> = {
			'https://raw.githubusercontent.com/acme/shared/HEAD/.claude-plugin/marketplace.json': () => ({ status: 200, body: JSON.stringify({ name: 'shared', plugins: [{ name: 'cached', source: './cached' }, { name: 'remote', source: './remote' }, { name: 'private', source: { source: 'github', repo: 'acme/private' } }] }) }),
			[shared]: etag => etag === '"t1"' ? { status: 304 } : { status: 200, etag: '"t1"', body: JSON.stringify({ tree: [{ path: 'remote', type: 'tree' }, { path: 'remote/agents', type: 'tree' }, { path: 'remote/agents/x.md', type: 'blob' }, { path: 'remote/hooks', type: 'tree' }, { path: 'remote/hooks/hooks.json', type: 'blob' }] }) },
			'https://raw.githubusercontent.com/acme/shared/HEAD/remote/hooks/hooks.json': () => ({ status: 200, body: JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo' }] }] } }) }),
		};
		const calls: string[] = [];
		const reader = new ClaudePluginCatalogReader({ configDirectory: config, fetch: async (url, etag) => { calls.push(etag ? `${url} ${etag}` : url); return responses[url]?.(etag) ?? { status: 404 }; } });

		const catalog = await reader.getCatalog({ builtIn: false, cwd });
		const resolved = await reader.resolveKinds(['remote@shared', 'private@shared', 'cached@shared', 'tool@mine', 'missing@shared'], { builtIn: false, cwd });
		const again = await reader.getCatalog({ builtIn: false, cwd });
		await reader.getCatalog({ builtIn: false, cwd, refresh: true });
		const afterRefresh = await reader.resolveKinds(['remote@shared'], { builtIn: false, cwd });
		const installed = async (folder: string | undefined) => (await reader.getInstalled(folder)).map(plugin => `${plugin.id} ${plugin.scope} ${claudePluginKinds(plugin.contents).join(',')}`);
		assert.deepStrictEqual({
			marketplaces: catalog.marketplaces,
			plugins: catalog.plugins.map(plugin => `${plugin.id} ${plugin.installed?.scope ?? '-'} ${knownClaudePluginKinds(plugin)?.join(',') ?? '?'}`),
			resolved,
			again: again.plugins.map(plugin => `${plugin.id} ${knownClaudePluginKinds(plugin)?.join(',') ?? '?'}`),
			afterRefresh,
			calls: calls.filter(url => url.startsWith('https://api.github.com/')),
			installed: await installed(cwd),
			installedElsewhere: await installed(undefined),
		}, {
			marketplaces: [
				{ name: 'team', source: 'acme/team', added: true, builtIn: false, declaredIn: 'project', pluginCount: 1 },
				{ name: 'shared', source: 'acme/shared', added: false, builtIn: false, declaredIn: 'project', pluginCount: 3 },
				{ name: 'mine', source: './market', added: false, builtIn: false, declaredIn: 'local', pluginCount: 1 },
			],
			plugins: ['guard@team - subagents', 'cached@shared - skills,hooks', 'remote@shared - ?', 'private@shared - ?', 'tool@mine local commands'],
			resolved: { 'remote@shared': ['subagents', 'hooks'], 'cached@shared': ['skills', 'hooks'], 'tool@mine': ['commands'] },
			again: ['guard@team subagents', 'cached@shared skills,hooks', 'remote@shared subagents,hooks', 'private@shared ?', 'tool@mine commands'],
			afterRefresh: { 'remote@shared': ['subagents', 'hooks'] },
			calls: [shared, 'https://api.github.com/repos/acme/private/git/trees/HEAD?recursive=1', `${shared} "t1"`],
			installed: ['tool@mine local commands'],
			installedElsewhere: [],
		});
	});

	test('kinds are the catalog cache and the files together, and plugin.json paths are followed as a string or an array (issue 535)', async () => {
		const cwd = tree({
			'.claude/settings.json': JSON.stringify({ extraKnownMarketplaces: { shared: { source: { source: 'github', repo: 'acme/shared' } } } }),
		});
		// Claude Code's cache lists Supabase's skills but none of its MCP servers.
		const config = tree({
			'plugins/plugin-catalog-cache.json': JSON.stringify({
				catalog: {
					plugins: {
						'supabase@shared': { components: { skills: [{ name: 'supabase' }, { name: 'postgres' }], agents: [], commands: [], hooks: [], mcpServers: [] } },
						'hosted@shared': { components: { skills: [{ name: 's' }], mcpServers: [] } },
					},
				},
			}),
		});
		const supabase = 'https://raw.githubusercontent.com/supabase-community/supabase-plugin/f3f332e0/';
		const paths = 'https://raw.githubusercontent.com/acme/shared/HEAD/paths/';
		const responses: Record<string, ClaudeCatalogFetchResult> = {
			'https://raw.githubusercontent.com/acme/shared/HEAD/.claude-plugin/marketplace.json': {
				status: 200, body: JSON.stringify({
					name: 'shared', plugins: [
						{ name: 'supabase', source: { source: 'github', repo: 'supabase-community/supabase-plugin', sha: 'f3f332e0' } },
						{ name: 'paths', source: './paths' },
						{ name: 'hosted', source: { source: 'url', url: 'https://git.example/hosted.git' } },
					],
				}),
			},
			'https://api.github.com/repos/supabase-community/supabase-plugin/git/trees/f3f332e0?recursive=1': {
				status: 200, body: JSON.stringify({
					tree: ['.claude-plugin/plugin.json', 'skills/supabase/SKILL.md', 'skills/postgres/SKILL.md', 'agents/claude/.mcp.json'].map(path => ({ path, type: 'blob' }))
						.concat(['.claude-plugin', 'skills', 'skills/supabase', 'skills/postgres', 'agents', 'agents/claude'].map(path => ({ path, type: 'tree' }))),
				}),
			},
			[`${supabase}.claude-plugin/plugin.json`]: { status: 200, body: JSON.stringify({ name: 'supabase', skills: './skills/', mcpServers: './agents/claude/.mcp.json' }) },
			[`${supabase}agents/claude/.mcp.json`]: { status: 200, body: JSON.stringify({ mcpServers: { supabase: { type: 'http', url: 'https://mcp.supabase.com/mcp' } } }) },
			'https://api.github.com/repos/acme/shared/git/trees/HEAD?recursive=1': {
				status: 200, body: JSON.stringify({
					tree: ['paths/.claude-plugin/plugin.json', 'paths/roles/checker.md', 'paths/extra/run.md', 'paths/config/hooks.json', 'paths/servers/one.json', 'paths/servers/two.json'].map(path => ({ path, type: 'blob' }))
						.concat(['paths', 'paths/.claude-plugin', 'paths/roles', 'paths/extra', 'paths/config', 'paths/servers'].map(path => ({ path, type: 'tree' }))),
				}),
			},
			[`${paths}.claude-plugin/plugin.json`]: { status: 200, body: JSON.stringify({ name: 'paths', agents: ['./roles/'], commands: ['./extra/run.md'], hooks: './config/hooks.json', mcpServers: ['./servers/one.json', './servers/two.json'] }) },
			[`${paths}config/hooks.json`]: { status: 200, body: JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo' }] }] } }) },
			[`${paths}servers/two.json`]: { status: 200, body: JSON.stringify({ two: { command: 'npx', args: ['two'] } }) },
		};
		const reader = new ClaudePluginCatalogReader({ configDirectory: config, fetch: async url => responses[url] ?? { status: 404 } });
		const request = { builtIn: false, cwd };
		const listed = async () => (await reader.getCatalog(request)).plugins.map(plugin => `${plugin.id} ${knownClaudePluginKinds(plugin)?.join(',') ?? '?'}${plugin.kindsPartial ? ' (partial)' : ''}`);

		const before = await listed();
		const resolved = await reader.resolveKinds(['supabase@shared', 'paths@shared', 'hosted@shared'], request);
		assert.deepStrictEqual({ before, resolved, after: await listed() }, {
			before: ['supabase@shared skills (partial)', 'paths@shared ?', 'hosted@shared skills'],
			resolved: { 'supabase@shared': ['skills', 'mcp'], 'paths@shared': ['subagents', 'commands', 'hooks', 'mcp'], 'hosted@shared': ['skills'] },
			after: ['supabase@shared skills,mcp', 'paths@shared subagents,commands,hooks,mcp', 'hosted@shared skills'],
		});
	});

	test('a team marketplace in the project settings turns plugins on by default, and managed settings make them required (issue 523)', async () => {
		const market = tree({
			'.claude-plugin/marketplace.json': JSON.stringify({ name: 'acme', plugins: [{ name: 'lint', source: './lint' }, { name: 'guard', source: './guard' }, { name: 'docs', source: './docs' }, { name: 'extra', source: './extra' }] }),
		});
		const policy = tree({
			'.claude-plugin/marketplace.json': JSON.stringify({ name: 'policy', plugins: [{ name: 'audit', source: './audit' }] }),
		});
		const managed = tree({
			'managed-settings.json': JSON.stringify({ extraKnownMarketplaces: { policy: { source: { source: 'directory', path: policy } } }, enabledPlugins: { 'guard@acme': true, 'audit@policy': true, 'docs@acme': true } }),
			'managed-settings.d/50-later.json': JSON.stringify({ enabledPlugins: { 'docs@acme': false } }),
			'managed-settings.d/notes.txt': '{ "enabledPlugins": { "extra@acme": true } }',
		});
		const cwd = tree({
			'.claude/settings.json': JSON.stringify({ extraKnownMarketplaces: { acme: { source: { source: 'directory', path: market } }, policy: { source: { source: 'directory', path: policy } } }, enabledPlugins: { 'lint@acme': true, 'guard@acme': true, 'docs@acme': true, 'extra@acme': 'yes' } }),
			'.claude/settings.local.json': JSON.stringify({ enabledPlugins: { 'extra@acme': true } }),
		});
		const config = tree({ 'plugins/known_marketplaces.json': '{}' });
		const read = async (managedDirectory: string | undefined, folder: string | undefined) => {
			const catalog = await new ClaudePluginCatalogReader({ configDirectory: config, fetch: async () => ({ status: 404 }), managedDirectory }).getCatalog({ builtIn: false, cwd: folder });
			return [...catalog.marketplaces.map(marketplace => `${marketplace.name} ${marketplace.declaredIn ?? '-'}`), ...catalog.plugins.map(plugin => `${plugin.id} ${plugin.policy ?? '-'}`)];
		};
		assert.deepStrictEqual({
			team: await read(managed, cwd),
			noManaged: await read(undefined, cwd),
			untrusted: await read(managed, undefined),
		}, {
			team: ['policy managed', 'acme project', 'audit@policy required', 'lint@acme defaultOn', 'guard@acme required', 'docs@acme defaultOn', 'extra@acme -'],
			noManaged: ['acme project', 'policy project', 'lint@acme defaultOn', 'guard@acme defaultOn', 'docs@acme defaultOn', 'extra@acme -', 'audit@policy -'],
			untrusted: ['policy managed', 'audit@policy required'],
		});
	});

	test('a plugin to try is used in place on disk, copied from GitHub byte for byte into the trial folder, and refused when a file is missing', async () => {
		const market = tree({
			'.claude-plugin/marketplace.json': JSON.stringify({ name: 'mine', plugins: [{ name: 'tool', source: './tool' }] }),
			'tool/commands/go.md': 'Go.',
		});
		const trials = tree({ 'shared/remote/stale.md': 'From an older try.' });
		const cwd = tree({
			'.claude/settings.json': JSON.stringify({ extraKnownMarketplaces: { shared: { source: { source: 'github', repo: 'acme/shared' } }, mine: { source: { source: 'directory', path: market } } } }),
		});
		const config = tree({});
		const raw = 'https://raw.githubusercontent.com/acme/shared/HEAD/';
		const responses: Record<string, ClaudeCatalogFetchResult> = {
			[`${raw}.claude-plugin/marketplace.json`]: { status: 200, body: JSON.stringify({ name: 'shared', plugins: [{ name: 'remote', source: './remote' }, { name: 'broken', source: './broken' }] }) },
			'https://api.github.com/repos/acme/shared/git/trees/HEAD?recursive=1': { status: 200, body: JSON.stringify({ tree: [{ path: 'remote', type: 'tree' }, { path: 'remote/.claude-plugin/plugin.json', type: 'blob' }, { path: 'remote/hooks/hooks.json', type: 'blob' }, { path: 'remote/assets/logo.png', type: 'blob' }, { path: 'broken/a.md', type: 'blob' }] }) },
		};
		// Not UTF-8: a lone continuation byte, an invalid lead byte, a NUL and a byte-order mark.
		const binary = [0x89, 0x50, 0x4e, 0x47, 0x80, 0xc3, 0x28, 0x00, 0xff, 0xfe];
		const files: Record<string, VSBuffer> = {
			[`${raw}remote/.claude-plugin/plugin.json`]: VSBuffer.fromString('{"name":"remote"}'),
			[`${raw}remote/hooks/hooks.json`]: VSBuffer.fromString('{"hooks":{}}'),
			[`${raw}remote/assets/logo.png`]: VSBuffer.wrap(Uint8Array.from(binary)),
		};
		const reader = new ClaudePluginCatalogReader({
			configDirectory: config,
			trialDirectory: trials,
			fetch: async url => responses[url] ?? { status: 404 },
			fetchBytes: async url => files[url] ? { status: 200, body: files[url] } : { status: 404 },
		});

		const local = await reader.preparePluginTrial('tool@mine', { builtIn: false, cwd });
		const remote = await reader.preparePluginTrial('remote@shared', { builtIn: false, cwd });
		const read = (path: string) => readFileSync(join(trials, path), 'utf8');
		assert.deepStrictEqual({
			local,
			remote,
			files: [read('shared/remote/.claude-plugin/plugin.json'), read('shared/remote/hooks/hooks.json')],
			binary: [...readFileSync(join(trials, 'shared', 'remote', 'assets', 'logo.png'))],
			staleGone: !existsSync(join(trials, 'shared', 'remote', 'stale.md')),
			broken: await reader.preparePluginTrial('broken@shared', { builtIn: false, cwd }),
			unknown: await reader.preparePluginTrial('missing@shared', { builtIn: false, cwd }),
		}, {
			local: join(market, 'tool'),
			remote: join(trials, 'shared', 'remote'),
			files: ['{"name":"remote"}', '{"hooks":{}}'],
			binary,
			staleGone: true,
			broken: undefined,
			unknown: undefined,
		});
	});

	test('front matter tools and CLI result lines are read as Claude Code prints them', () => {
		assert.deepStrictEqual({
			inline: readAllowedTools('---\nallowed-tools: [Read, "Bash(npm test:*)"]\n---\n'),
			none: readAllowedTools('No front matter'),
			failed: readClaudePluginCommandResult('{"command":"install","outcome":"failed","message":"Plugin \\"x\\" not found","failureCode":"not_found"}\n', true, 'stderr'),
			done: readClaudePluginCommandResult('noise\n{"command":"install","outcome":"installed","message":"Installed x"}', false, ''),
			// The shape Claude Code 2.1.296 prints, read from its bundle; not seen from a real marketplace yet.
			confirm: readClaudePluginCommandResult(`{"outcome":"failed","message":"Confirm","shownCommand":{"kind":"command_source","pluginId":"x@m","command":"curl x | sh","mode":"link","catalogRevision":"r1","sha256":"${'a'.repeat(64)}"}}`, true, ''),
			helper: readClaudePluginCommandResult(`{"outcome":"failed","message":"Confirm","shownCommand":{"kind":"entry_helper","pluginId":"x@m","command":["node","helper.js"],"archiveUrl":"https://example.com/x.tgz","catalogRevision":"r1","sha256":"${'c'.repeat(64)}"}}`, true, ''),
			noJson: readClaudePluginCommandResult('', true, 'Claude Code is not installed.'),
		}, {
			inline: ['Read', 'Bash(npm test:*)'],
			none: [],
			failed: { outcome: 'failed', message: 'Plugin "x" not found' },
			done: { outcome: 'done', message: 'Installed x' },
			confirm: { outcome: 'confirm', message: 'Confirm', shownCommand: { command: 'curl x | sh', sha256: 'a'.repeat(64), archiveUrl: undefined } },
			helper: { outcome: 'confirm', message: 'Confirm', shownCommand: { command: 'node helper.js', sha256: 'c'.repeat(64), archiveUrl: 'https://example.com/x.tgz' } },
			noJson: { outcome: 'failed', message: 'Claude Code is not installed.' },
		});
	});

	test('install, update, uninstall and marketplace changes run claude plugin with no shell, and bad commands never run', async () => {
		const calls: { args: readonly string[]; cwd: string | undefined }[] = [];
		const runtime = store.add(new ClaudeNodeRuntimeService({
			runtimePath: process.execPath,
			execFile: async (_file: string, args: readonly string[], options: ExecFileOptions) => {
				if (args[0] === '--version') {
					return { stdout: '2.1.296\n', stderr: '' };
				}
				if (args[0] === 'auth') {
					return { stdout: '{"loggedIn":true,"authMethod":"claude.ai"}', stderr: '' };
				}
				calls.push({ args, cwd: options.cwd });
				if (args[1] === 'uninstall') {
					throw Object.assign(new Error('Command failed'), { stdout: '{"outcome":"failed","message":"Plugin \\"lint\\" not found in installed plugins"}\n', stderr: '' });
				}
				return { stdout: '{"outcome":"ok","message":"Done"}\n', stderr: '' };
			},
		}));
		const results: string[] = [];
		const commands: ClaudePluginCommand[] = [
			{ action: 'install', plugin: 'lint@team', scope: 'project', cwd: '/repo' },
			{ action: 'install', plugin: 'hello', scope: 'user', marketplaceSource: 'anthropics/claude-plugins-official', acceptCommand: 'b'.repeat(64) },
			{ action: 'update', plugin: 'lint@team' },
			{ action: 'uninstall', plugin: 'lint@team', scope: 'user' },
			{ action: 'addMarketplace', source: 'acme/team' },
			{ action: 'addMarketplace', source: 'acme/shared', scope: 'project', cwd: '/repo' },
			{ action: 'removeMarketplace', name: 'team' },
		];
		for (const command of commands) {
			results.push((await runtime.runPluginCommand(command)).outcome);
		}
		const refused: string[] = [];
		for (const bad of [
			{ action: 'install', plugin: '--help', scope: 'user' },
			{ action: 'install', plugin: 'a@b', scope: 'user', marketplaceSource: 'acme/team' },
			{ action: 'addMarketplace', source: '--scope=project' },
			{ action: 'addMarketplace', source: 'acme/team', scope: 'everywhere' },
			{ action: 'update', plugin: 'lint', acceptCommand: 'not-a-sha' },
			{ action: 'shell', plugin: 'lint' },
		]) {
			await runtime.runPluginCommand(bad as ClaudePluginCommand).catch(error => refused.push(error.message));
		}
		assert.deepStrictEqual({ calls, results, refused: refused.length }, {
			calls: [
				{ args: ['plugin', 'install', 'lint@team', '--scope', 'project', '--json'], cwd: '/repo' },
				{ args: ['plugin', 'install', 'hello', '--scope', 'user', '--json', '--marketplace', 'anthropics/claude-plugins-official', '--accept-command', 'b'.repeat(64)], cwd: undefined },
				{ args: ['plugin', 'update', 'lint@team', '--json'], cwd: undefined },
				{ args: ['plugin', 'uninstall', 'lint@team', '--scope', 'user', '--json'], cwd: undefined },
				{ args: ['plugin', 'marketplace', 'add', 'acme/team', '--json'], cwd: undefined },
				{ args: ['plugin', 'marketplace', 'add', 'acme/shared', '--json', '--scope', 'project'], cwd: '/repo' },
				{ args: ['plugin', 'marketplace', 'remove', 'team', '--json'], cwd: undefined },
			],
			results: ['done', 'done', 'done', 'failed', 'done', 'done', 'done'],
			refused: 6,
		});
	});
});
