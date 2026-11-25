/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from '../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { NullLogService } from '../../../log/common/log.js';
import { ClaudeConversation } from '../../common/claudeConversation.js';
import { ClaudeEvent } from '../../common/claudeRuntime.js';
import { ClaudeSessionOwners } from '../../common/claudeSessionOwners.js';
import { mergeClaudeSettings } from '../../common/claudeSettings.js';
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
				{ type: 'system', subtype: 'init', session_id: 's1', model: 'm' },
				{ type: 'stream_event', session_id: 's1', event: { type: 'message_start', message: { id: 'a' } } },
				{ type: 'stream_event', session_id: 's1', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'He' } } },
				{ type: 'assistant', session_id: 's1', message: { id: 'a', content: [{ type: 'text', text: 'He' }, { type: 'tool_use', id: 'u1', name: 'Read', input: { file_path: 'a' } }] } },
				{ type: 'user', session_id: 's1', message: { content: [{ type: 'tool_result', tool_use_id: 'u1', content: [{ type: 'text', text: 'ok' }] }] } },
				{ type: 'control_request', session_id: 's1', request_id: 'r', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'ls' }, description: 'List' } },
				{ type: 'result', session_id: 's1', is_error: false, result: 'done', total_cost_usd: 0.5, usage: { input_tokens: 1, output_tokens: 2 } },
			];
			const events = lines.flatMap(line => parser.parseLine(JSON.stringify(line)));
			assert.deepStrictEqual(events, [
				{ type: 'started', sessionId: 's1', model: 'm' },
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
				items: conversation.items.map(i => i.kind === 'tool' ? [i.kind, i.name, i.target, i.status] : i.kind === 'permission' ? [i.kind] : [i.kind, i.text]),
				changes: conversation.changes,
				working: conversation.working,
				contextTokens: conversation.contextTokens,
				title: conversation.title,
			}, {
				items: [['user', 'Fix it'], ['assistant', 'Looking'], ['tool', 'Read', '/p/a.ts', 'running'], ['tool', 'Edit', '/p/a.ts', 'done'], ['tool', 'Write', '/p/b.ts', 'failed']],
				changes: [{ path: '/p/a.ts', added: 3, removed: 2 }, { path: '/p/b.ts', added: 2, removed: 0 }],
				working: false,
				contextTokens: 1000,
				title: 'Fix it',
			});
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
