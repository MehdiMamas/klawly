/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { InMemoryStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { ClaudeFeedbackDrafts } from '../../browser/feedback/claudeFeedbackDrafts.js';
import { ClaudeFeedbackDraft } from '../../common/claudeFeedback.js';

suite('Klawly feedback drafts (issues 735, 739)', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	const draft = (title: string): ClaudeFeedbackDraft => ({ kind: 'bug', title, description: '', images: [], includeDiagnostics: true });

	test('keeps the draft and the unsent reports across instances, and forgets an empty draft', () => {
		const storage = store.add(new InMemoryStorageService());
		const drafts = new ClaudeFeedbackDrafts(storage);
		drafts.saveDraft(draft('Half written'));
		drafts.saveUnsent({ id: 'a', draft: draft('First'), error: 'Could not send: offline.' });
		drafts.saveUnsent({ id: 'b', draft: draft('Second'), error: 'Could not send: 502.', attachment: 'pasted-1.png' });
		drafts.saveUnsent({ id: 'a', draft: draft('First, edited'), error: 'Could not send: offline.' });
		const reopened = new ClaudeFeedbackDrafts(storage);
		const kept = { draft: reopened.draft?.title, unsent: reopened.unsent.map(entry => [entry.id, entry.draft.title, entry.attachment]) };

		reopened.saveDraft(draft('  '));
		reopened.removeUnsent('b');
		reopened.removeUnsent('a');
		storage.store('klawly.feedback.draft', '{broken', StorageScope.APPLICATION, StorageTarget.MACHINE);

		assert.deepStrictEqual({ kept, after: { draft: reopened.draft, unsent: reopened.unsent, unsentKey: storage.get('klawly.feedback.unsent', StorageScope.APPLICATION) } }, {
			kept: { draft: 'Half written', unsent: [['b', 'Second', 'pasted-1.png'], ['a', 'First, edited', undefined]] },
			after: { draft: undefined, unsent: [], unsentKey: undefined },
		});
	});
});
