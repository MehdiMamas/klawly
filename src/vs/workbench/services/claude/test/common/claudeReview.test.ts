/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { Range } from '../../../../../editor/common/core/range.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { DefaultEndOfLine, EndOfLinePreference, ITextModel } from '../../../../../editor/common/model.js';
import { ITextModelService } from '../../../../../editor/common/services/resolverService.js';
import { actionAvailable, actionNeedsEditorSelection, CLAUDE_ATTACHMENT_CHAR_LIMIT, resolveAgentAction } from '../../../../../platform/claude/common/claudePrompt.js';
import { FileOperationError, FileOperationResult, FileSystemProviderErrorCode, IFileService, toFileSystemProviderErrorCode } from '../../../../../platform/files/common/files.js';
import { createTextModel } from '../../../../../editor/test/common/testTextModel.js';
import { ITextFileService } from '../../../textfile/common/textfiles.js';
import { CheckpointOriginal, IClaudeCheckpointService } from '../../common/claudeCheckpointService.js';
import { CLAUDE_NOTEBOOK_SNAPSHOT_SCHEME, CLAUDE_SNAPSHOT_SCHEME, ClaudeReviewService, ReviewConflictError, ReviewReadError, ReviewScope, TurnReview, buildTurnReview, claudeReviewOriginalUri, formatTurnDiff, isReviewBaseline, parseClaudeSnapshotUri, claudeSnapshotUri, reviewFromLoad, reviewTurnsPendingLoad } from '../../common/claudeReview.js';
import { ClaudeNotebookSnapshotFileSystem } from '../../common/claudeNotebookSnapshotFileSystem.js';
import { deserializeReviews, serializeReviews } from '../../common/claudeReviewPersist.js';
import { CLAUDE_REVIEW_AUTO_KEEP_SETTING } from '../../../../../platform/claude/common/claudeConfiguration.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { timeout } from '../../../../../base/common/async.js';

