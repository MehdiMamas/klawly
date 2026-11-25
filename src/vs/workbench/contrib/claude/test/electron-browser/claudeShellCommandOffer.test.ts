/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ClaudeSetupPhase } from '../../common/claudeRuntimeStatus.js';
import { ShellCommandOfferState, shouldOfferShellCommand } from '../../electron-browser/claudeShellCommandOffer.js';

suite('Klawly shell command offer (issue 1606)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const base: ShellCommandOfferState = { isMacintosh: true, isBuilt: true, offered: false, agentEnabled: true, phase: 'ready' };

	test('waits for the Claude setup card to finish, then offers once, on built macOS apps only', () => {
		const phases: ClaudeSetupPhase[] = ['checking', 'missing', 'signed-out', 'waiting-sign-in', 'ready'];
		assert.deepStrictEqual({
			phases: phases.map(phase => [phase, shouldOfferShellCommand({ ...base, phase })]),
			claudeOff: shouldOfferShellCommand({ ...base, agentEnabled: false, phase: 'missing' }),
			alreadyOffered: shouldOfferShellCommand({ ...base, offered: true }),
			notMac: shouldOfferShellCommand({ ...base, isMacintosh: false }),
			devBuild: shouldOfferShellCommand({ ...base, isBuilt: false }),
		}, {
			phases: [['checking', false], ['missing', false], ['signed-out', false], ['waiting-sign-in', false], ['ready', true]],
			claudeOff: true,
			alreadyOffered: false,
			notMac: false,
			devBuild: false,
		});
	});
});
