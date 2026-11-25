/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { mainWindow } from '../../../../../base/browser/window.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { addClaudeVerifyConsole, addClaudeVerifyShot, ClaudeVerifyEvidence, EMPTY_CLAUDE_VERIFY_EVIDENCE } from '../../../../../platform/claude/common/claudeVerifyEvidence.js';
import { ClaudeReviewEvidenceCard } from '../../browser/review/claudeReviewEvidence.js';

suite('Claude review evidence card', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function create(): { parent: HTMLElement; card: ClaudeReviewEvidenceCard } {
		const parent = mainWindow.document.createElement('div');
		return { parent, card: store.add(new ClaudeReviewEvidenceCard(parent)) };
	}

	function evidence(shots: number, errors: readonly string[]): ClaudeVerifyEvidence {
		let result = EMPTY_CLAUDE_VERIFY_EVIDENCE;
		for (let i = 0; i < shots; i++) {
			result = addClaudeVerifyShot(result, { mimeType: 'image/png', data: `d${i}` }, i);
		}
		for (const line of errors) {
			result = addClaudeVerifyConsole(result, line);
		}
		return result;
	}

	test('hides without evidence', () => {
		const { parent, card } = create();
		card.render(undefined);
		assert.deepStrictEqual({ empty: parent.firstElementChild?.classList.contains('is-empty'), height: card.height }, { empty: true, height: 0 });
		card.render(EMPTY_CLAUDE_VERIFY_EVIDENCE);
		assert.strictEqual(parent.firstElementChild?.classList.contains('is-empty'), true);
	});

	test('shows a before and after pair, no recording under three frames', () => {
		const { parent, card } = create();
		card.render(evidence(2, []));
		assert.deepStrictEqual({
			shown: !parent.firstElementChild?.classList.contains('is-empty'),
			captions: [...parent.querySelectorAll('.claude-review-evidence-pair figcaption')].map(e => e.textContent),
			strip: parent.querySelectorAll('.claude-review-evidence-strip').length,
			src: parent.querySelector('img')?.getAttribute('src'),
		}, { shown: true, captions: ['Before', 'After'], strip: 0, src: 'data:image/png;base64,d0' });
	});

	test('three frames add the recording strip and console errors list', () => {
		const { parent, card } = create();
		card.render(evidence(3, ['[error] boom']));
		assert.deepStrictEqual({
			frames: parent.querySelectorAll('.claude-review-evidence-strip figure').length,
			errors: [...parent.querySelectorAll('.claude-review-evidence-console li')].map(e => e.textContent),
		}, { frames: 3, errors: ['[error] boom'] });
	});

	test('a console-only turn still shows the card', () => {
		const { parent, card } = create();
		card.render(evidence(0, ['[pageerror] x']));
		assert.strictEqual(parent.firstElementChild?.classList.contains('is-empty'), false);
	});
});
