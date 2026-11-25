/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { claudeRegistryManagers, claudeRegistryReportFile, claudeRegistryWorkersOf, parseClaudeRegistrySession } from '../../common/claudeSessionRegistry.js';

const M = '015d1452-d47d-4611-9f1a-baaa4fbacc00';
const W1 = '0168db6d-3ee4-464b-9217-a3a341dd4078';
const W2 = '0231dbec-6c3e-4409-bc37-76e70f6696c7';

suite('Klawly registry workers and reports (issue 1186)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('workers are found through their parent, newest first; managers carry a count', () => {
		const file = (sessionId: string, name: string, parent: string | null, updatedAt: number) =>
			parseClaudeRegistrySession(JSON.stringify({ sessionId, name, parent, cwd: 'C:/Work/app', updatedAt }))!;
		const sessions = [file(M, 'manager', null, 9), file(W1, 'old', M, 1), file(W2, 'new', M, 5)];
		assert.deepStrictEqual({
			workers: claudeRegistryWorkersOf(sessions, M).map(s => s.name),
			managers: claudeRegistryManagers(sessions).map(m => [m.manager.name, m.workers]),
			none: claudeRegistryWorkersOf(sessions, W1).length,
			report: claudeRegistryReportFile(M, 'new'),
		}, {
			workers: ['new', 'old'],
			managers: [['manager', 2]],
			none: 0,
			report: `${M}.new.report.md`,
		});
	});
});
