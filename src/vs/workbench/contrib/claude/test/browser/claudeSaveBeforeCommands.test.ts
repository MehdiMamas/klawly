/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Emitter } from '../../../../../base/common/event.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ClaudeSaveBeforeCommandRequest, IClaudeRuntimeService } from '../../../../../platform/claude/common/claude.js';
import { IConfirmation, IConfirmationResult, IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { ClaudeAgentSession, IClaudeAgentService } from '../../../../services/claude/common/claudeAgentService.js';
import { IWorkingCopy, WorkingCopyCapabilities } from '../../../../services/workingCopy/common/workingCopy.js';
import { IWorkingCopyService } from '../../../../services/workingCopy/common/workingCopyService.js';
import { ClaudeSaveBeforeCommandsContribution } from '../../browser/claudeSaveBeforeCommands.js';

suite('Claude save before commands contribution', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function setup(options: { confirmed: boolean; failSave?: boolean }) {
		const requests = store.add(new Emitter<ClaudeSaveBeforeCommandRequest>());
		const log: string[] = [];
		let answered: () => void = () => { };
		const runtime = {
			onDidRequestSaveBeforeCommand: requests.event,
			resolveSaveBeforeCommand: async (sessionId: string, requestId: string) => {
				log.push(`resolve ${sessionId} ${requestId}`);
				answered();
			},
		} as Partial<IClaudeRuntimeService> as IClaudeRuntimeService;
		const agent = {
			getSessions: () => [{ id: 'pane-1' } as ClaudeAgentSession],
			getRuntimeSessionId: (id: string) => id === 'pane-1' ? 'runtime-1' : undefined,
		} as Partial<IClaudeAgentService> as IClaudeAgentService;
		const copy = (name: string, capabilities: WorkingCopyCapabilities) => ({
			capabilities,
			save: async () => {
				if (options.failSave) {
					throw new Error('disk full');
				}
				log.push(`save ${name}`);
				return true;
			},
		}) as Partial<IWorkingCopy> as IWorkingCopy;
		const workingCopies = {
			dirtyWorkingCopies: [copy('a.ts', WorkingCopyCapabilities.None), copy('Untitled-1', WorkingCopyCapabilities.Untitled)],
		} as Partial<IWorkingCopyService> as IWorkingCopyService;
		const dialogs = {
			confirm: async (confirmation: IConfirmation): Promise<IConfirmationResult> => {
				log.push(`ask ${confirmation.message} | ${confirmation.detail}`);
				return { confirmed: options.confirmed };
			},
		} as Partial<IDialogService> as IDialogService;
		store.add(new ClaudeSaveBeforeCommandsContribution(runtime, agent, workingCopies, dialogs));
		const fire = (request: ClaudeSaveBeforeCommandRequest) => new Promise<void>(resolve => {
			answered = resolve;
			requests.fire(request);
		});
		return { requests, log, fire };
	}

	test('prompt asks with the command, saves only files on disk, and answers the runtime', async () => {
		const h = setup({ confirmed: true });
		await h.fire({ sessionId: 'runtime-1', requestId: 'r1', command: 'npm test', mode: 'prompt' });
		assert.deepStrictEqual(h.log, [
			'ask Save 1 unsaved file before Claude runs a command? | npm test',
			'save a.ts',
			'resolve runtime-1 r1',
		]);
	});

	test('a declined question or a failed save still lets the command run', async () => {
		const declined = setup({ confirmed: false });
		await declined.fire({ sessionId: 'runtime-1', requestId: 'r2', command: 'make', mode: 'prompt' });
		const failed = setup({ confirmed: true, failSave: true });
		await failed.fire({ sessionId: 'runtime-1', requestId: 'r3', command: 'make', mode: 'always' });
		assert.deepStrictEqual([declined.log, failed.log], [
			['ask Save 1 unsaved file before Claude runs a command? | make', 'resolve runtime-1 r2'],
			['resolve runtime-1 r3'],
		]);
	});

	test('a request for a session another window owns is ignored', async () => {
		const h = setup({ confirmed: true });
		h.requests.fire({ sessionId: 'runtime-elsewhere', requestId: 'r4', command: 'make', mode: 'always' });
		await new Promise(resolve => setTimeout(resolve, 10));
		assert.deepStrictEqual(h.log, []);
	});
});
