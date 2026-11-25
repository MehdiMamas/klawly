/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { IMarkdownString } from '../../../../../base/common/htmlContent.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ATTRIBUTION_INLINE_SOURCE, ATTRIBUTION_TAB_SOURCE, ClaudeLineOwner } from '../../../../services/claude/common/claudeAttribution.js';
import { attributionDecorations } from '../../browser/claudeAttributionContribution.js';

suite('Claude line attribution gutter', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('Tab and inline edit lines say where they came from and offer no turn to open', () => {
		const tab: ClaudeLineOwner = { kind: 'agent', source: ATTRIBUTION_TAB_SOURCE };
		const owners: (ClaudeLineOwner | undefined)[] = [
			tab,
			tab,
			{ kind: 'agent', source: ATTRIBUTION_INLINE_SOURCE },
			{ kind: 'agent', source: { sessionId: 's1', turnId: 't2', turn: 2, model: 'Sonnet' } },
			undefined,
		];
		const seen = attributionDecorations(owners).map(decoration => ({
			lines: `${decoration.range.startLineNumber}-${decoration.range.endLineNumber}`,
			tooltip: decoration.options.linesDecorationsTooltip,
			opensTurn: ((decoration.options.lineNumberHoverMessage as IMarkdownString | undefined)?.value ?? '').includes('claude.openAttributedTurn'),
		}));
		assert.deepStrictEqual(seen, [
			{ lines: '1-2', tooltip: 'Written by Claude: Accepted from Klawly Tab', opensTurn: false },
			{ lines: '3-3', tooltip: 'Written by Claude: Accepted from an inline edit', opensTurn: false },
			{ lines: '4-4', tooltip: 'Written by Claude: Turn 2 · Sonnet', opensTurn: true },
		]);
	});
});
