/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { agentsWindowSessionResource, claudeSessionIdFromAgentsWindow } from '../../common/claudeAgentsWindowSessions.js';

suite('One session in both windows (issue 618)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('the Agents window resource round-trips the Claude Code session id, and other sessions are not Claude Code sessions', () => {
		const id = '5f0c2a8e-3b1d-4c6a-9e7f-0a1b2c3d4e5f';
		const resource = agentsWindowSessionResource(id);
		assert.deepStrictEqual({
			resource: resource.toString(),
			roundTrip: claudeSessionIdFromAgentsWindow(resource),
			agentHost: claudeSessionIdFromAgentsWindow(URI.parse(`claude:/${id}`)),
			fromString: claudeSessionIdFromAgentsWindow(URI.parse(resource.toString())),
			otherProvider: claudeSessionIdFromAgentsWindow(URI.parse(`agent-host-other:/${id}`)),
			remoteHost: claudeSessionIdFromAgentsWindow(URI.parse(`remote-box-claude:/${id}`)),
			untitled: claudeSessionIdFromAgentsWindow(URI.parse('agent-host-claude:/untitled-1')),
			badId: claudeSessionIdFromAgentsWindow(URI.parse('agent-host-claude:/a/b')),
			empty: claudeSessionIdFromAgentsWindow(URI.parse('agent-host-claude:/')),
		}, {
			resource: `agent-host-claude:/${id}`,
			roundTrip: id,
			agentHost: id,
			fromString: id,
			otherProvider: undefined,
			remoteHost: undefined,
			untitled: undefined,
			badId: undefined,
			empty: undefined,
		});
	});
});
