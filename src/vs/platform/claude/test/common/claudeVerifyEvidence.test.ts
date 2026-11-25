/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { addClaudeVerifyConsole, addClaudeVerifyShot, CLAUDE_VERIFY_MAX_CONSOLE, CLAUDE_VERIFY_MAX_SHOTS, claudeVerifyRecording, EMPTY_CLAUDE_VERIFY_EVIDENCE, isClaudeVerifyEvidenceEmpty } from '../../common/claudeVerifyEvidence.js';
import { ClaudeBrowserImage } from '../../common/claudeBrowserTool.js';

suite('Claude verify evidence', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const image = (data: string): ClaudeBrowserImage => ({ mimeType: 'image/jpeg', data });

	test('the first screenshot is before, the newest is after and the rest are steps', () => {
		let evidence = EMPTY_CLAUDE_VERIFY_EVIDENCE;
		const labels: string[][] = [];
		for (const name of ['a', 'b', 'c', 'd']) {
			evidence = addClaudeVerifyShot(evidence, image(name), 1);
			labels.push(evidence.shots.map(shot => `${shot.data}:${shot.label}`));
		}
		assert.deepStrictEqual(labels, [['a:before'], ['a:before', 'b:after'], ['a:before', 'b:step', 'c:after'], ['a:before', 'b:step', 'c:step', 'd:after']]);
	});

	test('past the cap the oldest step drops and the first and last stay', () => {
		let evidence = EMPTY_CLAUDE_VERIFY_EVIDENCE;
		for (let i = 0; i < CLAUDE_VERIFY_MAX_SHOTS + 3; i++) {
			evidence = addClaudeVerifyShot(evidence, image(String(i)), i);
		}
		assert.deepStrictEqual([evidence.shots.length, evidence.shots[0].data, evidence.shots[1].data, evidence.shots.at(-1)!.data], [CLAUDE_VERIFY_MAX_SHOTS, '0', '4', String(CLAUDE_VERIFY_MAX_SHOTS + 2)]);
	});

	test('only errors, warnings and page errors are kept, without repeats', () => {
		let evidence = addClaudeVerifyConsole(EMPTY_CLAUDE_VERIFY_EVIDENCE, '[log] hi\n[error] boom\n[info] x\n[warning] careful\r\n[pageerror] Uncaught\n[error] boom');
		const again = addClaudeVerifyConsole(evidence, '[error] boom\n[log] hi');
		assert.deepStrictEqual([evidence.consoleErrors, again === evidence], [['[error] boom', '[warning] careful', '[pageerror] Uncaught'], true]);
		evidence = addClaudeVerifyConsole(EMPTY_CLAUDE_VERIFY_EVIDENCE, Array.from({ length: CLAUDE_VERIFY_MAX_CONSOLE + 5 }, (_, i) => `[error] e${i}`).join('\n'));
		assert.deepStrictEqual([evidence.consoleErrors.length, evidence.consoleErrors[0]], [CLAUDE_VERIFY_MAX_CONSOLE, '[error] e5']);
	});

	test('a recording needs three frames, and empty evidence is empty', () => {
		let evidence = EMPTY_CLAUDE_VERIFY_EVIDENCE;
		const counts: number[] = [];
		for (const name of ['a', 'b', 'c']) {
			evidence = addClaudeVerifyShot(evidence, image(name), 1);
			counts.push(claudeVerifyRecording(evidence).length);
		}
		assert.deepStrictEqual([counts, isClaudeVerifyEvidenceEmpty(EMPTY_CLAUDE_VERIFY_EVIDENCE), isClaudeVerifyEvidenceEmpty(evidence)], [[0, 0, 3], true, false]);
	});
});
