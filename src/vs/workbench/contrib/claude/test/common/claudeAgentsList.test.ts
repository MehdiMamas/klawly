/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Codicon } from '../../../../../base/common/codicons.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ElicitationEntry, PermissionEntry, ToolCardModel, TurnStatus, TurnViewModel } from '../../../../services/claude/common/claudeAgentState.js';
import { applyClaudeAgentRowOrder, ClaudeAgentRowInput, claudeImportedSessionInput, claudeMachineBadgeHover, groupClaudeAgentRows, moveClaudeAgentRow, readClaudeSessionListLocation } from '../../common/claudeAgentsList.js';

const HOUR = 60 * 60 * 1000;
// 2026-10-07 15:00 local time.
const NOW = new Date(2026, 9, 7, 15, 0, 0).getTime();

function turn(status: TurnStatus, extra: { cards?: Partial<ToolCardModel>[]; permissions?: Partial<PermissionEntry>[]; changedFiles?: string[]; text?: string } = {}): TurnViewModel {
	return {
		id: `turn-${status}`,
		user: { text: extra.text ?? 'do the thing' },
		assistantText: '',
		status,
		cards: (extra.cards ?? []) as ToolCardModel[],
		changedFiles: extra.changedFiles ?? [],
		permissions: (extra.permissions ?? []) as PermissionEntry[],
		segmentOpen: false,
		segmentStart: 0,
		steered: [],
	};
}

function session(id: string, hoursAgo: number, turns: TurnViewModel[], extra: Partial<ClaudeAgentRowInput> = {}): ClaudeAgentRowInput {
	return { id, title: id, updatedAt: NOW - hoursAgo * HOUR, turns, ...extra };
}

