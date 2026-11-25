/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { Range } from '../../../../../editor/common/core/range.js';
import { InlineCompletionContext, InlineCompletionEndOfLifeReasonKind, InlineCompletionTriggerKind } from '../../../../../editor/common/languages.js';
import { createTextModel } from '../../../../../editor/test/common/testTextModel.js';
import { Schemas } from '../../../../../base/common/network.js';
import { RecentEdit } from '../../../../../platform/claude/common/claudeAutocomplete.js';
import { ClaudeAcceptedSpan, ClaudeAttributionSource, ClaudeFileAttribution, hashAttributionLines, IClaudeAttributionService, recordKeptHunks } from '../../../../services/claude/common/claudeAttribution.js';
import { IClaudeAutocompleteService } from '../../../../services/claude/common/claudeAutocompleteService.js';
import { ClaudeTabCompletionProvider, claudeTabAcceptWhen, claudeTabDismissWhen, tabModelHandoff } from '../../common/claudeTabProvider.js';

suite('Claude Tab completion provider', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();
	const context: InlineCompletionContext = {
		triggerKind: InlineCompletionTriggerKind.Automatic,
		selectedSuggestionInfo: undefined,
		requestUuid: 'tab-test',
		includeInlineEdits: false,
		includeInlineCompletions: true,
		requestIssuedDateTime: 0,
		earliestShownDateTime: 0,
	};

	test('Tab and Esc do not override suggest, snippet, or find', () => {
		for (const when of [claudeTabAcceptWhen().serialize(), claudeTabDismissWhen().serialize()]) {
			assert.ok(when.includes('!suggestWidgetVisible'), when);
			assert.ok(when.includes('!inSnippetMode'), when);
			assert.ok(when.includes('!findWidgetVisible'), when);
			assert.ok(when.includes('!findInputFocussed'), when);
		}
		assert.ok(claudeTabAcceptWhen().serialize().includes('!inlineSuggestionVisible'));
		assert.ok(claudeTabDismissWhen().serialize().includes('!inlineSuggestionVisible'));
	});

	test('leaving a model is not the same as staying on it', () => {
		const current = URI.file('/repo/src/app.ts');
		const other = URI.file('/repo/src/other.ts');
		assert.strictEqual(tabModelHandoff(undefined, current), undefined);
		assert.strictEqual(tabModelHandoff(current, current), undefined);
		assert.strictEqual(tabModelHandoff(current, other)?.toString(), current.toString());
		assert.strictEqual(tabModelHandoff(current, undefined)?.toString(), current.toString());
	});

	test('a disabled Tab and an input surface ask for nothing', async () => {
		let calls = 0;
		const provider = new ClaudeTabCompletionProvider(fake({
			enabled: () => false,
			provideCompletion: async () => {
				calls++;
				return { kind: 'inline', insertText: 'nope' };
			},
		}));
		const model = store.add(createTextModel('const ', null, undefined, URI.file('/repo/src/app.ts')));
		assert.strictEqual(await provider.provideInlineCompletions(model, { lineNumber: 1, column: 7 }, context, CancellationToken.None), undefined);
		assert.strictEqual(calls, 0);

		const scm = store.add(createTextModel('commit', null, undefined, URI.from({ scheme: Schemas.vscodeSourceControl, path: '/input' })));
		const scmProvider = new ClaudeTabCompletionProvider(fake({
			enabled: () => true,
			provideCompletion: async () => {
				calls++;
				return { kind: 'inline', insertText: 'nope' };
			},
		}));
		assert.strictEqual(await scmProvider.provideInlineCompletions(scm, { lineNumber: 1, column: 1 }, context, CancellationToken.None), undefined);
		assert.strictEqual(calls, 0);
	});

	test('a stale version or a moved cursor is not shown', async () => {
		const model = store.add(createTextModel('const ', null, undefined, URI.file('/repo/src/app.ts')));
		const versionProvider = new ClaudeTabCompletionProvider(fake({
			enabled: () => true,
			provideCompletion: async () => {
				model.applyEdits([{ range: new Range(1, 1, 1, 1), text: 'x' }]);
				return { kind: 'inline', insertText: 'stale' };
			},
		}));
		assert.strictEqual(await versionProvider.provideInlineCompletions(model, { lineNumber: 1, column: 7 }, context, CancellationToken.None), undefined);

		const cursorModel = store.add(createTextModel('const ', null, undefined, URI.file('/repo/src/other.ts')));
		const cursorProvider = new ClaudeTabCompletionProvider(fake({
			enabled: () => true,
			notedPosition: () => ({ lineNumber: 1, column: 99 }),
			provideCompletion: async () => ({ kind: 'inline', insertText: 'nope' }),
		}));
		assert.strictEqual(await cursorProvider.provideInlineCompletions(cursorModel, { lineNumber: 1, column: 7 }, context, CancellationToken.None), undefined);
	});

	test('a cross-file preview replaces the line, and accepting it is recorded', async () => {
		const model = store.add(createTextModel('const old = 1;', null, undefined, URI.file('/repo/receipt.ts')));
		const edits: RecentEdit[] = [];
		const provider = new ClaudeTabCompletionProvider(fake({
			enabled: () => true,
			consumePreview: () => ({ text: 'const total = 1;', lineNumber: 1 }),
			recordRecentEdit: edit => { edits.push(edit); },
			notedPosition: () => ({ lineNumber: 1, column: 1 }),
		}));
		const shown = await provider.provideInlineCompletions(model, { lineNumber: 1, column: 1 }, context, CancellationToken.None);
		assert.ok(shown);
		assert.strictEqual(shown!.items[0].insertText, 'const total = 1;');
		assert.strictEqual(shown!.items[0].range?.startColumn, 1);
		assert.strictEqual(shown!.items[0].range?.endColumn, model.getLineMaxColumn(1));
		assert.notStrictEqual(shown!.items[0].range?.endColumn, shown!.items[0].range?.startColumn);

		provider.handleEndOfLifetime(shown!, shown!.items[0], { kind: InlineCompletionEndOfLifeReasonKind.Rejected });
		assert.strictEqual(edits.length, 0);

		const again = await provider.provideInlineCompletions(model, { lineNumber: 1, column: 1 }, context, CancellationToken.None);
		assert.ok(again);
		provider.handleEndOfLifetime(again!, again!.items[0], { kind: InlineCompletionEndOfLifeReasonKind.Accepted, alternativeAction: false });
		assert.strictEqual(edits.length, 1);
		assert.strictEqual(edits[0].after, 'const total = 1;');
		assert.strictEqual(edits[0].uri, model.uri.toString());
	});

	test('an accepted suggestion prefetches only when the cursor is still on that line', async () => {
		const model = store.add(createTextModel('const old = 1;', null, undefined, URI.file('/repo/receipt.ts')));
		let prefetches = 0;
		const elsewhere = new ClaudeTabCompletionProvider(fake({
			enabled: () => true,
			consumePreview: () => ({ text: 'const total = 1;', lineNumber: 1 }),
			notedPosition: () => ({ lineNumber: 4, column: 1 }),
			prefetchCompletion: async () => {
				prefetches++;
				return undefined;
			},
		}));
		const shown = await elsewhere.provideInlineCompletions(model, { lineNumber: 1, column: 1 }, context, CancellationToken.None);
		assert.ok(shown);
		elsewhere.handleEndOfLifetime(shown!, shown!.items[0], { kind: InlineCompletionEndOfLifeReasonKind.Accepted, alternativeAction: false });
		assert.strictEqual(prefetches, 0);

		const sameLine = new ClaudeTabCompletionProvider(fake({
			enabled: () => true,
			consumePreview: () => ({ text: 'const total = 1;', lineNumber: 1 }),
			notedPosition: () => ({ lineNumber: 1, column: 2 }),
			prefetchCompletion: async input => {
				prefetches++;
				assert.strictEqual(input.position.lineNumber, 1);
				assert.strictEqual(input.position.column, 2);
				return undefined;
			},
		}));
		const again = await sameLine.provideInlineCompletions(model, { lineNumber: 1, column: 1 }, context, CancellationToken.None);
		assert.ok(again);
		sameLine.handleEndOfLifetime(again!, again!.items[0], { kind: InlineCompletionEndOfLifeReasonKind.Accepted, alternativeAction: false });
		assert.strictEqual(prefetches, 1);
	});

	test('an accepted completion owns the lines it wrote, and one the editor did not apply records nothing', async () => {
		const owners = async (apply: boolean) => {
			const model = store.add(createTextModel('const a = 1;\nconst old = 2;\nconst c = 3;', null, undefined, URI.file('/repo/receipt.ts')));
			let record: ClaudeFileAttribution | undefined;
			const attribution = {
				recordAccepted: (_uri: URI, source: ClaudeAttributionSource, lines: readonly string[], spans: readonly ClaudeAcceptedSpan[]) => {
					record = recordKeptHunks(undefined, hashAttributionLines(lines), spans.map(span => ({ ...span, key: '', source })), 0);
				},
			} as unknown as IClaudeAttributionService;
			const provider = new ClaudeTabCompletionProvider(fake({
				consumePreview: () => ({ text: 'const total = a +\n\tc;', lineNumber: 2 }),
			}), attribution);
			const shown = await provider.provideInlineCompletions(model, { lineNumber: 2, column: 1 }, context, CancellationToken.None);
			const item = shown!.items[0];
			if (apply) {
				model.applyEdits([{ range: Range.lift(item.range!), text: item.insertText as string }]);
			}
			provider.handleEndOfLifetime(shown!, item, { kind: InlineCompletionEndOfLifeReasonKind.Accepted, alternativeAction: false });
			return record && { origin: record.sources.map(source => source.origin), owners: record.owners };
		};
		assert.deepStrictEqual({ applied: await owners(true), notApplied: await owners(false) }, {
			applied: { origin: ['tab'], owners: [-1, 0, 0, -1] },
			notApplied: undefined,
		});
	});
});

function fake(override: Partial<IClaudeAutocompleteService>): IClaudeAutocompleteService {
	return {
		enabled: () => true,
		consumePreview: () => undefined,
		provideCompletion: async () => undefined,
		notedPosition: () => undefined,
		snapshotRecentEdits: () => [],
		recordRecentEdit: () => undefined,
		prefetchCompletion: async () => undefined,
		...override,
	} as IClaudeAutocompleteService;
}
