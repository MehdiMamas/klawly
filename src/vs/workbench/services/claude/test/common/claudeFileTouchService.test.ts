/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Emitter } from '../../../../../base/common/event.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NormalizedClaudeEvent } from '../../../../../platform/claude/common/claudeProtocol.js';
import { IClaudeAgentService } from '../../common/claudeAgentService.js';
import { ClaudeFileTouchService } from '../../common/claudeFileTouchService.js';

/** Issue 1176: the service that follows agents' edits from the tool events. */
suite('Claude file touch service', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function setup() {
		const events = store.add(new Emitter<NormalizedClaudeEvent>());
		const service = store.add(new ClaudeFileTouchService({ onDidReceiveEvent: events.event } as unknown as IClaudeAgentService));
		const changes: (readonly string[])[] = [];
		store.add(service.onDidChange(paths => changes.push(paths)));
		return { events, service, changes };
	}

	function edit(sessionId: string, id: string, file: string, parentRunId?: string): NormalizedClaudeEvent {
		return { type: 'tool.started', sessionId, parentRunId, call: { id, name: 'Edit', category: 'edit', input: { file_path: file }, display: { title: 'Edit' } } } as unknown as NormalizedClaudeEvent;
	}

	test('an edit shows its agent while it runs and marks the file changed when it succeeds', () => {
		const { events, service, changes } = setup();
		events.fire(edit('s1', 'c1', '/repo/a.ts'));
		assert.deepStrictEqual(service.petsOf('/repo/a.ts').active.map(touch => touch.agent.agentId), ['s1']);
		events.fire({ type: 'tool.completed', sessionId: 's1', callId: 'c1', result: { ok: true } } as unknown as NormalizedClaudeEvent);
		const pets = service.petsOf('/repo/a.ts');
		assert.deepStrictEqual({ active: pets.active.length, changedBy: pets.changedBy?.agentId, changes }, { active: 0, changedBy: 's1', changes: [['/repo/a.ts'], ['/repo/a.ts']] });
	});

	test('two agents on one file are a conflict, a subagent is its own agent', () => {
		const { events, service } = setup();
		events.fire({ type: 'subagent.started', sessionId: 's1', run: { id: 'r1', description: 'Fix tests' } } as unknown as NormalizedClaudeEvent);
		events.fire(edit('s1', 'c1', '/repo/a.ts'));
		events.fire(edit('s1', 'c2', '/repo/a.ts', 'r1'));
		const pets = service.petsOf('/repo/a.ts');
		assert.deepStrictEqual({ conflict: pets.conflict, ids: pets.active.map(touch => touch.agent.agentId).sort(), name: pets.active.find(touch => touch.agent.agentId === 's1:r1')?.agent.name }, { conflict: true, ids: ['s1', 's1:r1'], name: 'Fix tests' });
	});

	test('a finished turn clears what its agent still held, and review clears the changed mark', () => {
		const { events, service } = setup();
		events.fire(edit('s1', 'c1', '/repo/a.ts'));
		events.fire({ type: 'session.completed', sessionId: 's1' } as unknown as NormalizedClaudeEvent);
		assert.strictEqual(service.petsOf('/repo/a.ts').active.length, 0);
		events.fire(edit('s1', 'c2', '/repo/b.ts'));
		events.fire({ type: 'tool.completed', sessionId: 's1', callId: 'c2', result: { ok: true } } as unknown as NormalizedClaudeEvent);
		service.markReviewed('/repo/b.ts');
		assert.strictEqual(service.petsOf('/repo/b.ts').changedBy, undefined);
	});

	test('calls that are not edits change nothing', () => {
		const { events, changes } = setup();
		events.fire({ type: 'tool.started', sessionId: 's1', call: { id: 'c1', name: 'Read', category: 'read', input: { file_path: '/repo/a.ts' }, display: { title: 'Read' } } } as unknown as NormalizedClaudeEvent);
		assert.deepStrictEqual(changes, []);
	});
});
