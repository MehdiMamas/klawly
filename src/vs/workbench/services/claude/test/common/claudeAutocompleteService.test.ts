/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { timeout } from '../../../../../base/common/async.js';
import { CancellationToken, CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { Emitter } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { runWithFakedTimers } from '../../../../../base/test/common/timeTravelScheduler.js';
import { ConfigurationTarget, IConfigurationChangeEvent, IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { ClaudeInlineCompletionRequest, CompletionInput, inlineInsertText } from '../../../../../platform/claude/common/claudeAutocomplete.js';
import { CLAUDE_AUTOCOMPLETE_DEBOUNCE_SETTING, CLAUDE_AUTOCOMPLETE_ENABLED_SETTING, CLAUDE_AUTOCOMPLETE_MODEL_SETTING } from '../../../../../platform/claude/common/claudeConfiguration.js';
import { IClaudeRuntimeService } from '../../../../../platform/claude/common/claude.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IOutputService } from '../../../output/common/output.js';
import { ClaudeAutocompleteService } from '../../common/claudeAutocompleteService.js';
import { IClaudeKlawlyHooksService } from '../../common/claudeKlawlyHooksService.js';

suite('Claude autocomplete service', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('a disabled Tab requests nothing and applies nothing', async () => {
		const harness = open(store);
		harness.settings[CLAUDE_AUTOCOMPLETE_ENABLED_SETTING] = false;
		assert.strictEqual(await harness.service.provideCompletion(sample(), CancellationToken.None), undefined);
		assert.strictEqual(harness.calls.length, 0);

		harness.settings[CLAUDE_AUTOCOMPLETE_ENABLED_SETTING] = true;
		let release!: () => void;
		harness.gate = new Promise<void>(resolve => { release = resolve; });
		const pending = harness.service.provideCompletion(sample(), CancellationToken.None);
		await timeout(180);
		assert.strictEqual(harness.calls.length, 1);
		harness.settings[CLAUDE_AUTOCOMPLETE_ENABLED_SETTING] = false;
		release();
		assert.strictEqual(await pending, undefined);
	});

	test('a snooze pauses Tab until it ends or is resumed, and announces each change', async () => {
		const harness = open(store);
		let changes = 0;
		store.add(harness.service.onDidChangeEnablement(() => changes++));
		const before = Date.now();
		harness.service.snooze(30);
		const until = harness.service.snoozedUntil() ?? 0;
		const snoozed = { enabled: harness.service.enabled(), result: await harness.service.provideCompletion(sample(), CancellationToken.None), calls: harness.calls.length, about30Minutes: until - before >= 30 * 60_000 && until - Date.now() <= 30 * 60_000 };
		harness.service.resume();
		const resumed = { enabled: harness.service.enabled(), until: harness.service.snoozedUntil() };
		harness.service.snooze(0.001);
		await timeout(150);
		const expired = { enabled: harness.service.enabled(), until: harness.service.snoozedUntil() };
		harness.service.snooze(0);
		harness.fireDisabled();
		assert.deepStrictEqual({ snoozed, resumed, expired, enabledAfterIgnoredSnooze: harness.service.snoozedUntil(), changes }, {
			snoozed: { enabled: false, result: undefined, calls: 0, about30Minutes: true },
			resumed: { enabled: true, until: undefined },
			expired: { enabled: true, until: undefined },
			enabledAfterIgnoredSnooze: undefined,
			changes: 5,
		});
	});

	test('a result is dropped when the document version or cursor changed', async () => {
		const harness = open(store);
		const uri = sample().uri;

		let releaseVersion!: () => void;
		harness.gate = new Promise<void>(resolve => { releaseVersion = resolve; });
		const versioned = harness.service.provideCompletion(sample(), CancellationToken.None);
		await timeout(180);
		assert.strictEqual(harness.calls.length, 1);
		harness.service.noteDocument(uri, 2, sample().position);
		releaseVersion();
		assert.strictEqual(await versioned, undefined);

		let releaseCursor!: () => void;
		harness.gate = new Promise<void>(resolve => { releaseCursor = resolve; });
		const moved = harness.service.provideCompletion(sample({ versionId: 2 }), CancellationToken.None);
		await timeout(180);
		harness.service.noteDocument(uri, 2, { lineNumber: 1, column: 9 });
		releaseCursor();
		assert.strictEqual(await moved, undefined);
		assert.strictEqual(harness.calls.length, 2);
	});

	test('cancellation and a newer keystroke drop the older request', async () => {
		const harness = open(store);
		const tokens = store.add(new CancellationTokenSource());
		const cancelled = harness.service.provideCompletion(sample(), tokens.token);
		tokens.cancel();
		assert.strictEqual(await cancelled, undefined);
		assert.strictEqual(harness.calls.length, 0);

		const first = harness.service.provideCompletion(sample(), CancellationToken.None);
		const second = harness.service.provideCompletion(sample({ prefix: 'const value' }), CancellationToken.None);
		assert.strictEqual(await first, undefined);
		const applied = await second;
		assert.strictEqual(applied?.kind, 'inline');
		if (applied?.kind === 'inline') {
			assert.strictEqual(applied.insertText, 'const value = 1;');
		}
		assert.strictEqual(harness.calls.length, 1);
		assert.strictEqual(harness.calls[0].model, 'tab-model');
		assert.ok(harness.calls[0].prompt.includes('Do not explain.'));
		assert.ok(harness.calls[0].prompt.includes('recent-token'));
	});

	test('a fresh result is cached and a cross-file result is not inserted', async () => {
		const harness = open(store);
		const first = await harness.service.provideCompletion(sample(), CancellationToken.None);
		const second = await harness.service.provideCompletion(sample(), CancellationToken.None);
		assert.strictEqual(first?.kind, 'inline');
		assert.deepStrictEqual(second, first);
		assert.strictEqual(harness.calls.length, 1);
		const measured = harness.service.latency();
		assert.strictEqual(measured?.count, 1);
		assert.ok(measured && measured.p50 >= 0 && measured.p95 >= measured.p50);
		assert.strictEqual(harness.lines.length, 0);
		const logged = harness.service.logLatency();
		assert.ok(logged.includes('p50=') && logged.includes('p95='));
		assert.ok(harness.lines.some(line => line.includes('p50=') && line.includes('p95=')));

		harness.text = 'NEXT receipt.ts:21\nconst total = 1;';
		const next = await harness.service.provideCompletion(sample({ prefix: 'other', fileText: 'other-file' }), CancellationToken.None);
		assert.strictEqual(next?.kind, 'next-edit');
		assert.strictEqual(inlineInsertText(next!), undefined);
		if (next?.kind === 'next-edit') {
			assert.strictEqual(next.fileName, 'receipt.ts');
			assert.strictEqual(next.line, 21);
			assert.strictEqual(next.preview, 'const total = 1;');
			assert.strictEqual(next.target.path.endsWith('/receipt.ts'), true);
		}
		const shown = harness.service.peekNextEdit(sample().uri);
		assert.strictEqual(shown?.kind, 'next-edit');
	});

	test('an armed preview replaces that line only at the same version', () => {
		const harness = open(store);
		const uri = URI.file('C:/repo/receipt.ts');
		harness.service.armPreview(uri, 3, 21, 'const total = 1;');
		assert.strictEqual(harness.service.consumePreview(uri, 4, 21), undefined);
		harness.service.armPreview(uri, 3, 21, 'const total = 1;');
		assert.strictEqual(harness.service.consumePreview(uri, 3, 22), undefined);
		harness.service.armPreview(uri, 3, 21, 'const total = 1;');
		assert.deepStrictEqual(harness.service.consumePreview(uri, 3, 21), { text: 'const total = 1;', lineNumber: 21 });
		assert.strictEqual(harness.service.consumePreview(uri, 3, 21), undefined);

		harness.settings[CLAUDE_AUTOCOMPLETE_ENABLED_SETTING] = false;
		harness.service.armPreview(uri, 3, 21, 'const total = 1;');
		assert.strictEqual(harness.service.consumePreview(uri, 3, 21), undefined);
	});

	test('secret files never call the runtime', async () => {
		const harness = open(store);
		assert.strictEqual(await harness.service.provideCompletion(sample({
			uri: URI.file('C:/repo/.env'),
			uriPath: '/repo/.env',
			languageId: 'dotenv',
			lineText: 'API_KEY=value',
		}), CancellationToken.None), undefined);
		assert.strictEqual(harness.calls.length, 0);
	});

	test('a document edit is included in the next prompt', async () => {
		const harness = open(store);
		harness.service.recordRecentEdit({
			uri: sample().uri.toString(),
			before: 'const beforeToken',
			after: 'const afterToken',
			range: { startLineNumber: 2, startColumn: 1, endLineNumber: 2, endColumn: 5 },
			ageMs: 0,
		});
		await harness.service.provideCompletion(sample({
			prefix: 'edited',
			fileText: 'edited-file',
			recentEdits: harness.service.snapshotRecentEdits(),
		}), CancellationToken.None);
		assert.ok(harness.calls[0].prompt.includes('before: const beforeToken'));
		assert.ok(harness.calls[0].prompt.includes('after: const afterToken'));
	});

	test('a cancelled model call is not a latency sample', async () => {
		const harness = open(store);
		let release!: () => void;
		harness.gate = new Promise<void>(resolve => { release = resolve; });
		const pending = harness.service.provideCompletion(sample(), CancellationToken.None);
		await timeout(180);
		assert.strictEqual(harness.calls.length, 1);
		harness.service.cancelActive(sample().uri);
		release();
		assert.strictEqual(await pending, undefined);
		assert.strictEqual(harness.service.latency(), undefined);
		assert.strictEqual(harness.lines.length, 0);
		const shown = harness.service.logLatency();
		assert.ok(shown.includes('samples=0'));
		assert.ok(harness.lines.some(line => line.includes('samples=0')));
	});

	test('turning Tab off cancels the active request and drops the next edit', async () => {
		const harness = open(store);
		harness.text = 'NEXT receipt.ts:2\nconst total = 1;';
		const next = await harness.service.provideCompletion(sample({ prefix: 'cfg', fileText: 'cfg-file' }), CancellationToken.None);
		assert.strictEqual(next?.kind, 'next-edit');
		assert.ok(harness.service.peekNextEdit(sample().uri));
		harness.service.noteDocument(sample().uri, 1, sample().position, { id: 'ed', focused: true });
		harness.service.recordRecentEdit({
			uri: sample().uri.toString(),
			before: 'old',
			after: 'new',
			range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 4 },
			ageMs: 0,
		});

		let release!: () => void;
		harness.gate = new Promise<void>(resolve => { release = resolve; });
		const pending = harness.service.provideCompletion(sample({ prefix: 'cfg2', fileText: 'cfg2' }), CancellationToken.None);
		await timeout(180);
		const cancelsBefore = harness.cancels.length;
		harness.fireDisabled();
		assert.ok(harness.cancels.length > cancelsBefore);
		release();
		assert.strictEqual(await pending, undefined);
		assert.strictEqual(harness.service.peekNextEdit(sample().uri), undefined);
		assert.strictEqual(harness.service.notedPosition(sample().uri), undefined);
		assert.strictEqual(harness.service.snapshotRecentEdits().length, 0);
		assert.strictEqual(harness.service.latency()?.count, 1);
		harness.settings[CLAUDE_AUTOCOMPLETE_ENABLED_SETTING] = true;
		await harness.service.provideCompletion(sample({ prefix: 'cfg', fileText: 'cfg-file' }), CancellationToken.None);
		assert.strictEqual(harness.calls.length, 3);
	});

	test('a split editor does not move the focused cursor, and dispose clears that model', async () => {
		const harness = open(store);
		const uri = sample().uri;
		harness.service.noteDocument(uri, 1, sample().position, { id: 'left', focused: true });
		assert.strictEqual(harness.service.noteDocument(uri, 1, { lineNumber: 9, column: 4 }, { id: 'right', focused: false }), false);
		assert.deepStrictEqual(harness.service.notedPosition(uri), sample().position);
		assert.strictEqual(harness.service.releaseEditor('left'), false);
		assert.deepStrictEqual(harness.service.notedPosition(uri), { lineNumber: 9, column: 4 });
		harness.service.noteDocument(uri, 1, sample().position, { id: 'left', focused: true });

		harness.service.armPreview(uri, 1, sample().position.lineNumber, 'const total = 1;');
		harness.text = 'NEXT receipt.ts:2\nconst total = 1;';
		await harness.service.provideCompletion(sample({ prefix: 'split', fileText: 'split' }), CancellationToken.None);
		assert.ok(harness.service.peekNextEdit(uri));
		harness.service.forgetDocument(uri);
		assert.strictEqual(harness.service.notedPosition(uri), undefined);
		assert.strictEqual(harness.service.peekNextEdit(uri), undefined);
		assert.strictEqual(harness.service.consumePreview(uri, 1, sample().position.lineNumber), undefined);
	});

	test('accepting a next edit refuses a target outside the workspace', async () => {
		const harness = open(store);
		harness.text = 'NEXT ../secret.ts:3\nconst x = 1;';
		assert.strictEqual(await harness.service.provideCompletion(sample({ prefix: 'escape', fileText: 'escape' }), CancellationToken.None), undefined);
		harness.text = 'NEXT https://example.com/a.ts:4\nconst x = 1;';
		assert.strictEqual(await harness.service.provideCompletion(sample({ prefix: 'foreign', fileText: 'foreign' }), CancellationToken.None), undefined);

		harness.text = 'NEXT receipt.ts:2\nconst total = 1;';
		const next = await harness.service.provideCompletion(sample({ prefix: 'leave', fileText: 'leave' }), CancellationToken.None);
		assert.strictEqual(next?.kind, 'next-edit');
		harness.folders.length = 0;
		assert.strictEqual(harness.service.acceptNextEdit(sample().uri), undefined);
		assert.strictEqual(harness.service.peekNextEdit(sample().uri), undefined);
	});

	test('an unfocused version change drops an in-flight result and the next edit', async () => {
		const harness = open(store);
		const uri = sample().uri;
		harness.text = 'NEXT receipt.ts:2\nconst total = 1;';
		const next = await harness.service.provideCompletion(sample({ prefix: 'seed', fileText: 'seed-file' }), CancellationToken.None);
		assert.strictEqual(next?.kind, 'next-edit');
		assert.ok(harness.service.peekNextEdit(uri));
		harness.service.noteDocument(uri, 1, sample().position, { id: 'left', focused: true });

		harness.text = 'const value = 1;';
		let release!: () => void;
		harness.gate = new Promise<void>(resolve => { release = resolve; });
		const pending = harness.service.provideCompletion(sample({ prefix: 'inflight', fileText: 'inflight-file' }), CancellationToken.None);
		await timeout(180);
		assert.strictEqual(harness.calls.length, 2);
		const changed = harness.service.noteDocument(uri, 2, { lineNumber: 9, column: 4 }, { id: 'right', focused: false });
		assert.strictEqual(changed, true);
		assert.deepStrictEqual(harness.service.notedPosition(uri), sample().position);
		assert.strictEqual(harness.service.peekNextEdit(uri), undefined);
		release();
		assert.strictEqual(await pending, undefined);
	});

	test('a forgotten document does not let the old debounce win the next generation', async () => {
		const harness = open(store);
		const first = harness.service.provideCompletion(sample({ prefix: 'older', fileText: 'older-file' }), CancellationToken.None);
		harness.service.forgetDocument(sample().uri);
		const second = harness.service.provideCompletion(sample({ prefix: 'newer', fileText: 'newer-file' }), CancellationToken.None);
		assert.strictEqual(await first, undefined);
		const applied = await second;
		assert.strictEqual(applied?.kind, 'inline');
		assert.strictEqual(harness.calls.length, 1);
		assert.ok(harness.calls[0].prompt.includes('newer'));
		assert.strictEqual(harness.calls[0].prompt.includes('older'), false);
	});

	test('a prefetch leaves an in-flight request running and skips a stale cursor', async () => {
		const harness = open(store);
		const uri = sample().uri;
		harness.service.noteDocument(uri, 1, sample().position, { id: 'ed', focused: true });
		let release!: () => void;
		harness.gate = new Promise<void>(resolve => { release = resolve; });
		const pending = harness.service.provideCompletion(sample(), CancellationToken.None);
		await timeout(180);
		assert.strictEqual(harness.calls.length, 1);
		assert.strictEqual(await harness.service.prefetchCompletion(sample({ prefix: 'spec', fileText: 'spec-file' }), CancellationToken.None), undefined);
		assert.strictEqual(harness.calls.length, 1);
		release();
		assert.strictEqual((await pending)?.kind, 'inline');
		assert.strictEqual(harness.calls.length, 1);

		harness.gate = undefined;
		assert.strictEqual(await harness.service.prefetchCompletion(sample({ versionId: 2 }), CancellationToken.None), undefined);
		assert.strictEqual(harness.calls.length, 1);
		const prefetched = await harness.service.prefetchCompletion(sample({ prefix: 'later', fileText: 'later-file' }), CancellationToken.None);
		assert.strictEqual(prefetched?.kind, 'inline');
		assert.strictEqual(harness.calls.length, 2);
	});

	test('slow completions shrink the context sent, fast ones grow it back, and each change is logged', () => runWithFakedTimers({ maxTaskCount: 5000 }, async () => {
		const harness = open(store);
		const prefix = 'p'.repeat(3000);
		const sentPrefix = (call: ClaudeInlineCompletionRequest) => call.prompt.slice(call.prompt.indexOf('<prefix>\n') + 9, call.prompt.indexOf('\n</prefix>')).length;
		let file = 0;
		const run = async (count: number, delayMs: number) => {
			harness.delayMs = delayMs;
			for (let i = 0; i < count; i++) {
				await harness.service.provideCompletion(sample({ prefix, fileText: `file-${file++}` }), CancellationToken.None);
			}
		};
		await run(8, 1500);
		await run(8, 100);
		await run(1, 100);
		assert.deepStrictEqual(harness.calls.map(sentPrefix), [...Array(8).fill(2000), ...Array(8).fill(1500), 2000]);
		assert.deepStrictEqual(harness.lines, [
			'[claude] tab context prefix=1500 suffix=750 p95=1500ms\n',
			'[claude] tab context prefix=2000 suffix=1000 p95=100ms\n',
		]);
	}));

	test('turning Tab off resets the shrunken context, so it starts again at the full size', () => runWithFakedTimers({ maxTaskCount: 5000 }, async () => {
		const harness = open(store);
		const prefix = 'p'.repeat(3000);
		const sentPrefix = (call: ClaudeInlineCompletionRequest) => call.prompt.slice(call.prompt.indexOf('<prefix>\n') + 9, call.prompt.indexOf('\n</prefix>')).length;
		harness.delayMs = 1500;
		for (let i = 0; i < 9; i++) {
			await harness.service.provideCompletion(sample({ prefix, fileText: `slow-${i}` }), CancellationToken.None);
		}
		harness.fireDisabled();
		harness.settings[CLAUDE_AUTOCOMPLETE_ENABLED_SETTING] = true;
		harness.delayMs = 0;
		await harness.service.provideCompletion(sample({ prefix, fileText: 'after' }), CancellationToken.None);
		assert.deepStrictEqual(harness.calls.map(sentPrefix).slice(-2), [1500, 2000]);
	}));

	test('a runtime without completeInline applies nothing', async () => {
		const harness = open(store, false);
		assert.strictEqual(await harness.service.provideCompletion(sample(), CancellationToken.None), undefined);
		assert.strictEqual(harness.calls.length, 0);
		assert.strictEqual(harness.service.latency(), undefined);
	});

	test('KlawlyTabRead hooks keep denied files out of Tab (issue 514)', async () => {
		const harness = open(store);
		const hidden = URI.file('C:/repo/notes/private.md');
		harness.denied.add(hidden.toString());
		const denied = await harness.service.provideCompletion(sample({ uri: hidden, uriPath: hidden.path }), CancellationToken.None);
		await harness.service.provideCompletion(sample({ relatedSnippets: [{ uri: hidden.toString(), text: 'hidden-snippet' }, { uri: 'file:///repo/src/util.ts', text: 'shown-snippet' }] }), CancellationToken.None);
		assert.deepStrictEqual([denied, harness.calls.length, harness.calls[0].prompt.includes('hidden-snippet'), harness.calls[0].prompt.includes('shown-snippet')], [undefined, 1, false, true]);
	});
});

