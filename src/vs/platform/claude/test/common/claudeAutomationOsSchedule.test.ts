/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { claudeOsWantedSchedules } from '../../common/claudeAutomationOsScheduleService.js';
import { readClaudeAutomationsFile, writeClaudeAutomation } from '../../common/claudeAutomation.js';
import { claudeLaunchdLabel, claudeLaunchdPlist, claudeOsLaunchArgs, claudeOsOwner, claudeOsScheduleSpec, claudeWindowsDeleteArgs, claudeWindowsQuote, claudeWindowsTaskBelongsTo, claudeWindowsTaskNames, claudeWindowsTasks, ClaudeOsScheduleAutomation } from '../../common/claudeAutomationOsSchedule.js';

const exe = 'C:\\Program Files\\Klawly\\Klawly.exe';

function user(cron: string, id = 'nightly'): ClaudeOsScheduleAutomation {
	return { id, scope: 'user', cron };
}

function windows(cron: string, automation = user(cron)): string[][] {
	const result = claudeWindowsTasks(automation, exe);
	assert.ok('tasks' in result, JSON.stringify(result));
	return result.tasks.map(task => [...task.createArgs]);
}

suite('claudeAutomationOsSchedule', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('the schedule reads into the fields an OS scheduler has', () => {
		assert.deepStrictEqual(claudeOsScheduleSpec('30 9 * * mon-fri'), { spec: { minutes: [30], hours: [9], weekdays: [1, 2, 3, 4, 5], monthDays: undefined, months: undefined } });
		assert.deepStrictEqual(claudeOsScheduleSpec('0 0 1 * *'), { spec: { minutes: [0], hours: [0], weekdays: undefined, monthDays: [1], months: undefined } });
		assert.ok('unsupported' in claudeOsScheduleSpec('nope'));
		assert.ok('unsupported' in claudeOsScheduleSpec('0 9 1 * mon'));
	});

	test('names tell the owner apart', () => {
		const a = { id: 'x', scope: 'workspace' as const, folder: 'C:\\a' };
		const b = { id: 'x', scope: 'workspace' as const, folder: 'C:\\b' };
		assert.strictEqual(claudeOsOwner({ scope: 'user' }), 'user');
		assert.notStrictEqual(claudeOsOwner(a), claudeOsOwner(b));
		assert.strictEqual(claudeOsOwner(a), claudeOsOwner({ ...a }));
		assert.match(claudeOsOwner(a), /^ws[0-9a-f]{8}$/);
	});

	test('the headless entry gets the scope, id and folder', () => {
		assert.deepStrictEqual(claudeOsLaunchArgs({ id: 'nightly', scope: 'user' }), ['automations', 'run', '--scope', 'user', '--id', 'nightly']);
		assert.deepStrictEqual(claudeOsLaunchArgs({ id: 'nightly', scope: 'workspace', folder: 'C:\\my repo' }), ['automations', 'run', '--scope', 'workspace', '--id', 'nightly', '--folder', 'C:\\my repo']);
	});

	suite('windows', () => {
		test('quotes only what needs it', () => {
			assert.strictEqual(claudeWindowsQuote('nightly'), 'nightly');
			assert.strictEqual(claudeWindowsQuote('C:\\Program Files\\x.exe'), '"C:\\Program Files\\x.exe"');
			assert.strictEqual(claudeWindowsQuote('say "hi"'), '"say \\"hi\\""');
			assert.strictEqual(claudeWindowsQuote(''), '""');
		});

		test('a weekday morning is one weekly task', () => {
			assert.deepStrictEqual(windows('30 9 * * mon-fri'), [[
				'/Create', '/TN', '\\Klawly\\automation-user-nightly-1',
				'/TR', '"C:\\Program Files\\Klawly\\Klawly.exe" automations run --scope user --id nightly',
				'/SC', 'WEEKLY', '/D', 'MON,TUE,WED,THU,FRI', '/ST', '09:30', '/F'
			]]);
		});

		test('every day is a daily task; several times become several tasks', () => {
			assert.deepStrictEqual(windows('0 6,18 * * *').map(args => args.slice(2, 3).concat(args.slice(5))), [
				['\\Klawly\\automation-user-nightly-1', '/SC', 'DAILY', '/ST', '06:00', '/F'],
				['\\Klawly\\automation-user-nightly-2', '/SC', 'DAILY', '/ST', '18:00', '/F'],
			]);
		});

		test('a day of the month is a monthly task', () => {
			assert.deepStrictEqual(windows('15 2 1,15 * *')[0].slice(5), ['/SC', 'MONTHLY', '/D', '1,15', '/ST', '02:15', '/F']);
		});

		test('every minute, every N minutes and hourly', () => {
			assert.deepStrictEqual(windows('* * * * *')[0].slice(5), ['/SC', 'MINUTE', '/MO', '1', '/F']);
			assert.deepStrictEqual(windows('*/15 * * * *')[0].slice(5), ['/SC', 'MINUTE', '/MO', '15', '/F']);
			assert.deepStrictEqual(windows('5 * * * *')[0].slice(5), ['/SC', 'HOURLY', '/MO', '1', '/ST', '00:05', '/F']);
		});

		test('a schedule Task Scheduler cannot express is reported', () => {
			for (const cron of ['0 9 * 6 *', '0,10,45 * * * *', '*/5 * * * 1', '*/1 9 * * *', 'garbage', '0 9 1 * mon']) {
				assert.ok('unsupported' in claudeWindowsTasks(user(cron), exe), cron);
			}
		});

		test('tasks of one automation are told from another with the same prefix', () => {
			const automation = user('0 9 * * *', 'a');
			assert.strictEqual(claudeWindowsTaskBelongsTo('\\Klawly\\automation-user-a-1', automation), true);
			assert.strictEqual(claudeWindowsTaskBelongsTo('\\Klawly\\automation-user-a-12', automation), true);
			assert.strictEqual(claudeWindowsTaskBelongsTo('\\Klawly\\automation-user-a-b-1', automation), false);
			assert.strictEqual(claudeWindowsTaskBelongsTo('\\Klawly\\automation-user-a', automation), false);
		});

		test('delete and the task list', () => {
			assert.deepStrictEqual(claudeWindowsDeleteArgs('\\Klawly\\automation-user-a-1'), ['/Delete', '/TN', '\\Klawly\\automation-user-a-1', '/F']);
			const csv = '"\\Klawly\\automation-user-a-1","N/A","Ready"\r\n"\\Microsoft\\Windows\\X","N/A","Ready"\r\n"\\Klawly\\automation-user-b-1","N/A","Ready"\r\n';
			assert.deepStrictEqual(claudeWindowsTaskNames(csv), ['\\Klawly\\automation-user-a-1', '\\Klawly\\automation-user-b-1']);
		});
	});

	suite('macos', () => {
		test('a weekday morning is five calendar intervals', () => {
			const result = claudeLaunchdPlist(user('30 9 * * mon-fri'), '/Applications/Klawly.app/Contents/MacOS/Klawly', '/tmp/a.log');
			assert.ok('plist' in result);
			assert.strictEqual(result.label, 'com.klawly.automation.user.nightly');
			assert.strictEqual((result.plist.match(/<key>Weekday<\/key>/g) ?? []).length, 5);
			assert.strictEqual((result.plist.match(/<key>Hour<\/key>\n\t\t\t<integer>9<\/integer>/g) ?? []).length, 5);
			assert.ok(result.plist.includes('<string>/Applications/Klawly.app/Contents/MacOS/Klawly</string>'));
			assert.ok(result.plist.includes('<string>automations</string>'));
			assert.ok(result.plist.includes('<key>RunAtLoad</key>\n\t<false/>'));
			assert.ok(result.plist.includes('<key>StandardOutPath</key>\n\t<string>/tmp/a.log</string>'));
		});

		test('every minute is one empty interval', () => {
			const result = claudeLaunchdPlist(user('* * * * *'), '/x', '/l');
			assert.ok('plist' in result);
			assert.ok(result.plist.includes('<array>\n\t\t<dict/>\n\t</array>'));
		});

		test('text is escaped', () => {
			const result = claudeLaunchdPlist({ id: 'a', scope: 'workspace', folder: '/Users/a&b/<x>', cron: '0 9 * * *' }, '/x', '/l');
			assert.ok('plist' in result);
			assert.ok(result.plist.includes('<string>/Users/a&amp;b/&lt;x&gt;</string>'));
		});

		test('a schedule that is too big or invalid is reported', () => {
			assert.ok('unsupported' in claudeLaunchdPlist(user('0-29 0-11 1-5 * *'), '/x', '/l'));
			assert.ok('unsupported' in claudeLaunchdPlist(user('nope'), '/x', '/l'));
		});

		test('the label follows the owner', () => {
			assert.strictEqual(claudeLaunchdLabel({ id: 'a', scope: 'user' }), 'com.klawly.automation.user.a');
			assert.match(claudeLaunchdLabel({ id: 'a', scope: 'workspace', folder: '/w' }), /^com\.klawly\.automation\.ws[0-9a-f]{8}\.a$/);
		});
	});

	test('runWhenClosed is read, written and removed when off', () => {
		const file = { automations: [
			{ id: 'on', prompt: 'x', trigger: { type: 'schedule', cron: '0 9 * * *' }, runWhenClosed: true },
			{ id: 'off', prompt: 'x', trigger: { type: 'schedule', cron: '0 9 * * *' } },
			{ id: 'bad', prompt: 'x', trigger: { type: 'schedule', cron: '0 9 * * *' }, runWhenClosed: 'yes' },
		] };
		const read = readClaudeAutomationsFile(file, 'user').automations;
		assert.deepStrictEqual(read.map(item => [item.id, item.runWhenClosed]), [['on', true], ['off', undefined]]);
		const on = read[0];
		const written = writeClaudeAutomation({ automations: [] }, { ...on, runWhenClosed: true });
		assert.strictEqual((written.automations[0] as { runWhenClosed?: boolean }).runWhenClosed, true);
		const cleared = writeClaudeAutomation(written, { ...on, runWhenClosed: false });
		assert.strictEqual('runWhenClosed' in (cleared.automations[0] as object), false);
	});

	test('only enabled, opted-in, non-agent schedules are wanted, capped at 24 (issue 463)', () => {
		const item = (id: string, extra: object = {}) => ({ id, prompt: 'x', trigger: { type: 'schedule', cron: '0 9 * * *' }, permissionMode: 'ask', runWhenClosed: true, ...extra });
		const file = { automations: [
			item('ok'), item('off', { runWhenClosed: false }), item('agent', { permissionMode: 'agent' }), item('disabled', { enabled: false }),
			item('push', { trigger: { type: 'githubPush', repo: 'a/b' } }),
		] };
		const read = (scope: 'user' | 'workspace') => readClaudeAutomationsFile(file, scope).automations;
		const many = readClaudeAutomationsFile({ automations: Array.from({ length: 30 }, (_, n) => item(`a${n}`)) }, 'user').automations;
		assert.deepStrictEqual([
			claudeOsWantedSchedules(read('user'), true, undefined).map(wanted => wanted.id),
			claudeOsWantedSchedules(read('user'), false, undefined),
			claudeOsWantedSchedules(read('workspace'), true, undefined),
			claudeOsWantedSchedules(read('workspace'), true, '/w').map(wanted => wanted.folder),
			claudeOsWantedSchedules(many, true, undefined).length,
		], [['ok'], [], [], ['/w'], 24]);
	});
});