suite('Claude review', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	test('edits three files, reviews all, and accepts or rejects each one on its own', async () => {
		const authUri = URI.file('C:/repo/src/auth.ts');
		const middleUri = URI.file('C:/repo/src/middleware.ts');
		const testUri = URI.file('C:/repo/tests/auth.test.ts');
		const auth = model(authUri, 'export const token = 1;\nexport const next = 2;\n');
		const middle = model(middleUri, 'export function gate() {\n\treturn true;\n}\n');
		const created = model(testUri, 'test("auth", () => {\n});\n');
		const service = disposables.add(reviewService(emptyCheckpoints(), resolver([auth, middle, created])));
		const review = service.replaceTurn('session-1', 'turn-1', [
			{ uri: authUri, originalText: 'export const token = 1;\n', modifiedText: text(auth), existed: true },
			{ uri: middleUri, originalText: 'export function gate() {\n\treturn false;\n}\n', modifiedText: text(middle), existed: true },
			{ uri: testUri, originalText: '', modifiedText: text(created), existed: false },
		]);

		assert.strictEqual(review.files.length, 3);
		assert.deepStrictEqual(review.files.map(file => file.name), ['auth.ts', 'middleware.ts', 'auth.test.ts']);
		assert.ok(review.files.every(file => file.hunks.length > 0 && file.hunks.every(hunk => hunk.state === 'pending')));
		assert.strictEqual(review.files[2].isNew, true);
		for (const file of review.files) {
			const live = file.uri.toString() === authUri.toString() ? auth : file.uri.toString() === middleUri.toString() ? middle : created;
			for (const hunk of file.hunks) {
				assert.strictEqual(live.getValueInRange(hunk.currentRange, EndOfLinePreference.LF), hunk.modifiedText);
			}
		}

		service.acceptFile('session-1', 'turn-1', authUri);
		assert.strictEqual(text(auth), 'export const token = 1;\nexport const next = 2;\n');
		assert.strictEqual(review.files[0].state, 'accepted');

		await service.rejectFile('session-1', 'turn-1', middleUri);
		assert.strictEqual(text(middle), 'export function gate() {\n\treturn false;\n}\n');
		assert.strictEqual(review.files[1].state, 'rejected');

		assert.strictEqual(review.files[2].state, 'pending');
		assert.strictEqual(text(created), 'test("auth", () => {\n});\n');
		assert.strictEqual(text(auth), 'export const token = 1;\nexport const next = 2;\n');

		const patch = formatTurnDiff(review);
		assert.ok(patch.includes('src/auth.ts'), patch);
		assert.ok(patch.includes('src/middleware.ts'), patch);
		assert.ok(patch.includes('tests/auth.test.ts'), patch);
		assert.strictEqual(service.next('session-1', 'turn-1')?.uri.toString(), testUri.toString());
	});

	test('accepts one hunk and rejects another in the same file', async () => {
		const uri = URI.file('C:/repo/src/session.ts');
		const live = model(uri, 'ALPHA\nkeep\nGAMMA\ntail\n');
		const service = disposables.add(reviewService(emptyCheckpoints(), resolver([live])));
		const review = service.replaceTurn('session-1', 'turn-2', [{
			uri,
			originalText: 'alpha\nkeep\ngamma\ntail\n',
			modifiedText: text(live),
			existed: true,
		}]);
		assert.strictEqual(review.files[0].hunks.length, 2);
		const [first, second] = review.files[0].hunks;
		service.acceptHunk('session-1', 'turn-2', first.id);
		await service.rejectHunk('session-1', 'turn-2', second.id);
		assert.strictEqual(text(live), 'ALPHA\nkeep\ngamma\ntail\n');
		assert.strictEqual(first.state, 'accepted');
		assert.strictEqual(second.state, 'rejected');
		assert.strictEqual(review.files[0].state, 'mixed');
	});

	test('rejecting a drifted hunk raises ReviewConflictError and keeps the user edit', async () => {
		const uri = URI.file('C:/repo/src/auth.ts');
		const live = model(uri, 'export const token = 1;\nexport const next = 2;\n');
		const service = disposables.add(reviewService(emptyCheckpoints(), resolver([live])));
		const review = service.replaceTurn('session-1', 'turn-3', [{
			uri,
			originalText: 'export const token = 1;\n',
			modifiedText: text(live),
			existed: true,
		}]);
		const hunk = review.files[0].hunks[0];
		live.setValue('export const token = 1;\nexport const mine = 9;\n');
		await assert.rejects(() => service.rejectHunk('session-1', 'turn-3', hunk.id), (error: unknown) => {
			assert.ok(error instanceof ReviewConflictError);
			assert.strictEqual(error.message, 'The file changed after Claude created this hunk. Open conflict review.');
			return true;
		});
		assert.strictEqual(text(live), 'export const token = 1;\nexport const mine = 9;\n');
		assert.strictEqual(hunk.state, 'conflicted');
		assert.strictEqual(review.files[0].state, 'conflicted');
	});

	test('loads a turn from checkpoint originals and skips dirty buffers that were not written', async () => {
		const uri = URI.file('C:/repo/src/auth.ts');
		const untouched = URI.file('C:/repo/src/dirty.ts');
		const live = model(uri, 'after\n');
		const checkpoints = {
			readCheckpointOriginals: async () => [
				{ uri: uri.toString(), text: 'before\n', capturedAs: 'write' as const, afterHash: 'abc', existed: true },
				{ uri: untouched.toString(), text: 'draft\n', capturedAs: 'buffer' as const, existed: true },
			],
		} as unknown as IClaudeCheckpointService;
		const service = disposables.add(reviewService(checkpoints, resolver([live])));
		const review = await service.ensureTurn('session-1', 'turn-4');
		assert.ok(review);
		assert.deepStrictEqual(review!.files.map(file => file.name), ['auth.ts']);
		assert.strictEqual(review!.files[0].originalText, 'before\n');
		assert.strictEqual(await service.ensureTurn('session-1', 'turn-4'), review);
		assert.strictEqual(isReviewBaseline({ capturedAs: 'buffer' }), false);
		assert.strictEqual(isReviewBaseline({ capturedAs: 'write' }), true);
		assert.strictEqual(isReviewBaseline({ capturedAs: 'buffer', afterHash: 'abc' }), true);
		assert.strictEqual(actionAvailable('reviewTurnChanges'), true);
		assert.strictEqual(actionAvailable('fixPreviewElement'), true);
		assert.strictEqual(actionNeedsEditorSelection('reviewTurnChanges'), false);
		assert.strictEqual(actionNeedsEditorSelection('fixPreviewElement'), false);
		assert.strictEqual(actionNeedsEditorSelection('explainSelection'), true);
		assert.strictEqual(actionAvailable('reviewChanges'), true);
		assert.strictEqual(actionNeedsEditorSelection('reviewChanges'), false);
		assert.strictEqual(actionNeedsEditorSelection('generateCommitMessage'), false);
		assert.deepStrictEqual(
			resolveAgentAction('reviewTurnChanges', { slashCommands: ['review'], skills: [], preferClaudeCommands: true }),
			{ kind: 'claude-command', command: 'review' },
		);
	});

	test('accepts every file and rejects every file on its own', async () => {
		const keepUri = URI.file('C:/repo/src/keep.ts');
		const dropUri = URI.file('C:/repo/src/drop.ts');
		const keep = model(keepUri, 'kept\n');
		const drop = model(dropUri, 'gone\n');
		const service = disposables.add(reviewService(emptyCheckpoints(), resolver([keep, drop])));
		service.replaceTurn('session-1', 'turn-all', [
			{ uri: keepUri, originalText: 'old-keep\n', modifiedText: text(keep), existed: true },
			{ uri: dropUri, originalText: 'old-drop\n', modifiedText: text(drop), existed: true },
		]);
		service.acceptAll('session-1', 'turn-all');
		assert.strictEqual(text(keep), 'kept\n');
		assert.ok(service.get('session-1', 'turn-all')?.files.every(file => file.state === 'accepted'));

		const againKeep = model(URI.file('C:/repo/src/keep2.ts'), 'kept\n');
		const againDrop = model(URI.file('C:/repo/src/drop2.ts'), 'gone\n');
		const second = disposables.add(reviewService(emptyCheckpoints(), resolver([againKeep, againDrop])));
		const review = second.replaceTurn('session-1', 'turn-all', [
			{ uri: againKeep.uri, originalText: 'old-keep\n', modifiedText: text(againKeep), existed: true },
			{ uri: againDrop.uri, originalText: 'old-drop\n', modifiedText: text(againDrop), existed: true },
		]);
		await second.rejectAll('session-1', 'turn-all');
		assert.strictEqual(text(againKeep), 'old-keep\n');
		assert.strictEqual(text(againDrop), 'old-drop\n');
		assert.ok(review.files.every(file => file.state === 'rejected'));
	});

	test('rejects an earlier multi-line hunk and then a later hunk in the same file', async () => {
		const uri = URI.file('C:/repo/src/hunks.ts');
		const live = model(uri, 'AAA\nBBB\nCCC\nmiddle\nZZ\n');
		const service = disposables.add(reviewService(emptyCheckpoints(), resolver([live])));
		const review = service.replaceTurn('session-1', 'turn-hunks', [{
			uri,
			originalText: 'a\nb\nmiddle\nz\n',
			modifiedText: text(live),
			existed: true,
		}]);
		assert.ok(review.files[0].hunks.length >= 2, `hunks=${review.files[0].hunks.length}`);
		const [earlier, later] = review.files[0].hunks;
		assert.ok(earlier.modifiedText.includes('\n'), earlier.modifiedText);
		assert.ok(earlier.currentRange.startLineNumber < later.currentRange.startLineNumber);
		await service.rejectHunk('session-1', 'turn-hunks', earlier.id);
		await service.rejectHunk('session-1', 'turn-hunks', later.id);
		assert.strictEqual(text(live), 'a\nb\nmiddle\nz\n');
		assert.strictEqual(earlier.state, 'rejected');
		assert.strictEqual(later.state, 'rejected');
	});

	test('rejectAll keeps going after a conflict', async () => {
		const conflictUri = URI.file('C:/repo/src/conflict.ts');
		const laterUri = URI.file('C:/repo/src/later.ts');
		const conflict = model(conflictUri, 'claude\n');
		const later = model(laterUri, 'claude-later\n');
		const service = disposables.add(reviewService(emptyCheckpoints(), resolver([conflict, later])));
		const review = service.replaceTurn('session-1', 'turn-mix', [
			{ uri: conflictUri, originalText: 'before\n', modifiedText: text(conflict), existed: true },
			{ uri: laterUri, originalText: 'before-later\n', modifiedText: text(later), existed: true },
		]);
		conflict.setValue('typed-by-user\n');
		await assert.rejects(() => service.rejectAll('session-1', 'turn-mix'), (error: unknown) => error instanceof ReviewConflictError);
		assert.strictEqual(text(conflict), 'typed-by-user\n');
		assert.strictEqual(review.files[0].state, 'conflicted');
		assert.strictEqual(text(later), 'before-later\n');
		assert.strictEqual(review.files[1].state, 'rejected');
	});

	test('previous walks back to the earlier change', () => {
		const firstUri = URI.file('C:/repo/src/first.ts');
		const secondUri = URI.file('C:/repo/src/second.ts');
		const service = disposables.add(reviewService(emptyCheckpoints(), resolver([])));
		const review = service.replaceTurn('session-1', 'turn-nav', [
			{ uri: firstUri, originalText: 'a\n', modifiedText: 'A\n', existed: true },
			{ uri: secondUri, originalText: 'b\n', modifiedText: 'B\n', existed: true },
		]);
		const first = service.next('session-1', 'turn-nav');
		const second = service.next('session-1', 'turn-nav');
		const back = service.previous('session-1', 'turn-nav');
		assert.strictEqual(first?.id, review.files[0].hunks[0].id);
		assert.strictEqual(second?.id, review.files[1].hunks[0].id);
		assert.strictEqual(back?.id, first?.id);
	});

	test('an edit above a hunk moves its range, and a created file is deleted on reject', async () => {
		const uri = URI.file('C:/repo/src/shift.ts');
		const live = model(uri, 'keep\nCLAUDE\n');
		const service = disposables.add(reviewService(emptyCheckpoints(), resolver([live])));
		const review = service.replaceTurn('session-1', 'turn-shift', [{
			uri,
			originalText: 'keep\nold\n',
			modifiedText: text(live),
			existed: true,
		}]);
		const hunk = review.files[0].hunks[0];
		const start = hunk.currentRange.startLineNumber;
		await new Promise(resolve => setTimeout(resolve, 0));
		live.applyEdits([{ range: new Range(1, 1, 1, 1), text: 'inserted\n' }]);
		assert.strictEqual(hunk.currentRange.startLineNumber, start + 1);
		await service.rejectHunk('session-1', 'turn-shift', hunk.id);
		assert.strictEqual(text(live), 'inserted\nkeep\nold\n');

		const createdUri = URI.file('C:/repo/src/created.ts');
		const created = model(createdUri, 'new file\n');
		const deleted: URI[] = [];
		const files = { del: async (resource: URI) => { deleted.push(resource); } } as unknown as IFileService;
		const deleting = disposables.add(reviewService(emptyCheckpoints(), resolver([created]), files));
		deleting.replaceTurn('session-1', 'turn-new', [{ uri: createdUri, originalText: '', modifiedText: text(created), existed: false }]);
		await deleting.rejectFile('session-1', 'turn-new', createdUri);
		assert.strictEqual(text(created), '');
		assert.strictEqual(deleted.length, 1);
		assert.strictEqual(deleted[0].toString(), createdUri.toString());
	});

	test('undo saves the files it reverts, leaves a file with unsaved edits unsaved, and deletes a created file without a dirty buffer', async () => {
		const editedUri = URI.file('C:/repo/src/cart.ts');
		const typedUri = URI.file('C:/repo/src/typed.ts');
		const createdUri = URI.file('C:/repo/src/discounts.ts');
		const edited = model(editedUri, 'after\n');
		const typed = model(typedUri, 'top\nclaude\n');
		const created = model(createdUri, 'new\n');
		const fake = textFiles([edited, typed, created]);
		const deleted: URI[] = [];
		const files = { del: async (resource: URI) => { deleted.push(resource); } } as unknown as IFileService;
		const service = disposables.add(reviewService(emptyCheckpoints(), resolver([edited, typed, created]), files, fake.service));
		service.replaceTurn('session-1', 'turn-save', [
			{ uri: editedUri, originalText: 'before\n', modifiedText: text(edited), existed: true },
			{ uri: typedUri, originalText: 'top\nbase\n', modifiedText: text(typed), existed: true },
			{ uri: createdUri, originalText: '', modifiedText: text(created), existed: false },
		]);
		await new Promise(resolve => setTimeout(resolve, 0));
		typed.applyEdits([{ range: new Range(1, 1, 1, 4), text: 'TOP' }]);

		await service.rejectAll('session-1', 'turn-save');

		assert.deepStrictEqual({
			text: [text(edited), text(typed), text(created)],
			dirty: [editedUri, typedUri, createdUri].map(uri => fake.service.isDirty(uri)),
			saved: fake.saved.map(uri => uri.toString()),
			reverted: fake.reverted.map(uri => uri.toString()),
			deleted: deleted.map(uri => uri.toString()),
		}, {
			text: ['before\n', 'TOP\nbase\n', ''],
			dirty: [false, true, false],
			saved: [editedUri.toString()],
			reverted: [createdUri.toString()],
			deleted: [createdUri.toString()],
		});
	});

	test('undoing a created file that cannot be deleted writes the emptied buffer, so the disk matches the clean editor', async () => {
		const uri = URI.file('C:/repo/src/discounts.ts');
		const created = model(uri, 'new\n');
		const fake = textFiles([created]);
		const busy = new Error('EBUSY: resource busy or locked');
		const files = { del: async () => { throw busy; } } as unknown as IFileService;
		const service = disposables.add(reviewService(emptyCheckpoints(), resolver([created]), files, fake.service));
		service.replaceTurn('session-1', 'turn-busy', [{ uri, originalText: '', modifiedText: text(created), existed: false }]);
		await new Promise(resolve => setTimeout(resolve, 0));
		const forced: (boolean | undefined)[] = [];
		const save = fake.service.save;
		fake.service.save = async (resource, options) => {
			forced.push(options?.force);
			return save(resource, options);
		};

		const error = await service.rejectFile('session-1', 'turn-busy', uri).then(() => undefined, (reason: unknown) => reason);

		assert.deepStrictEqual({ error, text: text(created), dirty: fake.service.isDirty(uri), forced, reverted: fake.reverted.length }, {
			error: busy,
			text: '',
			dirty: false,
			forced: [true],
			reverted: 1,
		});
	});

	test('undoing a created file that was already deleted outside Klawly does not write an empty file back', async () => {
		const uri = URI.file('C:/repo/src/foo.ts');
		const created = model(uri, 'new\n');
		const fake = textFiles([created]);
		const files = { del: async () => { throw new FileOperationError('not found', FileOperationResult.FILE_NOT_FOUND); } } as unknown as IFileService;
		const service = disposables.add(reviewService(emptyCheckpoints(), resolver([created]), files, fake.service));
		service.replaceTurn('session-1', 'turn-gone', [{ uri, originalText: '', modifiedText: text(created), existed: false }]);
		await new Promise(resolve => setTimeout(resolve, 0));

		const error = await service.rejectFile('session-1', 'turn-gone', uri).then(() => undefined, (reason: unknown) => reason);

		assert.deepStrictEqual({ error, saved: fake.saved.length, dirty: fake.service.isDirty(uri), state: service.get('session-1', 'turn-gone')?.files[0].hunks.map(hunk => hunk.state) }, {
			error: undefined,
			saved: 0,
			dirty: false,
			state: ['rejected'],
		});
	});

	test('Undo All saves each file as soon as its changes are undone, before it reverts the next (issue 349)', async () => {
		const firstUri = URI.file('C:/repo/src/first.ts');
		const secondUri = URI.file('C:/repo/src/second.ts');
		const first = model(firstUri, 'ONE\ntwo\nthree\nfour\nFIVE\n');
		const second = model(secondUri, 'x\ny\nZ\n');
		const fake = textFiles([first, second]);
		const service = disposables.add(reviewService(emptyCheckpoints(), resolver([first, second]), undefined, fake.service));
		service.replaceTurn('session-1', 'turn-order', [
			{ uri: firstUri, originalText: 'one\ntwo\nthree\nfour\nfive\n', modifiedText: text(first), existed: true },
			{ uri: secondUri, originalText: 'x\ny\nz\n', modifiedText: text(second), existed: true },
		]);
		await new Promise(resolve => setTimeout(resolve, 0));
		const log: string[] = [];
		const name = (uri: URI) => uri.path.split('/').pop();
		for (const live of [first, second]) {
			disposables.add(live.onDidChangeContent(() => log.push(`revert ${name(live.uri)}`)));
		}
		const save = fake.service.save;
		fake.service.save = async (resource, options) => {
			log.push(`save ${name(resource)}`);
			return save(resource, options);
		};

		await service.rejectAll('session-1', 'turn-order');

		assert.deepStrictEqual({ log, text: [text(first), text(second)] }, {
			log: ['revert first.ts', 'revert first.ts', 'save first.ts', 'revert second.ts', 'save second.ts'],
			text: ['one\ntwo\nthree\nfour\nfive\n', 'x\ny\nz\n'],
		});
	});

	test('rejecting a hunk on a previously empty, existing file leaves it on disk', async () => {
		const uri = URI.file('C:/repo/src/empty.ts');
		const live = model(uri, 'filled\n');
		const deleted: URI[] = [];
		const files = { del: async (resource: URI) => { deleted.push(resource); } } as unknown as IFileService;
		const service = disposables.add(reviewService(emptyCheckpoints(), resolver([live]), files));
		const review = service.replaceTurn('session-1', 'turn-empty-file', [{
			uri,
			originalText: '',
			modifiedText: text(live),
			existed: true,
		}]);
		assert.strictEqual(review.files[0].isNew, false);
		await service.rejectHunk('session-1', 'turn-empty-file', review.files[0].hunks[0].id);
		assert.strictEqual(text(live), '');
		assert.strictEqual(deleted.length, 0);
	});

	test('a partial failure does not retrigger or reset accepted state', async () => {
		const keepUri = URI.file('C:/repo/src/keep.ts');
		const badUri = URI.file('C:/repo/src/bad.ts');
		const keep = model(keepUri, 'after\n');
		const bad = model(badUri, 'other\n');
		let failBad = true;
		const checkpoints = {
			readCheckpointOriginals: async () => [
				{ uri: keepUri.toString(), text: 'before\n', capturedAs: 'write' as const, afterText: 'after\n', afterHash: 'abc', existed: true },
				{ uri: badUri.toString(), text: 'before\n', capturedAs: 'write' as const, afterHash: 'def', existed: true },
			],
		} as unknown as IClaudeCheckpointService;
		const service = disposables.add(reviewService(checkpoints, {
			createModelReference: async (resource: URI) => {
				if (failBad && resource.toString() === badUri.toString()) {
					throw new Error('unreadable');
				}
				const found = resource.toString() === keepUri.toString() ? keep : resource.toString() === badUri.toString() ? bad : undefined;
				if (!found) {
					throw new Error(`No model for ${resource.toString()}`);
				}
				return { object: { textEditorModel: found }, dispose() { } };
			},
		} as unknown as ITextModelService));

		let events = 0;
		disposables.add(service.onDidChangeReview(() => { events++; }));
		await assert.rejects(() => service.ensureTurn('session-1', 'turn-partial'), (error: unknown) => error instanceof ReviewReadError);
		await assert.rejects(() => service.ensureTurn('session-1', 'turn-partial'), (error: unknown) => error instanceof ReviewReadError);
		assert.strictEqual(events, 0);
		assert.strictEqual(service.get('session-1', 'turn-partial'), undefined);

		failBad = false;
		const loaded = await service.ensureTurn('session-1', 'turn-partial');
		assert.ok(loaded);
		assert.strictEqual(events, 1);
		const hunk = loaded!.files[0].hunks[0];
		service.acceptHunk('session-1', 'turn-partial', hunk.id);
		assert.strictEqual(hunk.state, 'accepted');
		const acceptedEvents = events;

		failBad = true;
		const again = await service.ensureTurn('session-1', 'turn-partial');
		assert.strictEqual(again, loaded);
		assert.strictEqual(again!.files[0].hunks[0].state, 'accepted');
		assert.strictEqual(events, acceptedEvents);

		const rebuilt = buildTurnReview('session-1', 'turn-partial', [
			{ uri: keepUri, originalText: 'before\n', modifiedText: 'after\n', existed: true },
		]);
		const decision = reviewFromLoad(loaded, rebuilt, true);
		assert.strictEqual(decision.publish, false);
		assert.strictEqual(decision.review, loaded);
		assert.strictEqual(decision.review!.files[0].hunks[0].state, 'accepted');

		const attempted = new Map<string, string>();
		const turns = [
			{ id: 'session-1\nrunning', status: 'running' },
			{ id: 'session-1\ndone', status: 'complete' },
			{ id: 'session-1\nempty', status: 'complete' },
		];
		assert.deepStrictEqual(reviewTurnsPendingLoad(turns, attempted).map(turn => turn.id), ['session-1\ndone', 'session-1\nempty']);
		attempted.set('session-1\ndone', 'complete');
		attempted.set('session-1\nempty', 'complete');
		assert.deepStrictEqual(reviewTurnsPendingLoad(turns, attempted), []);
		assert.deepStrictEqual(
			reviewTurnsPendingLoad([{ id: 'session-1\ndone', status: 'failed' }], attempted).map(turn => turn.id),
			['session-1\ndone'],
		);
	});

	test('does not cache an empty or failed load, and skips a file that cannot be read', async () => {
		const uri = URI.file('C:/repo/src/auth.ts');
		const live = model(uri, 'after\n');
		let originals: CheckpointOriginal[] = [];
		let failRead = false;
		let reads = 0;
		const checkpoints = {
			readCheckpointOriginals: async () => {
				reads++;
				return originals;
			},
		} as unknown as IClaudeCheckpointService;
		const service = disposables.add(reviewService(checkpoints, {
			createModelReference: async (resource: URI) => {
				if (failRead) {
					throw new Error(`unreadable ${resource.toString()}`);
				}
				const found = [live].find(candidate => candidate.uri.toString() === resource.toString());
				if (!found) {
					throw new Error(`No model for ${resource.toString()}`);
				}
				return { object: { textEditorModel: found }, dispose() { } };
			},
		} as unknown as ITextModelService));

		assert.strictEqual(await service.ensureTurn('session-1', 'turn-empty'), undefined);
		originals = [{ uri: uri.toString(), text: 'before\n', capturedAs: 'write', afterHash: 'abc', afterText: 'after\n', existed: true }];
		const loaded = await service.ensureTurn('session-1', 'turn-empty');
		assert.ok(loaded);
		assert.strictEqual(loaded!.files[0].hunks[0].modifiedText.includes('after'), true);
		assert.strictEqual(reads, 2);

		originals = [{ uri: uri.toString(), text: 'before\n', capturedAs: 'write', afterHash: 'abc', existed: true }];
		failRead = true;
		await assert.rejects(() => service.ensureTurn('session-1', 'turn-fail'), (error: unknown) => error instanceof ReviewReadError);
		assert.strictEqual(service.get('session-1', 'turn-fail'), undefined);
		failRead = false;
		const retried = await service.ensureTurn('session-1', 'turn-fail');
		assert.ok(retried);

		originals = [{ uri: uri.toString(), text: 'before\n', capturedAs: 'write', afterHash: 'abc', afterText: 'after\n', existed: true }];
		live.setValue('after-user\n');
		const drifted = disposables.add(reviewService(checkpoints, resolver([live])));
		const driftReview = await drifted.ensureTurn('session-1', 'turn-drift');
		assert.strictEqual(driftReview?.files[0].hunks[0].state, 'conflicted');
		assert.ok(!driftReview?.files[0].hunks[0].modifiedText.includes('user'));
	});

	test('concurrent ensureTurn calls share one load', async () => {
		const uri = URI.file('C:/repo/src/auth.ts');
		const live = model(uri, 'after\n');
		let reads = 0;
		let release: (value: CheckpointOriginal[]) => void = () => undefined;
		const gate = new Promise<CheckpointOriginal[]>(resolve => { release = resolve; });
		const checkpoints = {
			readCheckpointOriginals: () => {
				reads++;
				return gate;
			},
		} as unknown as IClaudeCheckpointService;
		const service = disposables.add(reviewService(checkpoints, resolver([live])));
		const first = service.ensureTurn('session-1', 'turn-race');
		const second = service.ensureTurn('session-1', 'turn-race');
		assert.strictEqual(reads, 1);
		release([{ uri: uri.toString(), text: 'before\n', capturedAs: 'write', afterText: 'after\n', afterHash: 'abc', existed: true }]);
		const [left, right] = await Promise.all([first, second]);
		assert.strictEqual(left, right);
		assert.strictEqual(reads, 1);
	});

	test('a new file counts only added lines, and an emptied file only removed lines', () => {
		const review = buildTurnReview('s', 't', [
			{ uri: URI.file('C:/repo/src/new.ts'), originalText: '', modifiedText: 'a\nb\n', existed: false },
			{ uri: URI.file('C:/repo/src/gone.ts'), originalText: 'a\nb\n', modifiedText: '', existed: true },
		]);
		assert.deepStrictEqual(review.files.map(file => [file.name, file.added, file.removed]), [['new.ts', 2, 0], ['gone.ts', 0, 2]]);
	});

	test('the review attachment is a capped patch plus stat with secrets removed', () => {
		const uri = URI.file('C:/repo/src/auth.ts');
		const secret = 'sk-ant-secretvalue';
		const huge = 'x'.repeat(CLAUDE_ATTACHMENT_CHAR_LIMIT);
		const service = disposables.add(reviewService(emptyCheckpoints(), resolver([])));
		const review = service.replaceTurn('session-1', 'turn-diff', [{
			uri,
			originalText: 'before\n',
			modifiedText: `${secret}\n${huge}\n`,
			existed: true,
		}]);
		const patch = formatTurnDiff(review);
		assert.ok(patch.startsWith('1 files\n'), patch.slice(0, 40));
		assert.ok(patch.includes('src/auth.ts'));
		assert.ok(patch.includes('[redacted]'));
		assert.ok(!patch.includes(secret));
		assert.ok(patch.endsWith('…'));
		assert.ok(patch.length <= CLAUDE_ATTACHMENT_CHAR_LIMIT + 2);
		const snapshot = claudeSnapshotUri(uri, 'session-1', 'turn-diff');
		assert.deepStrictEqual(parseClaudeSnapshotUri(snapshot), { sessionId: 'session-1', turnId: 'turn-diff' });
		assert.strictEqual(service.snapshotText(snapshot), 'before\n');
	});

	test('a notebook opens its before-turn side as a read-only notebook snapshot file (issue 526)', async () => {
		const notebookFile = URI.file('/repo/analysis.ipynb');
		const original = claudeReviewOriginalUri(notebookFile, 'session-1', 'turn-1');
		const fileSystem = new ClaudeNotebookSnapshotFileSystem({ snapshotText: resource => parseClaudeSnapshotUri(resource)?.turnId === 'turn-1' ? '{"cells":[]}' : undefined });
		const read = new TextDecoder().decode(await fileSystem.readFile(original));
		const missing = await fileSystem.readFile(claudeReviewOriginalUri(notebookFile, 'session-1', 'turn-gone')).then(() => 'read', (error: Error) => toFileSystemProviderErrorCode(error));
		const write = await fileSystem.writeFile().then(() => 'written', (error: Error) => toFileSystemProviderErrorCode(error));
		assert.deepStrictEqual({
			notebookScheme: original.scheme,
			textScheme: claudeReviewOriginalUri(URI.file('/repo/a.ts'), 'session-1', 'turn-1').scheme,
			parsed: parseClaudeSnapshotUri(original),
			read,
			size: (await fileSystem.stat(original)).size,
			missing,
			write,
		}, {
			notebookScheme: CLAUDE_NOTEBOOK_SNAPSHOT_SCHEME,
			textScheme: CLAUDE_SNAPSHOT_SCHEME,
			parsed: { sessionId: 'session-1', turnId: 'turn-1' },
			read: '{"cells":[]}',
			size: 12,
			missing: FileSystemProviderErrorCode.FileNotFound,
			write: FileSystemProviderErrorCode.NoPermissions,
		});
	});

	function model(uri: URI, value: string): ITextModel {
		return disposables.add(createTextModel(value, null, { defaultEOL: DefaultEndOfLine.LF }, uri));
	}
});

