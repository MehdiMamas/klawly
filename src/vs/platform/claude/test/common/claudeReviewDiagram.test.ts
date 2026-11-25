/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { claudeReviewDiagramPrompt, readClaudeReviewDiagram } from '../../common/claudeReviewDiagram.js';
import { claudeReviewPrompt, formatClaudeReviewSummary, readClaudeReviewSummary } from '../../common/claudeReviewLoop.js';

suite('Claude review diagram (issue 919)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('reads each kind with its header', () => {
		assert.deepStrictEqual([
			readClaudeReviewDiagram({ kind: 'sequence', mermaid: 'sequenceDiagram\n  A->>B: hi' })?.kind,
			readClaudeReviewDiagram({ kind: 'flow', mermaid: 'flowchart LR\n  A --> B' })?.kind,
			readClaudeReviewDiagram({ kind: 'flow', mermaid: 'graph TD\n  A --> B' })?.kind,
			readClaudeReviewDiagram({ kind: 'er', mermaid: 'erDiagram\n  A ||--o{ B : has' })?.kind,
			readClaudeReviewDiagram({ kind: 'class', mermaid: 'classDiagram\n  A <|-- B' })?.kind,
		], ['sequence', 'flow', 'flow', 'er', 'class']);
	});

	test('drops invalid diagrams', () => {
		const long = 'flowchart LR\n' + Array.from({ length: 60 }, (_, i) => `  A${i} --> B${i}`).join('\n');
		assert.deepStrictEqual([
			readClaudeReviewDiagram(undefined),
			readClaudeReviewDiagram({ kind: 'pie', mermaid: 'pie\n  "a": 1' }),
			readClaudeReviewDiagram({ kind: 'er', mermaid: 'flowchart LR\n  A --> B' }),
			readClaudeReviewDiagram({ kind: 'flow', mermaid: 'flowchart LR' }),
			readClaudeReviewDiagram({ kind: 'flow', mermaid: 'flowchart LR\n  A --> B\n  click A href "http://x"' }),
			readClaudeReviewDiagram({ kind: 'flow', mermaid: 'flowchart LR\n  A --> B\n```' }),
			readClaudeReviewDiagram({ kind: 'flow', mermaid: long }),
		], [undefined, undefined, undefined, undefined, undefined, undefined, undefined]);
	});

	test('the summary keeps a valid diagram and drops an invalid one without losing the summary', () => {
		const base = { overview: 'Adds a cache.', files: [{ path: 'a.ts', change: 'adds', risk: 'low' }] };
		const good = readClaudeReviewSummary({ summary: { ...base, diagram: { kind: 'flow', mermaid: 'flowchart LR\n  A --> B' } } });
		const bad = readClaudeReviewSummary({ summary: { ...base, diagram: { kind: 'flow', mermaid: 'nope' } } });
		assert.deepStrictEqual([good?.diagram?.kind, bad?.overview, bad?.diagram], ['flow', 'Adds a cache.', undefined]);
		assert.ok(formatClaudeReviewSummary(good!, undefined, false).includes('```mermaid\nflowchart LR\n  A --> B\n```'));
		assert.ok(!formatClaudeReviewSummary(bad!, undefined, false).includes('mermaid'));
	});

	test('the prompt leaves trivial changes without a diagram and can force a kind', () => {
		const auto = claudeReviewDiagramPrompt().join('\n');
		assert.ok(/docs-only, rename or formatting/.test(auto));
		assert.ok(/kind "er"/.test(claudeReviewDiagramPrompt('er').join('\n')));
		assert.ok(claudeReviewPrompt('diff', undefined, { summary: 'summary' }).includes('summary.diagram'));
		assert.ok(!claudeReviewPrompt('diff', undefined, { summary: 'off' }).includes('summary.diagram'));
	});
});
