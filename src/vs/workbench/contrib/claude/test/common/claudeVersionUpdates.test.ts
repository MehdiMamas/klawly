/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { DisablementReason, State, UpdateType } from '../../../../../platform/update/common/update.js';
import { claudeSettingsPages, searchClaudeSettings } from '../../common/claudeSettingsPages.js';
import { claudeUpdateRow, claudeVersionCopyText, claudeVersionRow } from '../../common/claudeVersionUpdates.js';

suite('Claude version and updates', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const update = { version: 'abc' };
	const pick = (state: State) => {
		const { status, button, action, busy, progress } = claudeUpdateRow(state);
		return { status, button, action, busy, progress };
	};

	test('the update state maps to a label, a button and an action', () => {
		assert.deepStrictEqual({
			disabled: pick(State.Disabled(DisablementReason.NotBuilt)),
			checking: pick(State.CheckingForUpdates(true)),
			upToDate: pick(State.Idle(UpdateType.Setup, undefined, true)),
			neverChecked: pick(State.Idle(UpdateType.Setup)),
			failed: pick(State.Idle(UpdateType.Setup, 'offline')),
			available: pick(State.AvailableForDownload(update)),
			downloading: pick(State.Downloading(update, true, false)),
			downloaded: pick(State.Downloaded(update, true, false)),
			ready: pick(State.Ready(update, true, false)),
		}, {
			disabled: { status: 'Updates are off in a build run from source', button: 'Check for Updates', action: undefined, busy: false, progress: false },
			checking: { status: 'Checking...', button: 'Check for Updates', action: undefined, busy: true, progress: false },
			upToDate: { status: 'Up to date', button: 'Check for Updates', action: 'check', busy: false, progress: false },
			neverChecked: { status: 'Not checked yet in this session', button: 'Check for Updates', action: 'check', busy: false, progress: false },
			failed: { status: 'Couldn\'t check: offline', button: 'Try Again', action: 'check', busy: false, progress: false },
			available: { status: 'A new version is available', button: 'Update', action: 'download', busy: false, progress: false },
			downloading: { status: 'Downloading...', button: 'Check for Updates', action: undefined, busy: true, progress: true },
			downloaded: { status: 'Downloaded, ready to install', button: 'Install Update', action: 'install', busy: false, progress: false },
			ready: { status: 'Ready: restart to finish updating', button: 'Restart to Update', action: 'restart', busy: false, progress: false },
		});
	});

	test('every disablement reason says why and disables the button', () => {
		const reasons = [DisablementReason.NotBuilt, DisablementReason.DisabledByEnvironment, DisablementReason.ManuallyDisabled, DisablementReason.Policy, DisablementReason.MissingConfiguration, DisablementReason.InvalidConfiguration, DisablementReason.RunningAsAdmin];
		const rows = reasons.map(reason => claudeUpdateRow(State.Disabled(reason)));
		assert.deepStrictEqual({
			distinct: new Set(rows.map(row => row.status)).size >= 5,
			allUpdates: rows.every(row => row.status.startsWith('Updates are')),
			allDisabled: rows.every(row => row.action === undefined),
		}, { distinct: true, allUpdates: true, allDisabled: true });
	});

	test('the version row and the copied details', () => {
		const product = { version: '1.141.0', klawlyRelease: 'alpha.10', commit: '3f9a2c1d5e6f', upstreamCommit: 'up123', date: '2026-10-13T08:00:00.000Z', target: undefined };
		assert.deepStrictEqual(claudeVersionRow(product), { title: '1.141.0 Alpha 10', detail: 'Commit 3f9a2c1d · Built 2026-10-13' });
		assert.strictEqual(claudeVersionCopyText(product).split('\n').slice(0, 4).join('|'), 'Version: 1.141.0 Alpha 10|Commit: 3f9a2c1d5e6f|Upstream: up123|Date: 2026-10-13T08:00:00.000Z');
	});

	test('settings search finds the section by version, update, about and upgrade', () => {
		const found = (query: string) => searchClaudeSettings(claudeSettingsPages(), query).map(match => match.row.id);
		assert.deepStrictEqual({
			version: found('version').includes('version') && found('version').includes('updates'),
			update: found('update').includes('updates'),
			about: found('about').includes('version'),
			upgrade: found('upgrade').includes('updates'),
		}, { version: true, update: true, about: true, upgrade: true });
	});
});