function text(model: ITextModel): string {
	return model.getValue(EndOfLinePreference.LF);
}

function resolver(models: readonly ITextModel[]): ITextModelService {
	return {
		createModelReference: async (resource: URI) => {
			const found = models.find(candidate => candidate.uri.toString() === resource.toString());
			if (!found) {
				throw new Error(`No model for ${resource.toString()}`);
			}
			return { object: { textEditorModel: found }, dispose() { } };
		},
	} as unknown as ITextModelService;
}

function reviewService(checkpoints: IClaudeCheckpointService, models: ITextModelService, files: IFileService = { del: async () => undefined } as unknown as IFileService, textFileService: ITextFileService = textFiles([]).service): ClaudeReviewService {
	return new ClaudeReviewService(checkpoints, models, files, textFileService, new TestConfigurationService());
}

/** A text file service whose buffer is dirty once its model changed after the last save or revert. */
function textFiles(models: readonly ITextModel[]): { readonly service: ITextFileService; readonly saved: URI[]; readonly reverted: URI[] } {
	const clean = new Map(models.map(model => [model.uri.toString(), model.getAlternativeVersionId()]));
	const saved: URI[] = [];
	const reverted: URI[] = [];
	const find = (resource: URI) => models.find(model => model.uri.toString() === resource.toString());
	const markClean = (resource: URI) => {
		const model = find(resource);
		if (model) {
			clean.set(resource.toString(), model.getAlternativeVersionId());
		}
	};
	const service = {
		isDirty: (resource: URI) => {
			const model = find(resource);
			return !!model && clean.get(resource.toString()) !== model.getAlternativeVersionId();
		},
		save: async (resource: URI) => {
			saved.push(resource);
			markClean(resource);
			return resource;
		},
		revert: async (resource: URI) => {
			reverted.push(resource);
			markClean(resource);
		},
	} as unknown as ITextFileService;
	return { service, saved, reverted };
}

