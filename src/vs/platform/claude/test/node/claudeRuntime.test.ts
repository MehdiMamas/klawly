/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from '../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { NullLogService } from '../../../log/common/log.js';
import { claudeAllowRule, ClaudeConversation, claudeDiffLines, claudeQuestion, claudeToolSummary, IClaudeToolItem } from '../../common/claudeConversation.js';
import { ClaudeEvent } from '../../common/claudeRuntime.js';
import { ClaudeSessionOwners } from '../../common/claudeSessionOwners.js';
import { claudeProjectFolderName, parseClaudeTranscript } from '../../common/claudeSessions.js';
import { addAllowRuleToSettings, mergeClaudeSettings } from '../../common/claudeSettings.js';
import { ClaudeStreamParser } from '../../common/claudeStreamParser.js';
import { ClaudeRuntimeService } from '../../node/claudeRuntimeService.js';

/**
 * A stand-in for the `claude` command: it speaks the same stream-json lines and never calls a model.
 * A prompt containing "touch" asks for a permission first. Every start is appended to `spawns.log`.
 */
const FAKE_CLI = `#!${process.execPath}
const fs = require('fs');
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('2.1.0 (Claude Code)'); process.exit(0); }
const id = args[args.indexOf('--resume') + 1] || args[args.indexOf('--session-id') + 1];
fs.appendFileSync(__dirname + '/spawns.log', id + '\\n');
const out = o => console.log(JSON.stringify({ session_id: id, ...o }));
out({ type: 'system', subtype: 'init', model: 'fake-model' });
let pending = null;
require('readline').createInterface({ input: process.stdin }).on('line', line => {
	const m = JSON.parse(line);
	if (m.type === 'control_response') {
		out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: m.response.response.behavior, is_error: m.response.response.behavior === 'deny' }] } });
		out({ type: 'result', is_error: false, result: 'done', total_cost_usd: 0.01, usage: { input_tokens: 3, output_tokens: 4 } });
	} else if (m.type === 'user' && m.message.content.includes('touch')) {
		out({ type: 'control_request', request_id: 'r1', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'touch x' } } });
	} else if (m.type === 'user') {
		out({ type: 'stream_event', event: { type: 'message_start', message: { id: 'm1' } } });
		out({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hi' } } });
		out({ type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'Hi' }] } });
		out({ type: 'result', is_error: false, result: 'Hi', total_cost_usd: 0.01, usage: { input_tokens: 3, output_tokens: 4 } });
	}
});
`;

