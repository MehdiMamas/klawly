/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IClaudeRuntimeService } from '../../../../../platform/claude/common/claude.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IWorkspacesService } from '../../../../../platform/workspaces/common/workspaces.js';
import { IClaudeAgentService } from '../../common/claudeAgentService.js';
import { ClaudeStartAgentHandler } from '../../common/claudeStartAgentHandler.js';

/** Issue 991: a started chat gets the starter's mode and permissions and its first message. */
suite('Claude start agent handler', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	function setup(recent: string[] = []) {
		const calls: string[] = [];
		const agent = {
			getSessions: () => [{ id: 'owner', mode: 'plan', title: 'Owner' }],
			createSession: () => ({ id: 'new', title: 'New chat' }),
			pinWorkingDirectory: (id: string, folder: string) => { calls.push(`pin ${id} ${URI.file(folder).fsPath === folder ? 'folder' : folder}`); },
			setMode: (id: string, mode: string) => { calls.push(`mode ${id} ${mode}`); },
			getSessionPermissions: () => ({ autoReview: true }),
			setSessionPermissions: (id: string, value: { autoReview: boolean }) => { calls.push(`perms ${id} ${value.autoReview}`); },
			renameSession: async (id: string, title: string) => { calls.push(`rename ${id} ${title}`); },
			submit: async (id: string, text: string) => { calls.push(`submit ${id} ${text}`); },
		} as unknown as IClaudeAgentService;
		const workspace = { getWorkspace: () => ({ folders: [{ uri: URI.file('/work/klawly') }] }) } as unknown as IWorkspaceContextService;
		const workspaces = { getRecentlyOpened: async () => ({ workspaces: recent.map(path => ({ folderUri: URI.file(path) })) }) } as unknown as IWorkspacesService;
		const handler = new ClaudeStartAgentHandler(agent, {} as IClaudeRuntimeService, workspace, workspaces);
		return { handler, calls };
	}

	test('starts a chat in the current project with the starter\'s mode and permissions', async () => {
		const { handler, calls } = setup();
		const result = await handler.start({ sessionId: 'rt', requestId: 'r', prompt: 'Do it', title: 'Job' }, 'owner');
		assert.deepStrictEqual({ result, calls }, {
			result: { kind: 'started', title: 'Job', project: 'klawly' },
			calls: ['pin new folder', 'mode new plan', 'perms new true', 'rename new Job', 'submit new Do it'],
		});
		handler.dispose();
	});

	test('an unknown project fails and starts nothing', async () => {
		const { handler, calls } = setup();
		const result = await handler.start({ sessionId: 'rt', requestId: 'r', prompt: 'Do it', project: 'nowhere' }, 'owner');
		assert.deepStrictEqual({ kind: result.kind, calls }, { kind: 'failed', calls: [] });
		handler.dispose();
	});

	test('an empty prompt fails', async () => {
		const { handler } = setup();
		const result = await handler.start({ sessionId: 'rt', requestId: 'r', prompt: ' ' }, 'owner');
		assert.strictEqual(result.kind, 'failed');
		handler.dispose();
	});
});