function emptyCheckpoints(): IClaudeCheckpointService {
	return {
		readCheckpointOriginals: async () => [],
	} as unknown as IClaudeCheckpointService;
}

suite('Claude review: Keep All and Auto-Keep (issue 706)', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	function model(uri: URI, value: string): ITextModel {
		return disposables.add(createTextModel(value, null, { defaultEOL: DefaultEndOfLine.LF }, uri));
	}

	/** Three files for turns in two chats. */
	function threeFiles(configuration = new TestConfigurationService()) {
		const auth = model(URI.file('C:/repo/src/auth.ts'), 'AUTH\n');
		const gate = model(URI.file('C:/repo/src/gate.ts'), 'GATE\n');
		const docs = model(URI.file('C:/repo/docs/readme.md'), 'DOCS\n');
		const service = disposables.add(new ClaudeReviewService(emptyCheckpoints(), resolver([auth, gate, docs]), { del: async () => undefined } as unknown as IFileService, textFiles([auth, gate, docs]).service, configuration));
		const turn = (sessionId: string, turnId: string, live: ITextModel, original: string) => service.replaceTurn(sessionId, turnId, [{ uri: live.uri, originalText: original, modifiedText: text(live), existed: true }]);
		return { service, auth, gate, docs, turn };
	}

	test('summarizes and keeps by turn, chat and all, and keeps the checkpoint baseline', () => {
		const { service, auth, gate, docs, turn } = threeFiles();
		turn('chat-a', 'turn-1', auth, 'auth\n');
		turn('chat-a', 'turn-2', gate, 'gate\n');
		turn('chat-b', 'turn-3', docs, 'docs\n');
		const summary = (scope: ReviewScope) => {
			const { hunks, files, turns, chats } = service.pendingSummary(scope);
			return { hunks, files, turns, chats };
		};
		assert.deepStrictEqual({
			turn: summary({ kind: 'turn', sessionId: 'chat-a', turnId: 'turn-1' }),
			chat: summary({ kind: 'chat', sessionId: 'chat-a' }),
			all: summary({ kind: 'all' }),
			uris: service.pendingSummary({ kind: 'all' }).uris.map(uri => uri.path),
		}, {
			turn: { hunks: 1, files: 1, turns: 1, chats: 1 },
			chat: { hunks: 2, files: 2, turns: 2, chats: 1 },
			all: { hunks: 3, files: 3, turns: 3, chats: 2 },
			uris: ['/C:/repo/src/auth.ts', '/C:/repo/src/gate.ts', '/C:/repo/docs/readme.md'],
		});

		const kept = [
			service.keepAllPending({ kind: 'turn', sessionId: 'chat-a', turnId: 'turn-1' }),
			summary({ kind: 'all' }).hunks,
			service.keepAllPending({ kind: 'chat', sessionId: 'chat-a' }),
			summary({ kind: 'all' }).hunks,
			service.keepAllPending({ kind: 'all' }),
			summary({ kind: 'all' }).hunks,
			service.keepAllPending({ kind: 'all' }),
		];
		assert.deepStrictEqual(kept, [1, 2, 1, 1, 1, 0, 0]);
		// Keep leaves the files and the turn's checkpoint text alone, so Restore Checkpoint still has its baseline.
		assert.deepStrictEqual({
			texts: [text(auth), text(gate), text(docs)],
			reviews: service.reviewsFor('chat-a').map(review => review.files.map(file => [file.originalText, file.state])),
		}, {
			texts: ['AUTH\n', 'GATE\n', 'DOCS\n'],
			reviews: [[['auth\n', 'accepted']], [['gate\n', 'accepted']]],
		});
	});

	test('Undo All in every chat reverts each pending file', async () => {
		const { service, auth, gate, docs, turn } = threeFiles();
		turn('chat-a', 'turn-1', auth, 'auth\n');
		turn('chat-a', 'turn-2', gate, 'gate\n');
		turn('chat-b', 'turn-3', docs, 'docs\n');
		service.keepAllPending({ kind: 'turn', sessionId: 'chat-a', turnId: 'turn-2' });
		await service.undoAllPending({ kind: 'all' });
		assert.deepStrictEqual({ texts: [text(auth), text(gate), text(docs)], pending: service.pendingSummary({ kind: 'all' }).hunks }, { texts: ['auth\n', 'GATE\n', 'docs\n'], pending: 0 });
	});

	test('Auto-Keep follows the setting and the chat toggle for off, thisChat and always', async () => {
		const configuration = new TestConfigurationService({ [CLAUDE_REVIEW_AUTO_KEEP_SETTING]: 'off' });
		const { service, auth, gate, docs, turn } = threeFiles(configuration);
		const states = (review: TurnReview) => ({ state: review.files[0].state, autoKept: review.autoKept === true });

		service.setAutoKeep('chat-a', true);
		const off = states(turn('chat-a', 'turn-1', auth, 'auth\n'));

		await configuration.setUserConfiguration(CLAUDE_REVIEW_AUTO_KEEP_SETTING, 'thisChat');
		const thisChatOn = states(turn('chat-a', 'turn-2', gate, 'gate\n'));
		const thisChatOther = states(turn('chat-b', 'turn-3', docs, 'docs\n'));

		await configuration.setUserConfiguration(CLAUDE_REVIEW_AUTO_KEEP_SETTING, 'always');
		service.setAutoKeep('chat-a', undefined);
		const always = states(turn('chat-b', 'turn-4', docs, 'docs\n'));
		service.setAutoKeep('chat-b', false);
		const alwaysChatOff = states(turn('chat-b', 'turn-5', docs, 'docs\n'));

		assert.deepStrictEqual({
			off,
			thisChatOn,
			thisChatOther,
			always,
			alwaysChatOff,
			saved: deserializeReviews(serializeReviews(service.reviewsFor('chat-a'))).map(review => review.autoKept === true),
		}, {
			off: { state: 'pending', autoKept: false },
			thisChatOn: { state: 'accepted', autoKept: true },
			thisChatOther: { state: 'pending', autoKept: false },
			always: { state: 'accepted', autoKept: true },
			alwaysChatOff: { state: 'pending', autoKept: false },
			saved: [false, true],
		});
	});

	test('Undo on an auto-kept file restores the checkpoint text after an edit above it', async () => {
		const configuration = new TestConfigurationService({ [CLAUDE_REVIEW_AUTO_KEEP_SETTING]: 'always' });
		const { service, auth, gate, turn } = threeFiles(configuration);
		auth.setValue('head\nAUTH\n');
		const review = turn('chat-a', 'turn-1', auth, 'head\nauth\n');
		turn('chat-a', 'turn-2', gate, 'gate\n');
		await timeout(0);
		auth.applyEdits([{ range: new Range(1, 1, 1, 1), text: 'mine\n' }]);
		await service.undoKept('chat-a', 'turn-1', auth.uri);
		await service.undoKept('chat-a', 'turn-2');
		assert.deepStrictEqual({ auth: text(auth), gate: text(gate), state: review.files[0].state }, { auth: 'mine\nhead\nauth\n', gate: 'gate\n', state: 'rejected' });
	});
});
