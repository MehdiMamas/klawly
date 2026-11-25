/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { MarkerSeverity } from '../../../../../platform/markers/common/markers.js';
import { CLAUDE_DIAGNOSTICS_HARD_CAP, readClaudeDiagnosticsAutoVerify, readClaudeDiagnosticsMaxCycles, readClaudeDiagnosticsSettleMs } from '../../../../../platform/claude/common/claudeConfiguration.js';
import { compileSubmission, DiagnosticSummary, resolveAgentAction } from '../../../../../platform/claude/common/claudePrompt.js';
import { resolveContextEnvelope } from '../../../../../platform/claude/common/claudeContextResolve.js';
import { chooseFixProblems, commandFailureText, DIAGNOSTIC_SEND_LIMIT, DiagnosticsClock, DiagnosticsLoop, newErrorDiagnostics, toDiagnosticSummary, touchedUrisFromOriginals } from '../../common/claudeDiagnostics.js';

suite('Claude diagnostics loop', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const file = 'file:///repo/src/a.ts';
	const other = 'file:///repo/src/b.ts';
	const oldError = problem(file, 1, 1, 'old', '100');
	const fresh = problem(file, 12, 4, 'Type \'x\' is not assignable.', '2322');
	const warning = { ...problem(file, 3, 1, 'unused', '6133'), severity: 'warning' as const };
	const elsewhere = problem(other, 2, 2, 'missing name', '2304');

	test('sends only new errors from files the turn wrote', () => {
		const touched = touchedUrisFromOriginals([
			{ uri: file, capturedAs: 'write' },
			{ uri: 'file:///repo/src/dirty.ts', capturedAs: 'buffer' },
		], []);
		assert.deepStrictEqual(touched, [file]);
		const found = newErrorDiagnostics([oldError], [oldError, fresh, warning, elsewhere], touched);
		assert.deepStrictEqual(found, [fresh]);
	});

	test('a marker becomes a precise diagnostic', () => {
		const item = toDiagnosticSummary({
			uri: file,
			path: 'src/a.ts',
			severity: MarkerSeverity.Error,
			line: 12,
			column: 4,
			source: 'ts',
			code: '2322',
			message: 'Type \'x\' is not assignable.',
		});
		assert.deepStrictEqual(item, fresh);
		assert.strictEqual(toDiagnosticSummary({ ...fresh, uri: file, severity: MarkerSeverity.Hint, line: 1, column: 1, message: 'hint' }), undefined);
	});

	test('the compiled prompt contains the exact diagnostic', async () => {
		let readMarkers = false;
		const envelope = await resolveContextEnvelope('Fix the attached problems.', 'agent', [{
			kind: 'diagnostics',
			items: [fresh],
		}], {
			relativePath: uri => uri,
			readText: async () => undefined,
			readMarkers: async () => {
				readMarkers = true;
				return [];
			},
			readGit: async () => ({ stat: '', patch: '', truncated: false }),
			readTerminal: async () => { throw new Error('terminal'); },
			activeEditor: () => undefined,
			workspaceRoot: () => '/repo',
		});
		const compiled = compileSubmission(envelope, { kind: 'prompt', templateId: 'fix-problems' });
		assert.strictEqual(readMarkers, false);
		assert.ok(compiled.includes('uri="file:///repo/src/a.ts"'));
		assert.ok(compiled.includes('path="src/a.ts"'));
		assert.ok(compiled.includes('line="12"'));
		assert.ok(compiled.includes('column="4"'));
		assert.ok(compiled.includes('source="ts"'));
		assert.ok(compiled.includes('code="2322"'));
		assert.ok(compiled.includes('message="Type \'x\' is not assignable."'));
	});

	test('a failed command sends its exact output', async () => {
		const secret = 'sk-ant-api03-secretvalue';
		const text = commandFailureText({
			command: 'npm test',
			cwd: '/repo',
			exitCode: 1,
			lines: ['FAIL src/a.test.ts', 'Expected 1 to equal 2', secret],
			error: `token=${secret}`,
		});
		assert.strictEqual(text.includes(secret), false);
		assert.ok(text.includes('[redacted]'));
		const terminalCalls: number[] = [];
		const envelope = await resolveContextEnvelope('Fix the error in the attached terminal output.', 'agent', [{
			kind: 'terminal',
			terminalId: 0,
			lines: 200,
			title: 'npm test',
			text,
		}], {
			relativePath: uri => uri,
			readText: async () => undefined,
			readMarkers: async () => [],
			readGit: async () => ({ stat: '', patch: '', truncated: false }),
			readTerminal: async (terminalId: number) => {
				terminalCalls.push(terminalId);
				return undefined;
			},
			activeEditor: () => undefined,
			workspaceRoot: () => '/repo',
		});
		const compiled = compileSubmission(envelope, { kind: 'prompt', templateId: 'fix-terminal-error' });
		assert.deepStrictEqual(terminalCalls, []);
		assert.strictEqual(compiled.includes(secret), false);
		assert.ok(compiled.includes('[redacted]'));
		assert.ok(compiled.includes('exit code: 1'));
		assert.ok(compiled.includes('Expected 1 to equal 2'));
		assert.ok(compiled.includes('$ npm test'));
	});

	test('fix problems prefers the fix skill and fix this error stays on the template', () => {
		assert.deepStrictEqual(resolveAgentAction('fixProblems', { slashCommands: [], skills: ['fix'], preferClaudeCommands: true }), { kind: 'skill', skill: 'fix' });
		assert.deepStrictEqual(resolveAgentAction('fixProblems', { slashCommands: [], skills: [], preferClaudeCommands: true }), { kind: 'prompt', templateId: 'fix-problems' });
		assert.deepStrictEqual(resolveAgentAction('fixTerminalError', { slashCommands: ['fix'], skills: ['fix'], preferClaudeCommands: true }), { kind: 'prompt', templateId: 'fix-terminal-error' });
	});

	test('auto-verify stops at the hard cap and a quiet wait can be forced', () => {
		assert.strictEqual(readClaudeDiagnosticsAutoVerify(undefined), false);
		assert.strictEqual(readClaudeDiagnosticsAutoVerify(true), true);
		assert.strictEqual(readClaudeDiagnosticsMaxCycles(100), CLAUDE_DIAGNOSTICS_HARD_CAP);
		assert.strictEqual(readClaudeDiagnosticsMaxCycles(0), 1);
		assert.strictEqual(readClaudeDiagnosticsSettleMs(-5), 0);

		const clock = new FakeClock();
		let current: DiagnosticSummary[] = [oldError];
		const autos: DiagnosticSummary[][] = [];
		const loop = new DiagnosticsLoop(clock, () => current, () => ({
			settleMs: 100,
			maxWaitMs: 500,
			autoVerify: true,
			maxCycles: CLAUDE_DIAGNOSTICS_HARD_CAP,
		}), () => undefined, problems => {
			autos.push(problems.slice());
			loop.claimAutoTurn(`t${autos.length + 1}`);
		});

		loop.noteRunning('t1');
		current = [oldError, fresh];
		loop.startSettle('t1', [file]);
		clock.advance(50);
		assert.strictEqual(autos.length, 0);
		loop.markersChanged();
		clock.advance(50);
		assert.strictEqual(autos.length, 0);
		clock.advance(100);
		assert.deepStrictEqual(autos[0], [fresh]);

		for (let cycle = 1; cycle < CLAUDE_DIAGNOSTICS_HARD_CAP + 2; cycle++) {
			const id = `t${cycle + 1}`;
			loop.noteRunning(id);
			loop.startSettle(id, [file]);
			clock.advance(100);
		}
		assert.strictEqual(autos.length, CLAUDE_DIAGNOSTICS_HARD_CAP);
		assert.deepStrictEqual(autos[CLAUDE_DIAGNOSTICS_HARD_CAP - 1], [fresh]);
		loop.dispose();
	});

	test('marker changes do not delay collection past the max wait', () => {
		const clock = new FakeClock();
		let current: DiagnosticSummary[] = [];
		const reported: DiagnosticSummary[][] = [];
		const loop = new DiagnosticsLoop(clock, () => current, () => ({
			settleMs: 200,
			maxWaitMs: 500,
			autoVerify: false,
			maxCycles: 1,
		}), (_id, problems) => reported.push(problems.slice()), () => undefined);
		loop.noteRunning('t1');
		current = [fresh];
		loop.startSettle('t1', [file]);
		for (let at = 0; at < 400; at += 50) {
			clock.advance(50);
			loop.markersChanged();
		}
		assert.strictEqual(reported.length, 0);
		clock.advance(100);
		assert.deepStrictEqual(reported[0], [fresh]);
		loop.dispose();
	});

	test('an unconsumed auto-verify arm does not capture the next user turn', () => {
		const clock = new FakeClock();
		let current: DiagnosticSummary[] = [oldError];
		const autos: DiagnosticSummary[][] = [];
		const loop = new DiagnosticsLoop(clock, () => current, () => ({
			settleMs: 0,
			maxWaitMs: 500,
			autoVerify: true,
			maxCycles: 1,
		}), () => undefined, problems => autos.push(problems.slice()));
		loop.noteRunning('t1');
		current = [oldError, fresh];
		loop.startSettle('t1', [file]);
		assert.deepStrictEqual(autos[0], [fresh]);
		loop.noteRunning('user');
		loop.startSettle('user', [file]);
		assert.deepStrictEqual(loop.get('user'), []);
		const another = problem(file, 20, 1, 'another', '2304');
		loop.noteRunning('user2');
		current = [oldError, fresh, another];
		loop.startSettle('user2', [file]);
		assert.deepStrictEqual(loop.get('user2'), [another]);
		assert.deepStrictEqual(autos[1], [another]);
		assert.strictEqual(autos.length, 2);
		loop.dispose();
	});

	test('auto-verify keeps the chain baseline only for the turn the fix action starts', () => {
		const clock = new FakeClock();
		let current: DiagnosticSummary[] = [oldError];
		const loop = new DiagnosticsLoop(clock, () => current, () => ({
			settleMs: 0,
			maxWaitMs: 500,
			autoVerify: true,
			maxCycles: 2,
		}), () => undefined, () => loop.claimAutoTurn('fix'));
		loop.noteRunning('t1');
		current = [oldError, fresh];
		loop.startSettle('t1', [file]);
		loop.noteRunning('fix');
		loop.startSettle('fix', [file]);
		assert.deepStrictEqual(loop.get('fix'), [fresh]);
		loop.dispose();
	});

	test('a session change drops an auto-verify arm before the next turn', () => {
		const clock = new FakeClock();
		let current: DiagnosticSummary[] = [oldError];
		const loop = new DiagnosticsLoop(clock, () => current, () => ({
			settleMs: 0,
			maxWaitMs: 500,
			autoVerify: true,
			maxCycles: 2,
		}), () => undefined, () => loop.claimAutoTurn('fix'));
		loop.noteRunning('t1');
		current = [oldError, fresh];
		loop.startSettle('t1', [file]);
		loop.cancelAutoArm();
		loop.noteRunning('fix');
		loop.startSettle('fix', [file]);
		assert.deepStrictEqual(loop.get('fix'), []);
		loop.dispose();
	});

	test('forgetting a session drops that turn so a later one can settle again', () => {
		const clock = new FakeClock();
		let current: DiagnosticSummary[] = [];
		const loop = new DiagnosticsLoop(clock, () => current, () => ({
			settleMs: 0,
			maxWaitMs: 500,
			autoVerify: false,
			maxCycles: 1,
		}), () => undefined, () => undefined);
		loop.noteRunning('t1');
		current = [fresh];
		loop.startSettle('t1', [file]);
		assert.deepStrictEqual(loop.get('t1'), [fresh]);
		loop.forget(['t1']);
		assert.strictEqual(loop.get('t1'), undefined);
		assert.strictEqual(loop.hasResult('t1'), false);
		current = [];
		loop.noteRunning('t1');
		current = [fresh];
		loop.startSettle('t1', [file]);
		assert.deepStrictEqual(loop.get('t1'), [fresh]);
		loop.dispose();
	});

	test('Fix Problems caps selected markers, the active editor, and every marker', () => {
		const many = Array.from({ length: DIAGNOSTIC_SEND_LIMIT + 5 }, (_value, index) => problem(file, index + 1, 1, `e${index}`, '1'));
		const selected = chooseFixProblems({ selected: many, allMarkers: [fresh] });
		assert.strictEqual(selected.truncated, true);
		assert.strictEqual(selected.total, many.length);
		assert.strictEqual(selected.items.length, DIAGNOSTIC_SEND_LIMIT);
		assert.strictEqual(selected.items[0].message, 'e0');
		const editor = chooseFixProblems({ activeEditor: many, allMarkers: [fresh] });
		assert.strictEqual(editor.truncated, true);
		assert.strictEqual(editor.items.length, DIAGNOSTIC_SEND_LIMIT);
		assert.notStrictEqual(editor.items[0].message, fresh.message);
		const all = chooseFixProblems({ allMarkers: many });
		assert.strictEqual(all.truncated, true);
		assert.strictEqual(all.items.length, DIAGNOSTIC_SEND_LIMIT);
		const emptyEditor = chooseFixProblems({ activeEditor: [], allMarkers: many });
		assert.deepStrictEqual(emptyEditor.items, []);
		assert.strictEqual(emptyEditor.truncated, false);
		const under = chooseFixProblems({ selected: [fresh], allMarkers: many });
		assert.deepStrictEqual(under.items, [fresh]);
		assert.strictEqual(under.truncated, false);
	});
});

function problem(uri: string, line: number, column: number, message: string, code: string): DiagnosticSummary {
	return { uri, path: uri.slice('file:///repo/'.length), severity: 'error', line, column, source: 'ts', code, message };
}

class FakeClock implements DiagnosticsClock {
	private time = 0;
	private readonly timers: { at: number; run: () => void; disposed: boolean }[] = [];

	now(): number {
		return this.time;
	}

	schedule(delayMs: number, run: () => void): { dispose(): void } {
		const timer = { at: this.time + delayMs, run, disposed: false };
		this.timers.push(timer);
		return { dispose: () => { timer.disposed = true; } };
	}

	advance(ms: number): void {
		this.time += ms;
		for (let guard = 0; guard < 20; guard++) {
			const due = this.timers.filter(timer => !timer.disposed && timer.at <= this.time).sort((left, right) => left.at - right.at);
			const next = due[0];
			if (!next) {
				return;
			}
			next.disposed = true;
			next.run();
		}
	}
}
