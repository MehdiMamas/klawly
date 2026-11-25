/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { GitHubRequestError } from '../../../../../platform/github/common/githubTypes.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	ReviewerChangedFile, ReviewerHistoryCommit, ReviewerSuggestionInput, assessRisk, describeReviewerReason, describeRisk, filesForHistory, ownersOf, parseChangedFiles, parseCodeOwners,
	missingRequestedReviewers, orgAccessRestriction, orgOAuthPolicyUrl, parseContentsText, parseHistory, parsePullRequestForReviewers, requestReviewersBody, reviewerRestPaths, suggestReviewers
} from '../../common/claudeReviewerSuggestions.js';

const NOW = Date.parse('2026-10-15T12:00:00Z');
const DAY = 86_400_000;

function file(path: string, additions = 10, deletions = 0): ReviewerChangedFile {
	return { path, additions, deletions };
}

function commit(path: string, login: string | undefined, daysAgo: number, bot = false): ReviewerHistoryCommit {
	return { path, login, bot, date: new Date(NOW - daysAgo * DAY).toISOString() };
}

function input(extra: Partial<ReviewerSuggestionInput>): ReviewerSuggestionInput {
	return { author: 'author', files: [file('src/a.ts'), file('src/b.ts')], codeOwners: undefined, history: [], alreadyRequested: [], now: NOW, ...extra };
}

