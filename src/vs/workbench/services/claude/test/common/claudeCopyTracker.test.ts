/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { selectionIsStale } from '../../../../../platform/claude/common/claudePrompt.js';
import { ClaudeCopyTracker, hashCopiedText } from '../../common/claudeCopyTracker.js';

suite('Claude copy tracker', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('a different paste does not match, and the recorded version stays so a later edit can warn', () => {
		const tracker = new ClaudeCopyTracker();
		assert.strictEqual(tracker.match('hello'), undefined);
		tracker.record({
			uri: 'file:///repo/src/app.ts',
			range: { startLine: 2, startColumn: 1, endLine: 2, endColumn: 6 },
			versionId: 4,
			textHash: hashCopiedText('hello'),
		});
		assert.strictEqual(tracker.match('other'), undefined);
		const match = tracker.match('hello');
		assert.strictEqual(match?.versionId, 4);
		assert.strictEqual(selectionIsStale(match?.versionId ?? 0, 4), false);
		assert.strictEqual(selectionIsStale(match?.versionId ?? 0, 5), true);
	});
});
