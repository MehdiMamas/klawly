/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { isWindows } from '../../../../../base/common/platform.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { CommandsRegistry } from '../../../../../platform/commands/common/commands.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { AgentActionRequest, IClaudeActionService } from '../../../../../platform/claude/common/claudeActions.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IViewsService } from '../../../../services/views/common/viewsService.js';
import { ISCMService } from '../../../scm/common/scm.js';
import { CLAUDE_RESOLVE_CONFLICTS_COMMAND_ID, registerClaudeMergeConflictActions } from '../../browser/claudeMergeConflictActions.js';

suite('Claude merge conflict actions', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('Resolve with Claude attaches both sides and recent commits of the clicked Merge Changes group, and says so when there is nothing to resolve', async () => {
		if (!CommandsRegistry.getCommand(CLAUDE_RESOLVE_CONFLICTS_COMMAND_ID)) {
			registerClaudeMergeConflictActions();
		}
		const root = URI.file(isWindows ? 'C:\\repo' : '/repo');
		const prices = URI.joinPath(root, 'src', 'prices.ts');
		const texts = new Map<string, string>([
			[prices.toString(), '<<<<<<< HEAD\na\n=======\nb\n>>>>>>> feature\n'],
			[stage(prices, 1), 'base\n'],
			[stage(prices, 2), 'a\n'],
			[stage(prices, 3), 'b\n'],
		]);
		const merge = { id: 'merge', resources: [{ sourceUri: prices }] as object[], provider: {} };
		const history = {
			historyItemRef: { get: () => ({ name: 'main' }) },
			provideHistoryItems: async (options: { historyItemRefs: string[] }) => options.historyItemRefs[0] === 'HEAD'
				? [{ id: 'aaaaaaaa11', subject: 'Raise tax' }]
				: options.historyItemRefs[0] === 'MERGE_HEAD'
					? [{ id: 'bbbbbbbb22', subject: 'Change currency', references: [{ id: 'refs/heads/feature', name: 'feature' }] }]
					: [],
		};
		const repository = { provider: { providerId: 'git', rootUri: root, groups: [merge], historyProvider: { get: () => history } } };
		const requests: AgentActionRequest[] = [];
		const infos: string[] = [];
		const services = new Map<unknown, unknown>([
			[ISCMService, { repositories: [repository] }],
			[IFileService, {
				readFile: async (uri: URI) => {
					const text = texts.get(uri.toString());
					if (text === undefined) {
						throw new Error('not found');
					}
					return { value: VSBuffer.fromString(text) };
				},
			}],
			[IEditorService, { activeEditor: undefined }],
			[INotificationService, { info: (message: string) => infos.push(message) }],
			[IViewsService, { openView: async () => undefined }],
			[IClaudeActionService, { run: async (request: AgentActionRequest) => { requests.push(request); } }],
		]);
		const accessor: ServicesAccessor = { get: id => services.get(id) as never };
		const command = CommandsRegistry.getCommand(CLAUDE_RESOLVE_CONFLICTS_COMMAND_ID);
		assert.ok(command);

		await command.handler(accessor, merge);
		merge.resources = [];
		await command.handler(accessor, merge);

		assert.deepStrictEqual({
			ids: requests.map(request => request.id),
			attachments: requests[0].attachments.map(attachment => attachment.kind === 'pasted-text' ? attachment.text : attachment.kind),
			infos,
		}, {
			ids: ['resolveConflicts'],
			attachments: [
				'Merge conflicts\n\nOurs (stage 2): main (HEAD)\n  aaaaaaaa Raise tax\nTheirs (stage 3): feature (MERGE_HEAD)\n  bbbbbbbb Change currency\n\nConflicted files:\n- src/prices.ts (1 conflict)',
				'File: src/prices.ts (1 conflict)\n\n--- Merge base (stage 1)\nbase\n\n\n--- Ours (stage 2)\na\n\n\n--- Theirs (stage 3)\nb\n',
			],
			infos: ['There are no merge conflicts to resolve.'],
		});
	});
});

function stage(uri: URI, index: number): string {
	return uri.with({ scheme: 'git', query: JSON.stringify({ path: uri.fsPath, ref: `:${index}` }) }).toString();
}