suite('Claude runtime', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	suite('stream parser', () => {
		test('maps CLI lines to normalized events and does not repeat streamed text', () => {
			const parser = new ClaudeStreamParser();
			const lines = [
				{ type: 'system', subtype: 'init', session_id: 's1', model: 'm', cwd: '/p' },
				{ type: 'system', subtype: 'status', session_id: 's1', status: null, permissionMode: 'plan' },
				{ type: 'stream_event', session_id: 's1', event: { type: 'message_start', message: { id: 'a' } } },
				{ type: 'stream_event', session_id: 's1', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'He' } } },
				{ type: 'assistant', session_id: 's1', message: { id: 'a', content: [{ type: 'text', text: 'He' }, { type: 'tool_use', id: 'u1', name: 'Read', input: { file_path: 'a' } }] } },
				{ type: 'user', session_id: 's1', message: { content: [{ type: 'tool_result', tool_use_id: 'u1', content: [{ type: 'text', text: 'ok' }] }] } },
				{ type: 'control_request', session_id: 's1', request_id: 'r', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'ls' }, description: 'List' } },
				{ type: 'result', session_id: 's1', is_error: false, result: 'done', total_cost_usd: 0.5, usage: { input_tokens: 1, output_tokens: 2 } },
			];
			const events = lines.flatMap(line => parser.parseLine(JSON.stringify(line)));
			assert.deepStrictEqual(events, [
				{ type: 'started', sessionId: 's1', model: 'm', cwd: '/p' },
				{ type: 'mode', sessionId: 's1', mode: 'plan' },
				{ type: 'text', sessionId: 's1', text: 'He' },
				{ type: 'toolUse', sessionId: 's1', toolUseId: 'u1', name: 'Read', input: { file_path: 'a' } },
				{ type: 'toolResult', sessionId: 's1', toolUseId: 'u1', output: 'ok', isError: false },
				{ type: 'permission', sessionId: 's1', requestId: 'r', toolName: 'Bash', input: { command: 'ls' }, description: 'List' },
				{ type: 'result', sessionId: 's1', isError: false, text: 'done', costUsd: 0.5, usage: { inputTokens: 1, outputTokens: 2 } },
			]);
		});

		test('ignores blank and broken lines', () => {
			const parser = new ClaudeStreamParser();
			assert.deepStrictEqual([parser.parseLine(''), parser.parseLine('not json'), parser.parseLine('[1]')], [[], [], []]);
		});
	});

	suite('settings precedence', () => {
		test('higher level wins for scalars, lists are combined', () => {
			const merged = mergeClaudeSettings([
				{ model: 'user', permissions: { allow: ['Read'], deny: ['Bash(rm:*)'] }, theme: 'dark' },
				{ model: 'project', permissions: { allow: ['Edit'] } },
				{ model: 'local', permissions: { allow: ['Read', 'Write'] } },
			]);
			assert.deepStrictEqual(merged, { model: 'local', theme: 'dark', permissions: { allow: ['Read', 'Edit', 'Write'], deny: ['Bash(rm:*)'] } });
		});
	});

	suite('session owners (N5)', () => {
		test('a second claim follows the owner; a late release of an old owner keeps the new one', () => {
			const owners = new ClaudeSessionOwners<object>();
			const first = owners.claim('s', () => ({}));
			const second = owners.claim('s', () => ({}));
			assert.deepStrictEqual([first.followed, second.followed, second.owner === first.owner], [false, true, true]);
			owners.release('s', first.owner);
			const third = owners.claim('s', () => ({}));
			owners.release('s', first.owner);
			assert.strictEqual(owners.get('s'), third.owner);
		});
	});

	suite('pane helpers (round 2)', () => {
		test('allow rule: a command is allowed by its first words, other tools by name', () => {
			assert.deepStrictEqual([
				claudeAllowRule('Bash', { command: 'npm test -- total' }),
				claudeAllowRule('Bash', { command: 'ls -la' }),
				claudeAllowRule('Edit', { file_path: 'a.ts' }),
			], [{ rule: 'Bash(npm test *)', label: 'npm test' }, { rule: 'Bash(ls *)', label: 'ls' }, { rule: 'Edit', label: 'Edit' }]);
		});

		test('allow rule is merged into settings without losing other keys', () => {
			const first = addAllowRuleToSettings('{"model":"x","permissions":{"allow":["Read"],"deny":["Bash(rm *)"]}}', 'Bash(npm test *)');
			assert.deepStrictEqual(JSON.parse(addAllowRuleToSettings(first, 'Bash(npm test *)')), { model: 'x', permissions: { allow: ['Read', 'Bash(npm test *)'], deny: ['Bash(rm *)'] } });
			assert.deepStrictEqual(JSON.parse(addAllowRuleToSettings(undefined, 'Edit')), { permissions: { allow: ['Edit'] } });
			assert.throws(() => addAllowRuleToSettings('{ broken', 'Edit'));
		});

		test('tool summaries: lines read, matches, and lines changed', () => {
			const tool = (name: string, input: Record<string, unknown>, output: string): IClaudeToolItem => ({ kind: 'tool', id: 'a', name, target: '', input, startedAt: 0, status: 'done', output });
			assert.deepStrictEqual([
				claudeToolSummary(tool('Read', {}, '1\tx\n2\ty\n3\tz')),
				claudeToolSummary(tool('Read', { offset: 6, limit: 3 }, '')),
				claudeToolSummary(tool('Grep', {}, 'a.ts\nb.ts\nc.ts')),
				claudeToolSummary(tool('Edit', { old_string: 'a\nb', new_string: 'c\nd\ne' }, '')),
			], [{ text: 'L1–3' }, { text: 'L6–8' }, { text: '3 matches' }, { added: 3, removed: 2 }]);
		});

		test('a stored session is read from the CLI folder layout, newest first, titles from the first prompt', () => {
			const line = (type: string, content: unknown) => JSON.stringify({ type, message: { content } });
			assert.deepStrictEqual(parseClaudeTranscript([
				line('user', 'Fix it'), line('assistant', [{ type: 'text', text: 'Done' }, { type: 'tool_use', name: 'Edit' }]),
				line('user', [{ type: 'tool_result', content: 'x' }]), 'not json', line('user', '<command-name>/clear</command-name>'),
			].join('\n')), [{ role: 'user', text: 'Fix it' }, { role: 'assistant', text: 'Done' }]);
			assert.strictEqual(claudeProjectFolderName('/Users/a b/my.proj'), '-Users-a-b-my-proj');
		});
	});

	suite('conversation (pane state)', () => {
		function create(): ClaudeConversation {
			const conversation = store.add(new ClaudeConversation());
			conversation.sessionId = 's';
			return conversation;
		}

		test('streams text into one assistant item, tracks tool rows and the changes bar', () => {
			const conversation = create();
			conversation.addUser('Fix it');
			const events: ClaudeEvent[] = [
				{ type: 'text', sessionId: 's', text: 'Look' },
				{ type: 'text', sessionId: 's', text: 'ing' },
				{ type: 'toolUse', sessionId: 's', toolUseId: 'u1', name: 'Read', input: { file_path: '/p/a.ts' } },
				{ type: 'toolUse', sessionId: 's', toolUseId: 'u2', name: 'Edit', input: { file_path: '/p/a.ts', old_string: 'a\nb', new_string: 'c\nd\ne' } },
				{ type: 'toolUse', sessionId: 's', toolUseId: 'u3', name: 'Write', input: { file_path: '/p/b.ts', content: 'x\ny' } },
				{ type: 'toolResult', sessionId: 's', toolUseId: 'u2', output: 'ok', isError: false },
				{ type: 'toolResult', sessionId: 's', toolUseId: 'u3', output: 'no', isError: true },
				{ type: 'text', sessionId: 'other', text: 'ignored' },
				{ type: 'result', sessionId: 's', isError: false, text: 'done', usage: { inputTokens: 1000, outputTokens: 5 } },
			];
			events.forEach(e => conversation.handle(e));
			assert.deepStrictEqual({
				items: conversation.items.map(i => i.kind === 'tool' ? [i.kind, i.name, i.target, i.status] : i.kind === 'permission' || i.kind === 'stopped' ? [i.kind] : [i.kind, i.text]),
				changes: conversation.changes,
				working: conversation.working,
				contextTokens: conversation.contextTokens,
				title: conversation.title,
			}, {
				items: [['user', 'Fix it'], ['assistant', 'Looking'], ['tool', 'Read', '/p/a.ts', 'running'], ['tool', 'Edit', '/p/a.ts', 'done'], ['tool', 'Write', '/p/b.ts', 'failed']],
				changes: [{ path: '/p/a.ts', added: 3, removed: 2 }],
				working: false,
				contextTokens: 1000,
				title: 'Fix it',
			});
		});

		test('Stop ends running tools, denies a waiting card, marks Stopped and drops the late events of the turn', () => {
			const conversation = create();
			conversation.addUser('Go');
			conversation.handle({ type: 'toolUse', sessionId: 's', toolUseId: 'u1', name: 'Bash', input: { command: 'sleep 9' } });
			conversation.handle({ type: 'permission', sessionId: 's', requestId: 'r', toolName: 'Bash', input: { command: 'sleep 9' } });
			conversation.stop();
			conversation.handle({ type: 'text', sessionId: 's', text: 'late' });
			conversation.handle({ type: 'result', sessionId: 's', isError: true, text: 'interrupted' });
			assert.deepStrictEqual({
				items: conversation.items.map(i => i.kind === 'tool' ? [i.kind, i.status] : i.kind === 'permission' ? [i.kind, i.state] : [i.kind]),
				working: conversation.working, notice: conversation.notice,
			}, { items: [['user'], ['tool', 'failed'], ['permission', 'denied'], ['stopped']], working: false, notice: undefined });
		});

		test('the changes bar counts an edit only after it was applied', () => {
			const conversation = create();
			conversation.addUser('Go');
			conversation.handle({ type: 'toolUse', sessionId: 's', toolUseId: 'u1', name: 'Edit', input: { file_path: '/p/a.ts', old_string: 'a', new_string: 'b' } });
			const waiting = conversation.changes.length;
			conversation.handle({ type: 'toolResult', sessionId: 's', toolUseId: 'u1', output: 'ok', isError: false });
			assert.deepStrictEqual([waiting, conversation.changes.length], [0, 1]);
		});

		test('question and diff helpers read the tool input', () => {
			assert.deepStrictEqual(claudeQuestion({ questions: [{ question: 'Which?', options: [{ label: 'A' }, { label: 'B' }] }] }), { question: 'Which?', options: [{ label: 'A', description: undefined }, { label: 'B', description: undefined }] });
			assert.deepStrictEqual(claudeQuestion({ questions: [{ question: 'Q', options: [{ label: 'A', description: 'why' }] }] })?.options, [{ label: 'A', description: 'why' }]);
			assert.strictEqual(claudeQuestion({}), undefined);
			assert.deepStrictEqual(claudeDiffLines('Edit', { old_string: 'a\nb', new_string: 'c' }), [{ sign: '-', text: 'a' }, { sign: '-', text: 'b' }, { sign: '+', text: 'c' }]);
			// a line that stays is context, not removed and added again
			assert.deepStrictEqual(claudeDiffLines('Edit', { old_string: 'a\nb\nc', new_string: 'a\nB\nc' }).map(l => l.sign + l.text), [' a', '-b', '+B', ' c']);
			assert.deepStrictEqual(claudeToolSummary({ kind: 'tool', id: 'x', name: 'Edit', target: '', startedAt: 0, status: 'done', input: { old_string: 'a\nb\nc', new_string: 'a\nB\nc' } } as IClaudeToolItem), { added: 1, removed: 1 });
		});

		test('the CLI reports its mode; files outside its folder never count as changes', () => {
			const conversation = create();
			conversation.addUser('Go');
			conversation.handle({ type: 'started', sessionId: 's', cwd: '/p' });
			conversation.handle({ type: 'mode', sessionId: 's', mode: 'default' });
			for (const [id, file] of [['u1', '/p/a.ts'], ['u2', '/home/me/.claude/plans/x.md'], ['u3', '/pp/b.ts']]) {
				conversation.handle({ type: 'toolUse', sessionId: 's', toolUseId: id, name: 'Write', input: { file_path: file, content: 'x' } });
				conversation.handle({ type: 'toolResult', sessionId: 's', toolUseId: id, output: 'ok', isError: false });
			}
			assert.deepStrictEqual([conversation.mode, conversation.changes.map(c => c.path)], ['default', ['/p/a.ts']]);
		});

		test('an error shows as a notice and stops the turn', () => {
			const conversation = create();
			conversation.addUser('hi');
			conversation.handle({ type: 'error', sessionId: 's', message: 'offline' });
			assert.deepStrictEqual([conversation.working, conversation.notice], [false, 'offline']);
		});
	});

	suite('service with a fake CLI', () => {
		let dir: string;
		let cwd: string;

		setup(async () => {
			dir = await mkdtemp(join(tmpdir(), 'klawly-claude-'));
			cwd = join(dir, 'project');
			await mkdir(join(cwd, '.claude'), { recursive: true });
			await writeFile(join(dir, 'claude'), FAKE_CLI);
			await chmod(join(dir, 'claude'), 0o755);
		});

		teardown(async () => {
			await rm(dir, { recursive: true, force: true });
		});

		function create(env: NodeJS.ProcessEnv): ClaudeRuntimeService {
			return new ClaudeRuntimeService(new NullLogService(), { ...process.env, ...env }, join(dir, 'home'));
		}

		function waitFor(service: ClaudeRuntimeService, type: ClaudeEvent['type']): Promise<ClaudeEvent> {
			return new Promise(resolve => {
				const listener = service.onDidEvent(event => {
					if (event.type === type) {
						listener.dispose();
						resolve(event);
					}
				});
			});
		}

		test('missing CLI fails cleanly', async () => {
			const service = create({ PATH: join(dir, 'empty'), KLAWLY_CLAUDE_BIN: '' });
			const status = await service.checkCli();
			assert.strictEqual(status.found, false);
			await assert.rejects(service.send({ cwd, prompt: 'hi' }), /not installed/);
			service.dispose();
		});

		test('finds the CLI on PATH and reads its version', async () => {
			const service = create({ PATH: dir, KLAWLY_CLAUDE_BIN: '' });
			const status = await service.checkCli();
			assert.deepStrictEqual([status.found, status.version], [true, '2.1.0']);
			service.dispose();
		});

		test('runs a turn and streams text and a result', async () => {
			const service = create({ PATH: dir, KLAWLY_CLAUDE_BIN: '' });
			const events: ClaudeEvent[] = [];
			const done = waitFor(service, 'result');
			store.add(service.onDidEvent(e => events.push(e)));
			const { sessionId, followed } = await service.send({ cwd, prompt: 'say hi' });
			await done;
			assert.strictEqual(followed, false);
			assert.deepStrictEqual(events.map(e => e.type), ['started', 'text', 'result']);
			assert.ok(events.every(e => e.sessionId === sessionId));
			await service.close(sessionId);
			await waitFor(service, 'ended');
			service.dispose();
		});

		test('answers a permission request', async () => {
			const service = create({ PATH: dir, KLAWLY_CLAUDE_BIN: '' });
			const asked = waitFor(service, 'permission');
			const { sessionId } = await service.send({ cwd, prompt: 'touch x' });
			const permission = await asked;
			assert.strictEqual(permission.type === 'permission' && permission.toolName, 'Bash');
			const result = waitFor(service, 'toolResult');
			await service.answerPermission(sessionId, 'r1', false);
			const toolResult = await result;
			assert.strictEqual(toolResult.type === 'toolResult' && toolResult.isError, true);
			await service.close(sessionId);
			await waitFor(service, 'ended');
			service.dispose();
		});

		test('permission card: Allow and Deny reach the CLI and update the card (S13)', async () => {
			const service = create({ PATH: dir, KLAWLY_CLAUDE_BIN: '' });
			const conversation = store.add(new ClaudeConversation());
			store.add(service.onDidEvent(e => {
				conversation.sessionId ??= e.sessionId;
				conversation.handle(e);
			}));
			const asked = waitFor(service, 'permission');
			const { sessionId } = await service.send({ cwd, prompt: 'touch x' });
			conversation.addUser('touch x');
			await asked;
			const card = conversation.items.find(i => i.kind === 'permission');
			assert.deepStrictEqual(card && card.kind === 'permission' ? [card.toolName, card.target, card.state] : undefined, ['Bash', 'touch x', 'pending']);
			const done = waitFor(service, 'result');
			await service.answerPermission(sessionId, 'r1', true);
			if (card?.kind === 'permission') {
				conversation.resolvePermission(card, true);
			}
			await done;
			assert.deepStrictEqual([card?.kind === 'permission' && card.state, conversation.working], ['allowed', false]);
			await service.close(sessionId);
			await waitFor(service, 'ended');
			service.dispose();
		});

		test('the same session id never runs in two processes', async () => {
			const service = create({ PATH: dir, KLAWLY_CLAUDE_BIN: '' });
			const started = waitFor(service, 'started');
			const first = await service.send({ cwd, prompt: 'one' });
			await started;
			const [second, third] = await Promise.all([service.send({ cwd, sessionId: first.sessionId, prompt: 'two' }), service.send({ cwd, sessionId: first.sessionId, prompt: 'three' })]);
			assert.deepStrictEqual([second.followed, third.followed, await service.getRunningSessions()], [true, true, [first.sessionId]]);
			assert.strictEqual((await readFile(join(dir, 'spawns.log'), 'utf8')).trim().split('\n').length, 1);
			await service.close(first.sessionId);
			await waitFor(service, 'ended');
			service.dispose();
		});

		test('Stop ends a CLI that ignores the interrupt, and a finished chat is not busy', async () => {
			const service = create({ PATH: dir, KLAWLY_CLAUDE_BIN: '' });
			const first = await service.send({ cwd, prompt: 'one' });
			await waitFor(service, 'result');
			assert.deepStrictEqual(await service.getBusySessions(), []);
			const ended = waitFor(service, 'ended');
			const errors: string[] = [];
			store.add(service.onDidEvent(e => e.type === 'error' && errors.push(e.message)));
			await service.stop(first.sessionId);
			await ended;
			assert.deepStrictEqual(errors, []); // a stop the person asked for is not an error
			assert.deepStrictEqual(await service.getRunningSessions(), []);
			service.dispose();
		});

		test('Always allow writes the rule into settings.local.json; sessions list and read back', async () => {
			const service = create({});
			await service.addAllowRule(cwd, 'Bash(npm test *)');
			assert.deepStrictEqual(JSON.parse(await readFile(join(cwd, '.claude', 'settings.local.json'), 'utf8')), { permissions: { allow: ['Bash(npm test *)'] } });
			const folder = join(dir, 'home', '.claude', 'projects', claudeProjectFolderName(await realpath(cwd)));
			await mkdir(folder, { recursive: true });
			await writeFile(join(folder, 'abc-1.jsonl'), JSON.stringify({ type: 'user', message: { content: 'Fix cart total' } }) + '\n' + JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Done' }, { type: 'tool_use', name: 'Edit', input: { file_path: '/p/a.ts' } }] } }));
			assert.deepStrictEqual((await service.listSessions(cwd)).map(x => [x.id, x.title, x.files]), [['abc-1', 'Fix cart total', 1]]);
			assert.deepStrictEqual(await service.readTranscript(cwd, 'abc-1'), [{ role: 'user', text: 'Fix cart total' }, { role: 'assistant', text: 'Done' }]);
			assert.deepStrictEqual(await service.readTranscript(cwd, '../../x'), []);
			service.dispose();
		});

		test('reads user, project and local settings with the right precedence', async () => {
			await mkdir(join(dir, 'home', '.claude'), { recursive: true });
			await writeFile(join(dir, 'home', '.claude', 'settings.json'), JSON.stringify({ model: 'user', theme: 'dark' }));
			await writeFile(join(cwd, '.claude', 'settings.json'), JSON.stringify({ model: 'project' }));
			await writeFile(join(cwd, '.claude', 'settings.local.json'), '{ broken');
			const service = create({});
			const { settings, sources } = await service.readSettings(cwd);
			assert.deepStrictEqual(settings, { model: 'project', theme: 'dark' });
			assert.deepStrictEqual(sources.map(s => [s.scope, s.loaded]), [['user', true], ['project', true], ['local', false]]);
			service.dispose();
		});
	});
});