suite('Klawly reviewer suggestions (issues 508, 870)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('CODEOWNERS: the last matching rule wins, patterns anchor, directories own what is below, an empty rule clears', () => {
		const rules = parseCodeOwners([
			'# comment',
			'* @everyone',
			'/src/ @core @acme/platform',
			'*.md @docs',
			'/src/generated/ ',
			'build/ owner@example.com @builder',
			'',
		].join('\n'));
		assert.deepStrictEqual({
			root: ownersOf(rules, 'README.md'),
			src: ownersOf(rules, 'src/a.ts'),
			generated: ownersOf(rules, 'src/generated/x.ts'),
			nestedMd: ownersOf(rules, 'src/readme.md'),
			unanchoredDir: ownersOf(rules, 'packages/x/build/out.js'),
			other: ownersOf(rules, 'lib/z.ts'),
		}, {
			root: ['docs'],
			src: ['core', 'acme/platform'],
			generated: [],
			nestedMd: ['docs'],
			unanchoredDir: ['builder'],
			other: ['everyone'],
		});
	});

	test('no CODEOWNERS and no history: nobody is suggested, the risk note is still there', () => {
		assert.deepStrictEqual(suggestReviewers(input({})), {
			reviewers: [],
			risk: { level: 'low', factors: ['noTests'], areas: [], lines: 20, files: 2 },
		});
	});

	test('owners rank before history; history ranks by files, commits, then the latest commit', () => {
		const result = suggestReviewers(input({
			codeOwners: '/src/a.ts @owner',
			history: [
				commit('src/a.ts', 'busy', 10), commit('src/a.ts', 'busy', 20), commit('src/b.ts', 'busy', 30),
				commit('src/a.ts', 'once', 5),
				commit('src/b.ts', 'owner', 400),
			],
		}));
		assert.deepStrictEqual(result.reviewers, [
			{ login: 'owner', team: false, ownedFiles: 1, historyFiles: 0, commits: 0, lastCommit: undefined },
			{ login: 'busy', team: false, ownedFiles: 0, historyFiles: 2, commits: 3, lastCommit: new Date(NOW - 10 * DAY).toISOString() },
			{ login: 'once', team: false, ownedFiles: 0, historyFiles: 1, commits: 1, lastCommit: new Date(NOW - 5 * DAY).toISOString() },
		]);
	});

	test('a tie on everything breaks by the latest commit, then by login, and only three are named', () => {
		const sameDay = (path: string, login: string) => commit(path, login, 3);
		const result = suggestReviewers(input({
			history: [
				sameDay('src/a.ts', 'zed'), sameDay('src/a.ts', 'Amy'), sameDay('src/a.ts', 'mia'), sameDay('src/a.ts', 'bob'),
				commit('src/a.ts', 'newest', 1),
			],
		}));
		assert.deepStrictEqual(result.reviewers.map(reviewer => reviewer.login), ['newest', 'Amy', 'bob']);
	});

	test('the author, people already asked, bots and unmapped commits are never suggested; old history does not count', () => {
		const result = suggestReviewers(input({
			author: 'Author',
			alreadyRequested: ['asked', 'acme/platform'],
			codeOwners: '* @author @asked @acme/platform @dependabot[bot]',
			history: [
				commit('src/a.ts', 'author', 1), commit('src/a.ts', 'asked', 1), commit('src/a.ts', 'robot', 1, true),
				commit('src/a.ts', 'ci[bot]', 1), commit('src/a.ts', undefined, 1), commit('src/a.ts', 'ancient', 400),
				commit('src/a.ts', 'future', -2),
			],
		}));
		assert.deepStrictEqual(result.reviewers, []);
	});

	test('a team owner is named by org/team', () => {
		const result = suggestReviewers(input({ codeOwners: '/src/ @acme/platform' }));
		assert.deepStrictEqual(result.reviewers.map(reviewer => [reviewer.login, reviewer.team, reviewer.ownedFiles]), [['acme/platform', true, 2]]);
	});

	test('the same input gives the same output, whatever order the history arrives in', () => {
		const history = [commit('src/a.ts', 'x', 3), commit('src/b.ts', 'y', 3), commit('src/a.ts', 'z', 3), commit('src/b.ts', 'x', 9)];
		const first = suggestReviewers(input({ history }));
		const again = suggestReviewers(input({ history }));
		const reversed = suggestReviewers(input({ history: [...history].reverse() }));
		assert.deepStrictEqual({ again, reversed }, { again: first, reversed: first });
	});

	test('risk: size, many files, sensitive areas and missing tests add up to Low, Medium or High', () => {
		const many = Array.from({ length: 15 }, (_, i) => file(`src/f${i}.ts`, 1));
		assert.deepStrictEqual({
			small: assessRisk([file('src/a.ts', 5), file('test/a.test.ts', 5)]).level,
			docsOnly: assessRisk([file('README.md', 500)]).level,
			sizeOnly: assessRisk([file('src/a.ts', 150), file('src/a.test.ts', 1)]),
			workflow: assessRisk([file('.github/workflows/ci.yml', 5), file('package-lock.json', 5), file('src/a.ts', 5)]),
			high: assessRisk([...many, file('.github/workflows/ci.yml', 500)]).level,
		}, {
			small: 'low',
			docsOnly: 'medium',
			sizeOnly: { level: 'low', factors: ['size'], areas: [], lines: 151, files: 2 },
			workflow: { level: 'medium', factors: ['sensitive', 'noTests'], areas: ['dependencies', 'workflows'], lines: 15, files: 3 },
			high: 'high',
		});
	});

	test('the notes read as plain sentences', () => {
		const risk = assessRisk([file('.github/workflows/ci.yml', 450)]);
		assert.deepStrictEqual({
			risk: describeRisk(risk),
			small: describeRisk(assessRisk([file('src/a.ts', 5), file('src/a.test.ts', 5)])),
			owner: describeReviewerReason({ login: 'a', team: false, ownedFiles: 2, historyFiles: 1, commits: 3, lastCommit: new Date(NOW - 12 * DAY).toISOString() }, 5, NOW),
			today: describeReviewerReason({ login: 'a', team: false, ownedFiles: 0, historyFiles: 1, commits: 1, lastCommit: new Date(NOW - 1000).toISOString() }, 5, NOW),
		}, {
			risk: 'High risk: 450 lines changed, touches workflows, no tests changed.',
			small: 'Low risk: 10 lines in 2 files, tests changed with the code.',
			owner: 'owns 2 of 5 changed files, changed 1 of them, last 12 days ago',
			today: 'changed 1 of them, last today',
		});
	});

	test('GitHub can answer 201 and still drop a reviewer; only what the answer lists was added (issue 1520)', () => {
		const answer = (users: string[], teams: string[]) => ({
			user: { login: 'me' }, base: { ref: 'main' },
			requested_reviewers: users.map(login => ({ login })),
			requested_teams: teams.map(slug => ({ slug, organization: { login: 'acme' } })),
		});
		const asked = ['Amy', 'acme/Core'];
		assert.deepStrictEqual({
			all: missingRequestedReviewers(asked, answer(['amy'], ['core'])),
			team: missingRequestedReviewers(asked, answer(['amy'], [])),
			user: missingRequestedReviewers(asked, answer([], ['core'])),
			both: missingRequestedReviewers(asked, answer([], [])),
			unparseable: missingRequestedReviewers(asked, 'nope'),
			empty: missingRequestedReviewers(asked, undefined),
		}, {
			all: [],
			team: ['acme/Core'],
			user: ['Amy'],
			both: ['Amy', 'acme/Core'],
			unparseable: [],
			empty: [],
		});
	});

	test('GitHub answers are read defensively', () => {
		const decode = (base64: string) => Buffer.from(base64, 'base64').toString('utf8');
		assert.deepStrictEqual({
			paths: reviewerRestPaths('acme', 'app', 7).codeOwners('.github/CODEOWNERS', 'main'),
			pull: parsePullRequestForReviewers({ user: { login: 'me' }, base: { ref: 'main' }, requested_reviewers: [{ login: 'a' }], requested_teams: [{ slug: 'core', organization: { login: 'acme' } }] }),
			badPull: parsePullRequestForReviewers({ base: { ref: 'main' } }),
			files: parseChangedFiles([{ filename: 'a.ts', additions: 2, deletions: 1 }, { nope: true }]),
			notFiles: parseChangedFiles({ message: 'Not Found' }),
			history: parseHistory('a.ts', [{ author: { login: 'x', type: 'User' }, commit: { author: { date: '2026-01-01T00:00:00Z' } } }, { author: null, commit: { author: { date: '2026-01-02T00:00:00Z' } } }, { commit: {} }]),
			contents: parseContentsText({ type: 'file', encoding: 'base64', content: 'KiBAYQo=\n' }, decode),
			dir: parseContentsText([], decode),
			body: requestReviewersBody(['a', 'acme/platform']),
		}, {
			paths: '/repos/acme/app/contents/.github/CODEOWNERS?ref=main',
			pull: { author: 'me', baseRef: 'main', requested: ['a', 'acme/core'] },
			badPull: undefined,
			files: [{ path: 'a.ts', additions: 2, deletions: 1 }],
			notFiles: [],
			history: [{ path: 'a.ts', login: 'x', bot: false, date: '2026-01-01T00:00:00Z' }, { path: 'a.ts', login: undefined, bot: false, date: '2026-01-02T00:00:00Z' }],
			contents: '* @a\n',
			dir: undefined,
			body: { reviewers: ['a'], team_reviewers: ['platform'] },
		});
	});

	test('history is read for the biggest changed files first, at most eight', () => {
		const files = Array.from({ length: 10 }, (_, i) => file(`f${i}.ts`, i));
		assert.deepStrictEqual(filesForHistory(files), ['f9.ts', 'f8.ts', 'f7.ts', 'f6.ts', 'f5.ts', 'f4.ts', 'f3.ts', 'f2.ts']);
	});

	test('names the organization that restricts OAuth app access (issue 1519)', () => {
		const sentence = 'Although you appear to have the correct authorization credentials, the `acme` organization has enabled OAuth App access restrictions, meaning that data access to third-parties is limited.';
		assert.deepStrictEqual({
			rest: orgAccessRestriction(new GitHubRequestError('GitHub answered 403', 'authorization', 403, JSON.stringify({ message: sentence })), 'other'),
			restMessage: orgAccessRestriction(new GitHubRequestError(sentence, 'authorization', 403), 'other'),
			graphQL: orgAccessRestriction(new GitHubRequestError('GraphQL errors', 'authorization', 200, undefined, [{ type: 'FORBIDDEN', message: 'The org has enabled OAuth App access restrictions' }]), 'queried'),
			plain403: orgAccessRestriction(new GitHubRequestError('GitHub answered 403', 'authorization', 403, '{"message":"Resource not accessible"}'), 'acme'),
			notAnError: orgAccessRestriction(new Error(sentence), 'acme'),
			policy: orgAccessRestriction(undefined, 'acme') ?? orgOAuthPolicyUrl('acme'),
		}, {
			rest: { org: 'acme' },
			restMessage: { org: 'acme' },
			graphQL: { org: 'queried' },
			plain403: undefined,
			notAnError: undefined,
			policy: 'https://github.com/organizations/acme/settings/oauth_application_policy',
		});
	});
});