suite('Claude agents column rows', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const inputs: ClaudeAgentRowInput[] = [
		session('editing', 30, [turn('running', { cards: [{ kind: 'file', verb: 'Read', state: 'success', target: 'a.ts' }, { kind: 'edit', verb: 'Editing', state: 'running', file: '/repo/src/todo.ts', target: 'src/todo.ts' }] })]),
		session('asking', 50, [turn('running', { permissions: [{ state: 'allowed' }, { state: 'pending' }] })]),
		session('thinking', 0.5, [turn('running')]),
		session('fixed', 1, [turn('complete', { changedFiles: ['a.ts'] }), turn('complete', { changedFiles: ['a.ts', 'b.ts'] })]),
		session('chatted', 2, [turn('complete', { text: 'explain the reducer' })], { workspaceName: 'shop' }),
		session('broken', 26, [turn('failed')]),
		session('halted', 27, [turn('stopped')]),
		session('crashed', 24 * 3, [turn('complete')], { interrupted: true }),
		session('empty', 24 * 30, []),
		session('worktree', 3, [turn('complete')], { background: { status: 'complete', filesChanged: 2, added: 14, removed: 3 } }),
		session('spawning', 4, [], { background: { status: 'starting', filesChanged: 0, added: 0, removed: 0 } }),
	];

	function summary(query = '', filter: 'all' | 'local' | 'background' = 'all') {
		return groupClaudeAgentRows(inputs, NOW, query, filter).map(group => [group.label, group.rows.map(row => `${row.title} | ${row.state} | ${row.subtitle ?? ''}${row.background ? ' | bg' : ''}`)]);
	}

	test('chats another project handed work to sit in a Departments group, waiting first, with a badge (1177)', () => {
		const handoff = (text: string) => `From shop chat. This is a hand-off from another project's chat, not a worker: nobody waits for a reply.

${text}`;
		const list = [
			session('plain', 1, [turn('complete')]),
			session('quiet', 2, [turn('complete', { text: handoff('fix the cart') })]),
			session('asks', 5, [turn('running', { text: handoff('rename api'), permissions: [{ state: 'pending' }] })]),
		];
		const groups = groupClaudeAgentRows(list, NOW, '', 'all');
		assert.deepStrictEqual(groups.map(group => [group.id, group.label, group.badge, group.rows.map(row => row.title)]), [
			['departments', 'Departments', 1, ['asks', 'quiet']],
			['today', 'Today', undefined, ['plain']],
		]);
	});

	test('Departments is a timeline by hand-off time, and its badge counts unread hand-offs (1459)', () => {
		const handoff = (text: string) => `From shop chat. This is a hand-off from another project's chat, not a worker: nobody waits for a reply.

${text}`;
		const list = [
			{ ...session('old', 9, [turn('complete', { text: handoff('a') })]), handoff: { at: 100, read: true } },
			{ ...session('new', 1, [turn('complete', { text: handoff('b') })]), handoff: { at: 300, read: false } },
			{ ...session('mid', 2, [turn('complete', { text: handoff('c') })]), handoff: { at: 200, read: false } },
		];
		const group = groupClaudeAgentRows(list, NOW, '', 'all')[0];
		assert.deepStrictEqual([group.rows.map(row => [row.title, row.unread]), group.unread], [[['new', true], ['mid', true], ['old', undefined]], 2]);
	});

	test('rows say what each agent is doing, grouped by day with live agents first', () => {
		assert.deepStrictEqual(summary(), [
			['Today', [
				'editing | running | Editing todo.ts',
				'asking | waiting | Waiting for your approval',
				'thinking | running | Working...',
				'spawning | running | Starting... | bg',
				'fixed | done | Edited 2 files',
				'chatted | done | ',
				'worktree | done | +14 −3 · 2 files | bg',
			]],
			['Yesterday', [
				'broken | failed | Failed',
				'halted | stopped | Stopped',
			]],
			['Previous 7 Days', [
				'crashed | interrupted | Interrupted',
			]],
			['Older', [
				'empty | idle | ',
			]],
		]);
	});

	test('search reads the title, workspace and first prompt; the filter splits local from background', () => {
		assert.deepStrictEqual({
			prompt: summary('REDUCER'),
			workspace: summary('shop'),
			background: summary('', 'background'),
			localCount: summary('', 'local').flatMap(([, rows]) => rows).length,
			none: summary('nothing matches this'),
		}, {
			prompt: [['Today', ['chatted | done | ']]],
			workspace: [['Today', ['chatted | done | ']]],
			background: [['Today', ['spawning | running | Starting... | bg', 'worktree | done | +14 −3 · 2 files | bg']]],
			localCount: 9,
			none: [],
		});
	});

	test('issue 425: a row says where its agent runs after what it did', () => {
		const rows = groupClaudeAgentRows([
			session('remote', 1, [turn('complete', { changedFiles: ['a.ts', 'b.ts'] })], { target: { kind: 'ssh', label: 'build-box' } }),
			session('container', 2, [turn('complete')], { target: { kind: 'devcontainer', label: 'Dev Container' } }),
			session('here', 3, [turn('complete')], { target: { kind: 'local', label: 'Local' } }),
		], NOW, '', 'all').flatMap(group => group.rows.map(row => row.subtitle));
		assert.deepStrictEqual(rows, ['Edited 2 files · on build-box', 'in dev container', undefined]);
	});

	test('issue 1220: an Auto row adds the model and live cost; Failed gives its reason', () => {
		const rows = groupClaudeAgentRows([
			session('working', 1, [turn('running', { cards: [{ kind: 'edit', verb: 'Editing', state: 'running', file: '/repo/a.ts', target: 'a.ts' }] })], { auto: { modelLabel: 'Sonnet', costUsd: 1.87 } }),
			session('broke', 2, [turn('failed')], { auto: { modelLabel: 'Sonnet', costUsd: 0.5, failureReason: 'Tests failed twice' } }),
			session('mystery', 3, [turn('failed')], { auto: {} }),
		], NOW, '', 'all').flatMap(group => group.rows.map(row => row.subtitle));
		assert.deepStrictEqual(rows, ['Editing a.ts · Sonnet · $1.87', 'Failed: Tests failed twice · Sonnet · $0.50', 'Failed: No reason was reported']);
	});

	test('issue 448: an imported session becomes a read-only row with its machine, and Local Agents leaves it out', () => {
		const synced = claudeImportedSessionInput({ machine: 'Desktop', id: 'Desktop/proj/abc', title: ' port the parser ', updatedAt: NOW - HOUR });
		const blank = claudeImportedSessionInput({ machine: 'Desktop', id: 'Desktop/proj/def', title: '  ', updatedAt: NOW - 2 * HOUR });
		const all = (filter: 'all' | 'local') => groupClaudeAgentRows([synced, blank, session('mine', 3, [turn('complete')])], NOW, '', filter).flatMap(group => group.rows.map(row => [row.id, row.title, row.machine]));
		assert.deepStrictEqual({ all: all('all'), local: all('local') }, {
			all: [['imported:Desktop/proj/abc', 'port the parser', 'Desktop'], ['imported:Desktop/proj/def', 'Synced session', 'Desktop'], ['mine', 'mine', undefined]],
			local: [['mine', 'mine', undefined]],
		});
	});

	test('issue 448: a session synced from another machine carries that machine for its badge and hover', () => {
		const rows = groupClaudeAgentRows([
			session('local', 2, [turn('complete')]),
			session('synced', 3, [turn('complete')], { importedFrom: ' Desktop ' }),
		], NOW, '', 'all').flatMap(group => group.rows.map(row => [row.id, row.machine]));
		assert.deepStrictEqual(rows, [['local', undefined], ['synced', 'Desktop']]);
		assert.strictEqual(claudeMachineBadgeHover('Desktop'), 'Synced from Desktop');
	});

	test('issue 426: an automation lists its runs under its name, after the day groups, the one that ran last first', () => {
		const daily = { key: 'workspace:daily-notes', name: 'Daily notes', icon: Codicon.watch };
		const lint = { key: 'user:lint-on-save', name: 'Lint on save', icon: Codicon.save };
		const done = { status: 'complete' as const, filesChanged: 1, added: 4, removed: 0 };
		const runs = [
			session('chatted', 2, [turn('complete')]),
			session('notes monday', 24 * 4, [turn('complete')], { background: done, automation: daily }),
			session('notes tuesday', 24 * 3, [turn('complete')], { background: done, automation: daily }),
			session('lint a.ts', 1, [turn('failed')], { background: { ...done, status: 'failed' }, automation: lint }),
		];
		const shape = (query: string) => groupClaudeAgentRows(runs, NOW, query, 'all').map(group => [group.id, group.label, group.icon?.id ?? '', group.rows.map(row => row.title)]);
		assert.deepStrictEqual({ all: shape(''), search: shape('daily'), local: groupClaudeAgentRows(runs, NOW, '', 'local').map(group => group.id) }, {
			all: [
				['today', 'Today', '', ['chatted']],
				['automation:user:lint-on-save', 'Lint on save', 'save', ['lint a.ts']],
				['automation:workspace:daily-notes', 'Daily notes', 'watch', ['notes tuesday', 'notes monday']],
			],
			search: [['automation:workspace:daily-notes', 'Daily notes', 'watch', ['notes tuesday', 'notes monday']]],
			local: ['today'],
		});
	});

	test('issue 899: a project lists its coordinator and agents under its name, after the day groups and before automations', () => {
		const dark = { key: 'add-dark-mode.json', name: 'Add dark mode' };
		const runs = [
			session('chatted', 2, [turn('complete')]),
			session('coordinator', 3, [turn('complete')], { project: dark }),
			session('build settings', 4, [turn('complete')], { project: dark }),
		];
		const shape = (query: string) => groupClaudeAgentRows(runs, NOW, query, 'all').map(group => [group.id, group.label, group.icon?.id ?? '', group.rows.map(row => row.title)]);
		assert.deepStrictEqual({ all: shape(''), search: shape('dark') }, {
			all: [
				['today', 'Today', '', ['chatted']],
				['project:add-dark-mode.json', 'Add dark mode', 'project', ['coordinator', 'build settings']],
			],
			search: [['project:add-dark-mode.json', 'Add dark mode', 'project', ['coordinator', 'build settings']]],
		});
	});

	test('issue 532: a cloud session Klawly started or messaged lists as Cloud, and only the Cloud filter splits it out', () => {
		const rows = [
			session('local chat', 1, [turn('complete')]),
			session('cloud:start-a1', 2, [], { title: 'Fix the flaky test', runTarget: 'cloud' }),
			session('cloud:session_abc', 30, [], { title: 'also update the docs', runTarget: 'cloud', cloudSessionId: 'session_abc' }),
			session('bg', 3, [turn('complete')], { background: { status: 'complete', filesChanged: 0, added: 0, removed: 0 } }),
		];
		const shape = (query: string, filter: 'all' | 'local' | 'background' | 'cloud') => groupClaudeAgentRows(rows, NOW, query, filter).map(group => [group.id, group.rows.map(row => `${row.title} | ${row.state} | ${row.subtitle ?? ''} | ${row.runTarget ?? 'local'}`)]);
		assert.deepStrictEqual({ all: shape('', 'all'), local: shape('', 'local'), cloud: shape('', 'cloud'), search: shape('flaky', 'all') }, {
			all: [
				['today', ['local chat | done |  | local', 'Fix the flaky test | idle | Cloud session, started in a terminal | cloud', 'bg | done | No changes | local']],
				['yesterday', ['also update the docs | idle | Cloud session session_abc | cloud']],
			],
			local: [['today', ['local chat | done |  | local']]],
			cloud: [
				['today', ['Fix the flaky test | idle | Cloud session, started in a terminal | cloud']],
				['yesterday', ['also update the docs | idle | Cloud session session_abc | cloud']],
			],
			search: [['today', ['Fix the flaky test | idle | Cloud session, started in a terminal | cloud']]],
		});
	});

	test('issue 98: sessions sit on top unless the setting asks for the agents sidebar', () => {
		assert.deepStrictEqual(['side', 'top', undefined, 'right', true].map(readClaudeSessionListLocation), ['side', 'top', 'top', 'top', 'top']);
	});

	test('issue 428: an MCP form or sign-in waits for input; a permission next to it still asks for approval', () => {
		const form: ElicitationEntry = { id: 'e1', server: 'deploy', mode: 'form', message: 'Release details', expiresAt: 1, state: 'pending' };
		const rows = groupClaudeAgentRows([
			session('form', 0, [{ ...turn('running'), elicitations: [form] }]),
			session('both', 0, [{ ...turn('running', { permissions: [{ state: 'pending' }] }), elicitations: [form] }]),
			session('answered', 0, [{ ...turn('running'), elicitations: [{ ...form, state: 'accepted' }] }]),
		], NOW, '', 'all').flatMap(group => group.rows.map(row => `${row.title} | ${row.state} | ${row.subtitle ?? ''}`));
		assert.deepStrictEqual(rows, [
			'form | waiting | Waiting for your input',
			'both | waiting | Waiting for your approval',
			'answered | running | Working...',
		]);
	});
	test('issue 977: a placed order sorts a group, rows never placed stay on top, and a move only changes its own group', () => {
		const today = groupClaudeAgentRows(inputs, NOW, '', 'all').map(group => group.rows.map(row => row.id));
		const ids = today[0];
		const moved = moveClaudeAgentRow(['elsewhere'], ids, ids[ids.length - 1], ids[0]);
		const toEnd = moveClaudeAgentRow(moved, ids, moved[1], undefined);
		const ordered = groupClaudeAgentRows(inputs, NOW, '', 'all', [ids[1], ids[0]]).map(group => group.rows.map(row => row.id))[0];
		assert.deepStrictEqual({
			moved,
			toEnd,
			ordered: ordered.slice(-2),
			unplacedOnTop: ordered.slice(0, -2),
			sameRows: [...ordered].sort(),
			expected: [...ids].sort(),
			noop: moveClaudeAgentRow(['a', 'b'], ['a', 'b'], 'a', 'a'),
			unknown: applyClaudeAgentRowOrder([], ['x']),
		}, {
			moved: ['elsewhere', ids[ids.length - 1], ...ids.slice(0, -1)],
			toEnd: ['elsewhere', ...ids],
			ordered: [ids[1], ids[0]],
			unplacedOnTop: ids.filter(id => id !== ids[0] && id !== ids[1]),
			sameRows: [...ids].sort(),
			expected: [...ids].sort(),
			noop: ['a', 'b'],
			unknown: [],
		});
	});
});
