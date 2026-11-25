/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { claudeDiffWithoutIgnored } from '../../common/claudeCommitReview.js';
import { addClaudeReviewRule, removeClaudeReviewRule, claudeReviewConfigFolders, claudeReviewInstructionsWithRules, ClaudeReviewConfigLayer, describeClaudeEffectiveReviewConfig, filterClaudeFindingsByConfig, claudeRelatedReposHeader, claudeReviewRelatedRepoEntries, parseClaudeReviewConfig, readClaudeReviewConfigFile, resolveClaudeRelatedRepos, readClaudeReviewConfigLayers, resolveClaudeReviewConfig, resolveClaudeReviewConfigForFile } from '../../common/claudeReviewConfig.js';
import { claudeRelatedReposPrompt, ClaudeReviewFinding } from '../../common/claudeReviewLoop.js';

const root = JSON.stringify({
	ignore: ['**/*.generated.ts'],
	rules: [
		{ id: 'api-validate', text: 'Handlers validate input.', scope: ['src/api/**'] },
		{ id: 'no-todo', text: 'No TODO left behind.' },
	],
	disabledRules: ['style-quotes'],
	minSeverity: 'medium',
});
const api = JSON.stringify({
	rules: [{ id: 'api-validate', text: 'Handlers validate input with zod.' }],
	disabledRules: ['no-todo'],
	minSeverity: 'low',
});
const layers: ClaudeReviewConfigLayer[] = [{ folder: '', text: root }, { folder: 'src/api', text: api }];

function finding(file: string, severity: ClaudeReviewFinding['severity'], title: string): ClaudeReviewFinding {
	return { file, startLine: 1, endLine: 1, severity, category: 'bug', title, body: '' };
}

