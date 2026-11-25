/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { ClaudeLoginHelper, CLAUDE_BACKGROUND_START_ARG, CLAUDE_LOGIN_ITEM_ID } from '../../node/claudeLoginHelper.js';

suite('ClaudeLoginHelper', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	function setup(platform: NodeJS.Platform) {
		const calls: unknown[] = [];
		const helper = new ClaudeLoginHelper({
			platform,
			execPath: '/opt/Klawly/klawly',
			homeDir: '/home/me',
			electron: { setLoginItemSettings: s => calls.push(['login', s]) },
			files: { write: (p, c) => calls.push(['write', p, c]), remove: p => calls.push(['remove', p]) },
		});
		return { helper, calls };
	}

	test('Windows registers and clears the Electron login item with the background argument', () => {
		const { helper, calls } = setup('win32');
		helper.apply(true);
		helper.apply(false);
		assert.deepStrictEqual(calls, [
			['login', { openAtLogin: true, path: '/opt/Klawly/klawly', args: [CLAUDE_BACKGROUND_START_ARG] }],
			['login', { openAtLogin: false, path: '/opt/Klawly/klawly', args: [] }],
		]);
	});

	test('macOS writes and removes a LaunchAgent that runs at load', () => {
		const { helper, calls } = setup('darwin');
		helper.apply(true);
		helper.apply(false);
		const path = `/home/me/Library/LaunchAgents/${CLAUDE_LOGIN_ITEM_ID}.plist`;
		assert.strictEqual((calls[0] as string[])[0], 'write');
		assert.strictEqual((calls[0] as string[])[1], path);
		const plist = (calls[0] as string[])[2];
		assert.ok(plist.includes('<string>/opt/Klawly/klawly</string>') && plist.includes(`<string>${CLAUDE_BACKGROUND_START_ARG}</string>`) && plist.includes('<key>RunAtLoad</key>'));
		assert.deepStrictEqual(calls[1], ['remove', path]);
	});

	test('Linux writes and removes an XDG autostart entry', () => {
		const { helper, calls } = setup('linux');
		helper.apply(true);
		helper.apply(false);
		const path = `/home/me/.config/autostart/${CLAUDE_LOGIN_ITEM_ID}.desktop`;
		assert.deepStrictEqual(calls, [
			['write', path, '[Desktop Entry]\nType=Application\nName=Klawly (automations)\nComment=Runs Klawly automations in the background\nExec="/opt/Klawly/klawly" --background-start\nX-GNOME-Autostart-enabled=true\nTerminal=false\n'],
			['remove', path],
		]);
	});

	test('the item needs both settings on', () => {
		const { helper, calls } = setup('linux');
		helper.applySettings(k => ({ 'claude.automations.enabled': true, 'claude.automations.runAtLogin': true }[k]));
		helper.applySettings(k => ({ 'claude.automations.enabled': false, 'claude.automations.runAtLogin': true }[k]));
		helper.applySettings(() => undefined);
		assert.deepStrictEqual(calls.map(c => (c as string[])[0]), ['write', 'remove', 'remove']);
	});

	test('an unsupported platform does nothing', () => {
		const { helper, calls } = setup('freebsd');
		helper.apply(true);
		assert.deepStrictEqual(calls, []);
	});
});
