/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { buildCompletionPrompt, CLAUDE_AUTOCOMPLETE_PREFIX_CHARS, CLAUDE_AUTOCOMPLETE_SUFFIX_CHARS } from '../../common/claudeAutocomplete.js';
import { formatTabContextBudget, TabContextBudgetController } from '../../common/claudeAutocompleteBudget.js';

suite('Claude Tab context budget', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	function feed(controller: TabContextBudgetController, ms: number, count: number): ({ prefixChars: number; suffixChars: number } | undefined)[] {
		const changes: ({ prefixChars: number; suffixChars: number } | undefined)[] = [];
		for (let i = 0; i < count; i++) {
			const changed = controller.record(ms);
			if (changed) {
				changes.push({ ...changed.budget });
			}
		}
		return changes;
	}

	test('slow calls shrink the context step by step down to the floor', () => {
		const controller = new TabContextBudgetController();
		assert.deepStrictEqual(controller.current(), { prefixChars: CLAUDE_AUTOCOMPLETE_PREFIX_CHARS, suffixChars: CLAUDE_AUTOCOMPLETE_SUFFIX_CHARS });
		assert.deepStrictEqual(feed(controller, 1500, 7), []);
		assert.deepStrictEqual(feed(controller, 1500, 40), [
			{ prefixChars: 1500, suffixChars: 750 },
			{ prefixChars: 1000, suffixChars: 500 },
			{ prefixChars: 500, suffixChars: 250 },
		]);
		assert.deepStrictEqual(controller.current(), { prefixChars: 500, suffixChars: 250 });
	});

	test('fast calls grow it back to the default, and the band between holds the size', () => {
		const controller = new TabContextBudgetController();
		feed(controller, 1500, 16);
		assert.deepStrictEqual(controller.current(), { prefixChars: 1000, suffixChars: 500 });
		assert.deepStrictEqual(feed(controller, 800, 30), []);
		assert.deepStrictEqual(feed(controller, 300, 40), [
			{ prefixChars: 1500, suffixChars: 750 },
			{ prefixChars: 2000, suffixChars: 1000 },
		]);
		assert.deepStrictEqual(feed(controller, 300, 20), []);
	});

	test('one slow outlier in a fast window does not shrink it, and a reset restores the default', () => {
		const controller = new TabContextBudgetController();
		feed(controller, 400, 19);
		assert.strictEqual(controller.record(5000), undefined);
		assert.deepStrictEqual(controller.current(), { prefixChars: 2000, suffixChars: 1000 });
		assert.strictEqual(controller.record(Number.NaN), undefined);
		assert.strictEqual(controller.record(-1), undefined);
		feed(controller, 2000, 20);
		assert.notDeepStrictEqual(controller.current(), { prefixChars: 2000, suffixChars: 1000 });
		controller.reset();
		assert.deepStrictEqual(controller.current(), { prefixChars: 2000, suffixChars: 1000 });
	});

	test('the prompt sends only the budgeted text around the cursor', () => {
		const prefix = 'p'.repeat(CLAUDE_AUTOCOMPLETE_PREFIX_CHARS + 50) + 'END';
		const suffix = 'START' + 's'.repeat(CLAUDE_AUTOCOMPLETE_SUFFIX_CHARS + 50);
		const input = { languageId: 'typescript', prefix, suffix, recentEdits: [], relatedSnippets: [] };
		const between = (text: string, open: string, close: string) => text.slice(text.indexOf(open) + open.length + 1, text.indexOf(close) - 1);
		const full = buildCompletionPrompt(input);
		assert.strictEqual(between(full, '<prefix>', '</prefix>').length, CLAUDE_AUTOCOMPLETE_PREFIX_CHARS);
		assert.strictEqual(between(full, '<suffix>', '</suffix>').length, CLAUDE_AUTOCOMPLETE_SUFFIX_CHARS);
		const small = buildCompletionPrompt(input, { prefixChars: 500, suffixChars: 250 });
		assert.deepStrictEqual([between(small, '<prefix>', '</prefix>').length, between(small, '<suffix>', '</suffix>').length], [500, 250]);
		assert.ok(between(small, '<prefix>', '</prefix>').endsWith('END'));
		assert.ok(between(small, '<suffix>', '</suffix>').startsWith('START'));
		const capped = buildCompletionPrompt(input, { prefixChars: 99999, suffixChars: 0 });
		assert.deepStrictEqual([between(capped, '<prefix>', '</prefix>').length, between(capped, '<suffix>', '</suffix>').length], [CLAUDE_AUTOCOMPLETE_PREFIX_CHARS, 0]);
	});

	test('a size change is logged as numbers only', () => {
		assert.strictEqual(formatTabContextBudget({ prefixChars: 1500, suffixChars: 750 }, 1200), '[claude] tab context prefix=1500 suffix=750 p95=1200ms\n');
	});
});