suite('Claude review config', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('parser reports clear errors and keeps the good parts', () => {
		assert.deepStrictEqual([
			parseClaudeReviewConfig('{nope').errors.length,
			parseClaudeReviewConfig('[]').errors,
			parseClaudeReviewConfig('{"ignore":"x","minSeverity":"huge","rules":[{"id":"a"},{"id":"b","text":"t"}]}'),
			parseClaudeReviewConfig(root).errors,
			readClaudeReviewConfigFile(undefined),
			readClaudeReviewConfigFile(' a/b.json '),
		], [
			1,
			['The file must hold a JSON object.'],
			{
				config: { ignore: [], rules: [{ id: 'b', text: 't', scope: undefined }], disabledRules: [], minSeverity: undefined, relatedRepos: [] },
				errors: ['Rule 1 needs an "id" and a "text".', '"minSeverity" must be one of critical, high, medium, low.', '"ignore" must be a list of non-empty strings.'],
			},
			[],
			'.claude/review.json',
			'a/b.json',
		]);
	});

	test('nearer folder wins, scopes match, ignore and disabled add up', () => {
		const strip = (value: ReturnType<typeof resolveClaudeReviewConfigForFile>) => ({ ...value, rules: value.rules.map(rule => `${rule.id}:${rule.text}`) });
		assert.deepStrictEqual([
			strip(resolveClaudeReviewConfigForFile(layers, 'src/api/user.ts')),
			strip(resolveClaudeReviewConfigForFile(layers, 'src/ui/view.ts')),
			resolveClaudeReviewConfigForFile(layers, 'src/api/x.generated.ts').ignored,
			resolveClaudeReviewConfigForFile(layers, 'src\\ui\\x.generated.ts').ignored,
			resolveClaudeReviewConfigForFile([{ folder: '', text: 'garbage' }], 'a.ts').ignored,
			claudeReviewConfigFolders('src/api/x.ts'),
		], [
			{ ignored: false, rules: ['api-validate:Handlers validate input with zod.'], disabledRules: ['style-quotes', 'no-todo'], minSeverity: 'low' },
			{ ignored: false, rules: ['no-todo:No TODO left behind.'], disabledRules: ['style-quotes'], minSeverity: 'medium' },
			true,
			true,
			false,
			['', 'src', 'src/api'],
		]);
	});

	test('ignore cuts the diff, prompt carries only matching rules, disabled findings go', () => {
		const diff = ['diff --git a/src/a.generated.ts b/src/a.generated.ts', '+gen', 'diff --git a/src/api/u.ts b/src/api/u.ts', '+code', ''].join('\n');
		const kept = claudeDiffWithoutIgnored(diff, path => resolveClaudeReviewConfigForFile(layers, path).ignored);
		const resolvedUi = resolveClaudeReviewConfig(layers, ['src/ui/v.ts']);
		const resolvedApi = resolveClaudeReviewConfig(layers, ['src/api/u.ts', 'src/ui/v.ts']);
		assert.deepStrictEqual({
			kept,
			ui: claudeReviewInstructionsWithRules('NOTES', resolvedUi),
			noRules: claudeReviewInstructionsWithRules('NOTES', resolveClaudeReviewConfig([], ['a.ts'])),
			apiRules: resolvedApi.rules.map(rule => rule.id),
			filtered: filterClaudeFindingsByConfig([
				finding('src/ui/v.ts', 'low', 'minor'),
				finding('src/ui/v.ts', 'high', 'big'),
				finding('src/ui/v.ts', 'high', '[style-quotes] quotes'),
				finding('src/api/u.ts', 'low', 'minor in api'),
				finding('src/ui/v.ts', 'critical', 'boom'),
			], resolvedApi).map(f => f.title),
			describe: describeClaudeEffectiveReviewConfig(layers, 'src/api/u.ts').split('\n'),
		}, {
			kept: ['diff --git a/src/api/u.ts b/src/api/u.ts', '+code', ''].join('\n'),
			ui: 'NOTES\n\nAlso check these rules. When a finding comes from a rule, start its title with the rule ID in square brackets, like [rule-id].\n- [no-todo]: No TODO left behind.\nDo not report problems for these rule IDs: style-quotes.',
			noRules: 'NOTES',
			apiRules: ['api-validate'],
			filtered: ['big', 'minor in api', 'boom'],
			describe: ['Review config for src/api/u.ts', 'Minimum severity: low', 'Rules:', '- api-validate: Handlers validate input with zod.', 'Turned off: style-quotes, no-todo'],
		});
	});

	test('layers are read from the root down to the file and the effective config is described', async () => {
		const files: Record<string, string> = { '.claude/review.json': root, 'src/api/.claude/review.json': api };
		const asked: string[] = [];
		const read = async (path: string) => {
			asked.push(path);
			return files[path];
		};
		const found = await readClaudeReviewConfigLayers(['src/api/u.ts'], '.claude/review.json', read);
		assert.deepStrictEqual({
			asked,
			folders: found.map(layer => layer.folder),
			text: describeClaudeEffectiveReviewConfig(found, 'src/api/u.ts').split('\n')[1],
		}, {
			asked: ['.claude/review.json', 'src/.claude/review.json', 'src/api/.claude/review.json'],
			folders: ['', 'src/api'],
			text: 'Minimum severity: low',
		});
	});

	test('relatedRepos parse, canonicalize and refuse in an untrusted workspace', () => {
		const parsed = parseClaudeReviewConfig('{"relatedRepos":["../api","/abs/web",""]}');
		const real = new Map([['/ws', '/ws'], ['/api', '/api'], ['/abs/web', '/abs/web'], ['/link', '/api']]);
		const canonical = (path: string) => real.get(path);
		const entries = ['/api', '/abs/web', '/link', '/ws', '/nope', '/abs/web'];
		assert.deepStrictEqual({
			parsedErrors: parsed.errors.length,
			parsed: parseClaudeReviewConfig('{"relatedRepos":["../api","/abs/web"]}').config.relatedRepos,
			layers: claudeReviewRelatedRepoEntries([{ folder: '', text: '{"relatedRepos":["a","b"]}' }, { folder: 'x', text: '{"relatedRepos":["b","c"]}' }]),
			trusted: resolveClaudeRelatedRepos(entries, '/ws', true, canonical, false),
			untrusted: resolveClaudeRelatedRepos(entries.slice(0, 2), '/ws', false, canonical, false),
			caseInsensitive: resolveClaudeRelatedRepos(['/API'], '/ws', true, p => p.toLowerCase() === '/api' ? '/API' : p === '/ws' ? '/ws' : undefined, true),
			header: [claudeRelatedReposHeader([]), claudeRelatedReposHeader(['/a', '/b'])],
			prompt: claudeRelatedReposPrompt([]).length,
		}, {
			parsedErrors: 1,
			parsed: ['../api', '/abs/web'],
			layers: ['a', 'b', 'c'],
			trusted: {
				directories: ['/api', '/abs/web'],
				refused: [{ entry: '/link', reason: 'duplicate' }, { entry: '/ws', reason: 'workspace' }, { entry: '/nope', reason: 'missing' }, { entry: '/abs/web', reason: 'duplicate' }],
			},
			untrusted: { directories: [], refused: [{ entry: '/api', reason: 'untrusted' }, { entry: '/abs/web', reason: 'untrusted' }] },
			caseInsensitive: { directories: ['/API'], refused: [] },
			header: [undefined, 'Also read: /a, /b'],
			prompt: 0,
		});
	});
	test('adding and removing a rule keeps the other keys and never overwrites bad text', () => {
		const start = JSON.stringify({ ignore: ['a'], rules: [{ id: 'x', text: 'X' }], minSeverity: 'low' });
		const added = addClaudeReviewRule(start, { id: 'learned-y', text: 'Y' });
		const replaced = addClaudeReviewRule(added, { id: 'learned-y', text: 'Y2' });
		assert.deepStrictEqual({
			added: added && JSON.parse(added),
			replaced: replaced && parseClaudeReviewConfig(replaced).config.rules.map(rule => rule.text),
			removed: removeClaudeReviewRule(added, 'learned-y') === JSON.stringify(JSON.parse(start), undefined, '\t') + '\n',
			fresh: addClaudeReviewRule(undefined, { id: 'a', text: 'A' }) === JSON.stringify({ rules: [{ id: 'a', text: 'A' }] }, undefined, '\t') + '\n',
			bad: [addClaudeReviewRule('{nope', { id: 'a', text: 'A' }), addClaudeReviewRule('[]', { id: 'a', text: 'A' })],
		}, {
			added: { ignore: ['a'], rules: [{ id: 'x', text: 'X' }, { id: 'learned-y', text: 'Y' }], minSeverity: 'low' },
			replaced: ['X', 'Y2'],
			removed: true,
			fresh: true,
			bad: [undefined, undefined],
		});
	});
});