function sample(override: Partial<CompletionInput> = {}): CompletionInput {
	return {
		uri: URI.file('C:/repo/src/app.ts'),
		languageId: 'typescript',
		prefix: 'const ',
		suffix: '',
		recentEdits: [{
			uri: 'file:///repo/src/app.ts',
			before: '',
			after: 'recent-token',
			range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 },
			ageMs: 4,
		}],
		relatedSnippets: [],
		versionId: 1,
		position: { lineNumber: 1, column: 7 },
		fileText: 'const ',
		lineText: 'const ',
		uriPath: '/repo/src/app.ts',
		...override,
	};
}

function open(store: Pick<DisposableStore, 'add'>, inline = true): {
	service: ClaudeAutocompleteService;
	calls: ClaudeInlineCompletionRequest[];
	settings: Record<string, unknown>;
	gate: Promise<void> | undefined;
	text: string;
	delayMs: number;
	lines: string[];
	cancels: string[];
	folders: { uri: URI; name: string; index: number }[];
	denied: Set<string>;
	fireDisabled(): void;
} {
	const calls: ClaudeInlineCompletionRequest[] = [];
	const lines: string[] = [];
	const cancels: string[] = [];
	const settings: Record<string, unknown> = {
		[CLAUDE_AUTOCOMPLETE_ENABLED_SETTING]: true,
		[CLAUDE_AUTOCOMPLETE_DEBOUNCE_SETTING]: 100,
		[CLAUDE_AUTOCOMPLETE_MODEL_SETTING]: 'tab-model',
	};
	const state: { gate: Promise<void> | undefined; text: string; delayMs: number } = { gate: undefined, text: 'const value = 1;', delayMs: 0 };
	const onDidChangeConfiguration = store.add(new Emitter<IConfigurationChangeEvent>());
	const runtime = {
		completeInline: inline ? async (request: ClaudeInlineCompletionRequest) => {
			calls.push(request);
			if (state.gate) {
				await state.gate;
			}
			if (state.delayMs > 0) {
				await timeout(state.delayMs);
			}
			return state.text;
		} : undefined,
		cancelInline: async (id: string) => { cancels.push(id); },
	} as unknown as IClaudeRuntimeService;
	const configuration = {
		getValue: (key: string) => settings[key],
		onDidChangeConfiguration: onDidChangeConfiguration.event,
	} as IConfigurationService;
	const folders = [{ uri: URI.file('C:/repo'), name: 'repo', index: 0 }];
	const workspace = {
		getWorkspace: () => ({ folders }),
	} as IWorkspaceContextService;
	const output = {
		getChannel: () => ({ append: (line: string) => { lines.push(line); } }),
	} as unknown as IOutputService;
	const denied = new Set<string>();
	const hooks = {
		checkTabRead: async (uri: URI) => ({ allowed: !denied.has(uri.toString()) }),
	} as unknown as IClaudeKlawlyHooksService;
	const service = store.add(new ClaudeAutocompleteService(runtime, configuration, workspace, output, hooks));
	return {
		service,
		denied,
		calls,
		settings,
		lines,
		cancels,
		folders,
		fireDisabled: () => {
			settings[CLAUDE_AUTOCOMPLETE_ENABLED_SETTING] = false;
			onDidChangeConfiguration.fire({
				source: ConfigurationTarget.USER,
				affectedKeys: new Set([CLAUDE_AUTOCOMPLETE_ENABLED_SETTING]),
				change: { keys: [CLAUDE_AUTOCOMPLETE_ENABLED_SETTING], overrides: [] },
				affectsConfiguration: (key: string) => key === CLAUDE_AUTOCOMPLETE_ENABLED_SETTING,
			});
		},
		get gate() { return state.gate; },
		set gate(value: Promise<void> | undefined) { state.gate = value; },
		get text() { return state.text; },
		set text(value: string) { state.text = value; },
		get delayMs() { return state.delayMs; },
		set delayMs(value: number) { state.delayMs = value; },
	};
}
