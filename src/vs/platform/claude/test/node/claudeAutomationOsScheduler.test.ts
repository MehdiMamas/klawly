/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { ClaudeOsScheduleAutomation } from '../../common/claudeAutomationOsSchedule.js';
import { ClaudeOsSchedulerHost, registerClaudeOsSchedule, syncClaudeOsSchedules, unregisterClaudeOsSchedule } from '../../node/claudeAutomationOsScheduler.js';

class FakeHost implements ClaudeOsSchedulerHost {
	readonly executable = '/app/klawly';
	readonly launchAgentsDir = '/home/a/LaunchAgents';
	readonly logPath = '/tmp/l.log';
	readonly calls: string[] = [];
	readonly files = new Map<string, string>();
	/** Task names `schtasks /Query` reports. */
	tasks: string[] = [];

	constructor(readonly platform: string) { }

	async exec(command: string, args: readonly string[]): Promise<string> {
		this.calls.push([command, ...args].join(' '));
		if (command === 'schtasks' && args[0] === '/Query') {
			return this.tasks.map(name => `"${name}","N/A","Ready"`).join('\r\n');
		}
		if (command === 'schtasks' && args[0] === '/Create') {
			this.tasks.push(args[2]);
		}
		if (command === 'schtasks' && args[0] === '/Delete') {
			this.tasks = this.tasks.filter(name => name !== args[2]);
		}
		return '';
	}

	async writeFile(path: string, content: string): Promise<void> {
		this.files.set(path, content);
	}

	async deleteFile(path: string): Promise<void> {
		this.files.delete(path);
	}
}

const daily: ClaudeOsScheduleAutomation = { id: 'a', scope: 'user', cron: '0 9 * * *' };

suite('claudeAutomationOsScheduler', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('windows: registering creates the task and replaces older ones', async () => {
		const host = new FakeHost('win32');
		host.tasks = ['\\Klawly\\automation-user-a-1', '\\Klawly\\automation-user-a-2'];
		assert.deepStrictEqual(await registerClaudeOsSchedule(host, daily), { registered: true });
		assert.deepStrictEqual(host.tasks, ['\\Klawly\\automation-user-a-1']);
		assert.strictEqual(host.calls.filter(call => call.startsWith('schtasks /Delete')).length, 2);
	});

	test('windows: an unsupported schedule is reported and nothing changes', async () => {
		const host = new FakeHost('win32');
		const result = await registerClaudeOsSchedule(host, { ...daily, cron: '0 9 * 6 *' });
		assert.strictEqual(result.registered, false);
		assert.deepStrictEqual(host.calls, []);
	});

	test('windows: unregistering leaves other automations alone', async () => {
		const host = new FakeHost('win32');
		host.tasks = ['\\Klawly\\automation-user-a-1', '\\Klawly\\automation-user-b-1'];
		await unregisterClaudeOsSchedule(host, daily);
		assert.deepStrictEqual(host.tasks, ['\\Klawly\\automation-user-b-1']);
	});

	test('macos: registering writes the agent and loads it', async () => {
		const host = new FakeHost('darwin');
		assert.deepStrictEqual(await registerClaudeOsSchedule(host, daily), { registered: true });
		const path = '/home/a/LaunchAgents/com.klawly.automation.user.a.plist';
		assert.ok(host.files.get(path)?.includes('<string>com.klawly.automation.user.a</string>'));
		assert.strictEqual(host.calls[host.calls.length - 1], `launchctl load -w ${path}`);
	});

	test('macos: unregistering unloads and deletes the agent', async () => {
		const host = new FakeHost('darwin');
		await registerClaudeOsSchedule(host, daily);
		await unregisterClaudeOsSchedule(host, daily);
		assert.strictEqual(host.files.size, 0);
		assert.ok(host.calls.includes('launchctl unload /home/a/LaunchAgents/com.klawly.automation.user.a.plist'));
	});

	test('another platform is reported, not run', async () => {
		const host = new FakeHost('linux');
		const result = await registerClaudeOsSchedule(host, daily);
		assert.strictEqual(result.registered, false);
		assert.deepStrictEqual(host.calls, []);
	});

	test('sync registers wanted ones, removes dropped ones and reports failures', async () => {
		const host = new FakeHost('win32');
		host.tasks = ['\\Klawly\\automation-user-gone-1'];
		const failed = await syncClaudeOsSchedules(host,
			[daily, { id: 'bad', scope: 'user', cron: '0 9 * 6 *' }],
			[{ id: 'gone', scope: 'user' }, { id: 'a', scope: 'user' }]);
		assert.deepStrictEqual(host.tasks, ['\\Klawly\\automation-user-a-1']);
		assert.deepStrictEqual(failed.map(item => item.id), ['bad']);
	});

	test('sync keeps going when one command fails', async () => {
		const host = new FakeHost('win32');
		const exec = host.exec.bind(host);
		host.exec = async (command, args) => {
			if (args[0] === '/Create' && args[2].includes('-a-')) {
				throw new Error('access denied');
			}
			return exec(command, args);
		};
		const failed = await syncClaudeOsSchedules(host, [daily, { ...daily, id: 'b' }], []);
		assert.deepStrictEqual(failed, [{ id: 'a', reason: 'access denied' }]);
		assert.deepStrictEqual(host.tasks, ['\\Klawly\\automation-user-b-1']);
	});
});
