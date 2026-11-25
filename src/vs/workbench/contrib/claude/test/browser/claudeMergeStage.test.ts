/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { Emitter } from '../../../../../base/common/event.js';
import { isWindows } from '../../../../../base/common/platform.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { shouldStageResolvedFile } from '../../../../../platform/claude/common/claudeMergeConflicts.js';
import { ClaudeMergeStageContribution } from '../../browser/claudeMergeStage.js';

suite('Claude merge stage after Keep', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();
	const clean = { enabled: true, inMergeGroup: true, allKept: true, dirty: false, text: 'a\nb\n' };

	test('a file is staged only when every condition holds and no marker is left', () => {
		assert.deepStrictEqual({
			clean: shouldStageResolvedFile(clean),
			off: shouldStageResolvedFile({ ...clean, enabled: false }),
			outsideMergeGroup: shouldStageResolvedFile({ ...clean, inMergeGroup: false }),
			changesLeft: shouldStageResolvedFile({ ...clean, allKept: false }),
			unsaved: shouldStageResolvedFile({ ...clean, dirty: true }),
			unreadable: shouldStageResolvedFile({ ...clean, text: undefined }),
			openMarker: shouldStageResolvedFile({ ...clean, text: 'a\n<<<<<<< HEAD\nb\n=======\nc\n>>>>>>> feature\n' }),
			quotedMarker: shouldStageResolvedFile({ ...clean, text: 'x <<<<<<< not at line start\n' }),
		}, { clean: true, off: false, outsideMergeGroup: false, changesLeft: false, unsaved: false, unreadable: false, openMarker: false, quotedMarker: true });
	});

	const root = URI.file(isWindows ? 'C:\repo' : '/repo');
	const clean1 = URI.joinPath(root, 'clean.ts');
	const marked = URI.joinPath(root, 'marked.ts');
	const outside = URI.joinPath(root, 'outside.ts');

	function setup(options: { enabled: boolean; dirty?: boolean }) {
		const change = store.add(new Emitter<{ readonly sessionId: string }>());
		const texts = new Map<string, string>([
			[clean1.toString(), 'resolved\n'],
			[marked.toString(), 'x\n<<<<<<< HEAD\na\n=======\nb\n>>>>>>> feature\n'],
			[outside.toString(), 'fine\n'],
		]);
		const file = (uri: URI, state: 'accepted' | 'pending') => ({ uri, hunks: [{ state }] });
		const staged: string[] = [];
		const merge = { id: 'merge', resources: [{ sourceUri: clean1 }, { sourceUri: marked }] };
		const contribution = store.add(new ClaudeMergeStageContribution(
			{ onDidChangeReview: change.event, reviewsFor: () => [{ files: [file(clean1, 'accepted'), file(marked, 'accepted'), file(outside, 'accepted')] }] } as never,
			{ getValue: () => options.enabled } as never,
			{ repositories: [{ provider: { providerId: 'git', groups: [merge] } }] } as never,
			{ readFile: async (uri: URI) => ({ value: VSBuffer.fromString(texts.get(uri.toString()) ?? '') }) } as never,
			{ isDirty: () => options.dirty === true } as never,
			{ executeCommand: async (id: string, uri: URI) => { staged.push(`${id} ${uri.path}`); } } as never,
		));
		return { contribution, staged };
	}

	test('with the setting on, only a kept conflicted file with no marker is staged, and only once', async () => {
		const { contribution, staged } = setup({ enabled: true });
		await contribution.run('s1');
		await contribution.run('s1');
		assert.deepStrictEqual(staged, [`git.stageFile ${clean1.path}`]);
	});

	test('with the setting off nothing is staged', async () => {
		const { contribution, staged } = setup({ enabled: false });
		await contribution.run('s1');
		assert.deepStrictEqual(staged, []);
	});

	test('a file with unsaved edits is not staged', async () => {
		const { contribution, staged } = setup({ enabled: true, dirty: true });
		await contribution.run('s1');
		assert.deepStrictEqual(staged, []);
	});
});
